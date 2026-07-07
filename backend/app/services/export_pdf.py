"""회의록 PDF 내보내기 — export_doc(docx)과 같은 [회의록] 양식 레이아웃.

fpdf2로 로컬에서 직접 생성한다(외부 프로그램 불필요). 한글은 Windows의
맑은 고딕(TTF)을 임베드하며, 폰트를 찾지 못하면 한국어 RuntimeError를 낸다.

docx와 동일한 표 구조를 재현한다:
  회의록                                         ← 큰 제목
  ┌─────────┬───────────────┬────────┬────────────────┐
  │ 회의일시 │ 2026년 4월 …  │ 회의명 │ <제목> (#태그)  │
  ├─────────┼───────────────┴────────┴────────────────┤
  │ 참석자   │ 이름(소속 · 직책) 콤마 목록               │
  └─────────┴──────────────────────────────────────────┘
  ┌─────────┬──────────────────────────────────────────┐
  │ 회의내용 │ 1. 내용 / 핵심 내용 / 결정 사항…            │  ← 좌측 라벨 셀이
  └─────────┴──────────────────────────────────────────┘     페이지를 넘어도 이어짐
  ┌─────────┬──────────────────────────────────────────┐
  │ 특이사항 │ (빈칸 — 출력 후 직접 작성)                │
  └─────────┴──────────────────────────────────────────┘
"""

from pathlib import Path

from .export_doc import _fmt_datetime, format_participants_grouped

FONT = "Malgun"
LABEL_BG = (231, 230, 230)
LABEL_W = 24  # 좌측 라벨 셀 폭 (mm)
PAD = 2.5     # 내용 셀 안쪽 여백 (mm)

# 맑은 고딕 우선, 없으면 OS별 한글 폰트 폴백
_FONT_CANDIDATES = [
    (r"C:\Windows\Fonts\malgun.ttf", r"C:\Windows\Fonts\malgunbd.ttf"),
    (r"C:\Windows\Fonts\gulim.ttc", None),
    ("/System/Library/Fonts/Supplemental/Arial Unicode.ttf", None),
    ("/Library/Fonts/Arial Unicode.ttf", None),
    ("/System/Library/Fonts/AppleSDGothicNeo.ttc", None),
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", None),
    ("/usr/share/fonts/opentype/noto/NotoSansCJKkr-Regular.otf", None),
    ("/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc", None),
    ("/usr/share/fonts/truetype/nanum/NanumGothic.ttf", "/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf"),
]


def _register_fonts(pdf) -> None:
    for regular, bold in _FONT_CANDIDATES:
        if Path(regular).is_file():
            pdf.add_font(FONT, "", regular)
            pdf.add_font(FONT, "B", bold if bold and Path(bold).is_file() else regular)
            return
    raise RuntimeError(
        "PDF 생성에 사용할 한글 폰트를 찾지 못했습니다. Word(.docx)로 내보내주세요."
    )


def _heading(pdf, text: str) -> None:
    pdf.ln(1.5)
    pdf.set_font(FONT, "B", 10.5)
    pdf.multi_cell(0, 6.5, text, new_x="LMARGIN", new_y="NEXT")
    pdf.ln(0.5)


def _line(pdf, text: str, indent: float = 0.0, size: float = 10) -> None:
    pdf.set_font(FONT, "", size)
    if indent:
        pdf.set_x(pdf.l_margin + indent)
    # markdown=True → **굵게** 인라인 지원
    pdf.multi_cell(0, 6, text, new_x="LMARGIN", new_y="NEXT", markdown=True)


def _markdown(pdf, md: str) -> None:
    """discussion 마크다운(### 소제목 / - 불릿 / 문단) 렌더."""
    for raw in md.splitlines():
        text = raw.strip()
        if not text:
            continue
        if text.startswith("### "):
            _heading(pdf, text[4:])
        elif text.startswith("## "):
            _heading(pdf, text[3:])
        elif text.startswith("- [x] ") or text.startswith("- [X] "):
            _line(pdf, f"▣ {text[6:]}", indent=3)
        elif text.startswith("- [ ] "):
            _line(pdf, f"□ {text[6:]}", indent=3)
        elif text.startswith("- "):
            _line(pdf, f"• {text[2:]}", indent=3)
        else:
            _line(pdf, text)


