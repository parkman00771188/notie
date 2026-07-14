"""usage 라우터 — Gemini API 사용량 통계 (관리자 전용).

main.py에서 prefix="/api/usage"로 include된다.

- GET /summary?start=YYYY-MM-DD&end=YYYY-MM-DD&user_ids=1,2&organization=<소속|__none__>&role=<admin|user|other>&kind=<stt|summary|test>
  → 선택 기간의 사용량 통계. 기간 생략 시 이번 달(1일~오늘).
  {start, end, totals, previous, daily[], by_model[], by_kind[], by_user[], by_organization[]}
  previous는 같은 길이의 직전 기간 합계(증감 표시용) — 데이터가 없으면 요청 0건 totals.
- GET /pricing → {models: [...], asof, note} — 비용 추정에 사용한 단가표(USD/1M tokens).

소속(organization)은 users 테이블 기준. 탈퇴한 사용자의 기록은 user_name 스냅샷으로
표시되고 소속은 "미지정"으로 집계된다.
"""

from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query

from .. import db
from ..auth_utils import get_current_user, require_admin
from ..services import usage as usage_service

router = APIRouter()

_MAX_RANGE_DAYS = 366
_KINDS = ("stt", "summary", "test", "other")
_ROLES = ("admin", "user", "other")
_UNASSIGNED = "__none__"


def _parse_date(value: str | None, fallback: date) -> date:
    if not value:
        return fallback
    try:
        return datetime.strptime(value.strip(), "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="날짜는 YYYY-MM-DD 형식이어야 합니다")


def _parse_user_ids(value: str | None) -> list[int] | None:
    if not value or not value.strip():
        return None
    ids: list[int] = []
    for part in value.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            ids.append(int(part))
        except ValueError:
            raise HTTPException(status_code=400, detail="user_ids는 숫자 목록이어야 합니다")
    return ids or None


def _fetch_rows(
    conn,
    start: date,
    end: date,
    user_ids: list[int] | None,
    organization: str | None,
    role: str | None,
    kind: str | None,
) -> list[dict]:
    """필터 적용된 사용량 행 + 사용자 정보 조인."""
    where = ["date(au.created_at) BETWEEN ? AND ?"]
    params: list = [start.isoformat(), end.isoformat()]
    if user_ids:
        where.append(f"au.user_id IN ({','.join('?' * len(user_ids))})")
        params.extend(user_ids)
    if organization is not None:
        organization_expr = "COALESCE(au.user_organization, u.organization, '')"
        if organization == _UNASSIGNED:
            where.append(f"trim({organization_expr}) = ''")
        else:
            where.append(f"{organization_expr} = ?")
            params.append(organization)
    if role:
        where.append("COALESCE(NULLIF(au.user_role, ''), u.role, 'other') = ?")
        params.append(role)
    if kind:
        where.append("au.kind = ?")
        params.append(kind)

    rows = conn.execute(
        f"""
        SELECT
          au.id, au.user_id, au.meeting_id, au.kind, au.model,
          au.prompt_tokens, au.prompt_audio_tokens, au.output_tokens,
          au.thoughts_tokens, au.total_tokens, au.est_cost_usd,
          date(au.created_at) AS day,
          COALESCE(NULLIF(au.user_name, ''), u.name, '알 수 없음') AS user_display_name,
          COALESCE(NULLIF(au.user_role, ''), u.role, 'other') AS user_display_role,
          COALESCE(au.user_organization, u.organization, '') AS user_display_organization,
          COALESCE(au.user_department, u.department, '') AS user_display_department
        FROM api_usage au
        LEFT JOIN users u ON u.id = au.user_id
        WHERE {' AND '.join(where)}
        ORDER BY au.created_at ASC
        """,
        params,
    ).fetchall()
    return [dict(r) for r in rows]


def _totals(rows: list[dict]) -> dict:
    requests = len(rows)
    prompt = sum(r["prompt_tokens"] for r in rows)
    audio = sum(r["prompt_audio_tokens"] for r in rows)
    output = sum(r["output_tokens"] for r in rows)
    total = sum(r["total_tokens"] for r in rows)
    cost = sum(r["est_cost_usd"] for r in rows)
    return {
        "requests": requests,
        "prompt_tokens": prompt,
        "prompt_audio_tokens": audio,
        "output_tokens": output,
        "total_tokens": total,
        "cost_usd": round(cost, 4),
        "avg_cost_usd": round(cost / requests, 6) if requests else 0.0,
    }


def _group(rows: list[dict], key_fn) -> dict:
    grouped: dict = {}
    for r in rows:
        grouped.setdefault(key_fn(r), []).append(r)
    return grouped


@router.get("/summary")
def usage_summary(
    start: str | None = Query(default=None),
    end: str | None = Query(default=None),
    user_ids: str | None = Query(default=None),
    organization: str | None = Query(default=None),
    role: str | None = Query(default=None),
    kind: str | None = Query(default=None),
    user: dict = Depends(get_current_user),
) -> dict:
    require_admin(user)

    today = date.today()
    end_date = _parse_date(end, today)
    start_date = _parse_date(start, end_date.replace(day=1))
    if start_date > end_date:
        raise HTTPException(status_code=400, detail="시작일이 종료일보다 늦을 수 없습니다")
    if (end_date - start_date).days > _MAX_RANGE_DAYS:
        raise HTTPException(status_code=400, detail="조회 기간은 최대 1년까지입니다")
    if kind is not None:
        kind = kind.strip() or None
        if kind and kind not in _KINDS:
            raise HTTPException(status_code=400, detail="kind는 stt/summary/test/other 중 하나입니다")
    if role is not None:
        role = role.strip() or None
        if role and role not in _ROLES:
            raise HTTPException(status_code=400, detail="role은 admin/user/other 중 하나입니다")
    ids = _parse_user_ids(user_ids)
    org = organization.strip() if organization and organization.strip() else None

    period_days = (end_date - start_date).days + 1
    prev_end = start_date - timedelta(days=1)
    prev_start = prev_end - timedelta(days=period_days - 1)

    conn = db.get_conn()
    try:
        rows = _fetch_rows(conn, start_date, end_date, ids, org, role, kind)
        prev_rows = _fetch_rows(conn, prev_start, prev_end, ids, org, role, kind)
    finally:
        conn.close()

    # 일별 시계열 — 빈 날짜는 0으로 채움
    by_day = _group(rows, lambda r: r["day"])
    daily: list[dict] = []
    cursor = start_date
    while cursor <= end_date:
        day_key = cursor.isoformat()
        day_rows = by_day.get(day_key, [])
        daily.append(
            {
                "date": day_key,
                "requests": len(day_rows),
                "prompt_tokens": sum(r["prompt_tokens"] for r in day_rows),
                "output_tokens": sum(r["output_tokens"] for r in day_rows),
                "total_tokens": sum(r["total_tokens"] for r in day_rows),
                "cost_usd": round(sum(r["est_cost_usd"] for r in day_rows), 4),
            }
        )
        cursor += timedelta(days=1)

    def _stat(group_rows: list[dict]) -> dict:
        return {
            "requests": len(group_rows),
            "total_tokens": sum(r["total_tokens"] for r in group_rows),
            "cost_usd": round(sum(r["est_cost_usd"] for r in group_rows), 4),
        }

    by_model = [
        {"model": model or "(알 수 없음)", **_stat(g)}
        for model, g in _group(rows, lambda r: r["model"]).items()
    ]
    by_model.sort(key=lambda e: e["total_tokens"], reverse=True)

    by_kind = [
        {"kind": k, **_stat(g)} for k, g in _group(rows, lambda r: r["kind"]).items()
    ]
    by_kind.sort(key=lambda e: e["cost_usd"], reverse=True)

    by_role = [
        {"role": r, **_stat(g)}
        for r, g in _group(rows, lambda row: row["user_display_role"]).items()
    ]
    by_role.sort(key=lambda e: e["cost_usd"], reverse=True)

    by_user = []
    for (uid, name), g in _group(
        rows, lambda r: (r["user_id"], r["user_display_name"] or "알 수 없음")
    ).items():
        latest = g[-1]
        by_user.append(
            {
                "user_id": uid,
                "name": name,
                "role": latest["user_display_role"],
                "organization": latest["user_display_organization"] or None,
                "department": latest["user_display_department"] or None,
                **_stat(g),
            }
        )
    by_user.sort(key=lambda e: e["cost_usd"], reverse=True)

    by_org = [
        {"organization": o, **_stat(g)}
        for o, g in _group(
            rows,
            lambda r: (r["user_display_organization"] or "").strip() or "미지정",
        ).items()
    ]
    by_org.sort(key=lambda e: e["cost_usd"], reverse=True)

    return {
        "start": start_date.isoformat(),
        "end": end_date.isoformat(),
        "totals": _totals(rows),
        "previous": _totals(prev_rows),
        "daily": daily,
        "by_model": by_model,
        "by_kind": by_kind,
        "by_role": by_role,
        "by_user": by_user,
        "by_organization": by_org,
    }


@router.get("/pricing")
def usage_pricing(user: dict = Depends(get_current_user)) -> dict:
    require_admin(user)
    return {
        "models": usage_service.pricing_table(),
        "asof": usage_service.PRICING_ASOF,
        "note": (
            "Google Gemini API 공식 가격표(ai.google.dev/gemini-api/docs/pricing)의 유료 표준 단가 기준 "
            "추정치입니다. 실제 청구액은 Google 청구 내역을 확인해주세요. "
            "표에 없는 모델은 기본 단가(입력 $0.50 / 오디오 $1.00 / 출력 $3.00, 1M 토큰당)로 추정합니다."
        ),
    }