def _labeled_box(pdf, label: str, render, min_height: float = 0.0) -> None:
    """docx의 [라벨 셀 | 내용 셀] 표 한 행을 재현한다.

    내용이 여러 페이지로 넘어가면 각 페이지 구간마다 라벨 셀(회색)과
    내용 셀 테두리를 이어서 그린다. 라벨 텍스트는 첫 구간에만 표시.
    """
    left = pdf.l_margin
    right_edge = pdf.w - pdf.r_margin
    page_bottom = pdf.h - pdf.b_margin
    orig_r_margin = pdf.r_margin

    # 시작 위치가 페이지 바닥에 너무 가까우면 다음 페이지에서 시작
    if pdf.get_y() + 14 > page_bottom:
        pdf.add_page()

    start_page = pdf.page
    start_y = pdf.get_y()

    # 내용 렌더 — 좌측 라벨 폭 + 안쪽 여백만큼 마진을 옮겨서 흐르게 한다
    pdf.set_left_margin(left + LABEL_W + PAD)
    pdf.set_right_margin(orig_r_margin + PAD)
    pdf.set_y(start_y + PAD)
    pdf.set_x(left + LABEL_W + PAD)
    render()
    end_y = pdf.get_y() + PAD
    if pdf.page == start_page:
        end_y = max(end_y, start_y + max(min_height, 12.0))
    end_y = min(end_y, page_bottom)
    end_page = pdf.page
    pdf.set_left_margin(left)
    pdf.set_right_margin(orig_r_margin)

    # 페이지 구간별 라벨 셀 + 내용 테두리
    for pg in range(start_page, end_page + 1):
        pdf.page = pg
        y0 = start_y if pg == start_page else pdf.t_margin
        y1 = end_y if pg == end_page else page_bottom
        if y1 - y0 <= 0.5:
            continue
        # 페이지를 옮겨 그리면 fpdf2의 색 캐시와 실제 페이지 스트림 상태가 어긋나
        # 회색 채움 명령이 생략될 수 있다(→ 검정 박스). 다른 색을 한 번 거쳐
        # 캐시를 깨서 이 페이지에 채움색이 반드시 기록되게 한다.
        pdf.set_fill_color(255, 255, 255)
        pdf.set_fill_color(*LABEL_BG)
        pdf.rect(left, y0, LABEL_W, y1 - y0, style="DF")
        pdf.rect(left + LABEL_W, y0, right_edge - left - LABEL_W, y1 - y0, style="D")
        if pg == start_page:
            # 글꼴도 캐시가 있어 페이지 이동 후에는 선택 명령이 생략될 수 있다
            # (→ 다른 글꼴 서브셋으로 그려져 라벨 글자가 깨짐). 캐시를 깨고 다시 지정.
            pdf.set_font(FONT, "", 8)
            pdf.set_font(FONT, "B", 10.5)
            pdf.set_xy(left, y0 + (y1 - y0) / 2 - 3)
            pdf.cell(LABEL_W, 6, label, align="C")

    pdf.page = end_page
    pdf.set_y(end_y)
    pdf.set_x(left)


def build_minutes_pdf(
    meeting: dict,
    participants: list[dict],
    bookmarks: list[dict],
    summary: dict | None,
) -> bytes:
    from fpdf import FPDF
    from fpdf.fonts import FontFace

    pdf = FPDF(format="A4")
    pdf.set_margins(18, 16, 18)
    pdf.set_auto_page_break(True, margin=16)
    _register_fonts(pdf)
    pdf.add_page()

    # 제목
    pdf.set_font(FONT, "B", 20)
    pdf.cell(0, 12, "회의록", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(3)

    # ---- 표 1: 회의 분류(태그)/일시 + 회의명 + 참석자 (docx와 동일) ----
    tag = str(meeting.get("tag") or "").strip()

    label_style = FontFace(emphasis="BOLD", fill_color=LABEL_BG)
    pdf.set_font(FONT, "", 10)
    with pdf.table(
        col_widths=(LABEL_W, 58, 18, 74),
        text_align="LEFT",
        line_height=7,
        padding=1.5,
    ) as table:
        row = table.row()
        row.cell("회의 분류", style=label_style, align="CENTER")
        row.cell(tag or "-")
        row.cell("일시", style=label_style, align="CENTER")
        row.cell(_fmt_datetime(meeting.get("started_at")))
        row = table.row()
        row.cell("회의명", style=label_style, align="CENTER")
        row.cell(str(meeting.get("title") or ""), colspan=3)
        row = table.row()
        row.cell("참석자", style=label_style, align="CENTER")
        row.cell(format_participants_grouped(participants) or "-", colspan=3)

    pdf.ln(4)

    # ---- 표 2: 회의내용 (좌측 라벨 셀 + 내용, 페이지 넘어가도 이어짐) ----
    summary = summary or {}

    def render_content() -> None:
        section_no = 1

        discussion = str(summary.get("discussion") or "").strip()
        if discussion:
            _heading(pdf, f"{section_no}. 내용")
            section_no += 1
            _markdown(pdf, discussion)

        key_points = summary.get("key_points") or []
        if key_points:
            _heading(pdf, f"{section_no}. 핵심 내용")
            section_no += 1
            for item in key_points:
                _line(pdf, f"• {item}", indent=3)

        _heading(pdf, f"{section_no}. 결정 사항")
        section_no += 1
        decisions = summary.get("decisions") or []
        if decisions:
            for item in decisions:
                _line(pdf, f"▣ {item}", indent=3)
        else:
            _line(pdf, "명확히 확정된 결정사항은 없음", indent=3)

        followups = summary.get("followups") or []
        if followups:
            _heading(pdf, f"{section_no}. 추가 확인 필요 사항")
            section_no += 1
            for item in followups:
                _line(pdf, f"□ {item}", indent=3)

        if not discussion and not key_points and not decisions:
            _line(pdf, "요약이 아직 생성되지 않았습니다.")

    _labeled_box(pdf, "회의내용", render_content)

    pdf.ln(4)

    # ---- 표 3: 특이사항 (빈칸 — 출력 후 직접 작성) ----
    _labeled_box(pdf, "특이사항", lambda: None, min_height=24)

    return bytes(pdf.output())
