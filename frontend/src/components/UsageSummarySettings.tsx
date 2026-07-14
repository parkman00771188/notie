import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import type {
  UsageDaily,
  UsageKind,
  UsageModelStat,
  UsagePricingRow,
  UsageRole,
  UsageSummary,
} from '../api'
import type { AdminUser } from '../types'
import Modal from './Modal'
import './UsageSummarySettings.css'

/* ==========================================================================
   사용량 요약 (관리자) — Gemini API 토큰 사용량/예상 비용 대시보드
   차트는 외부 라이브러리 없이 인라인 SVG로 그린다.
   ========================================================================== */

/** 막대차트 색 — 입력(진한 파랑) / 출력(밝은 파랑). CVD 검증 완료 팔레트 */
const BAR_INPUT_COLOR = '#2563eb'
const BAR_OUTPUT_COLOR = '#60a5fa'

/** 도넛 카테고리 색 — 고정 순서로 모델에 배정, 6번째 이후는 '기타'(회색) */
const DONUT_COLORS = ['#2563eb', '#16a34a', '#7048e8', '#e8590c', '#0ca678']
const DONUT_OTHER_COLOR = '#8b95a1'
const DONUT_MAX_SLICES = 5

const KIND_LABELS: Record<string, string> = {
  stt: '음성 변환(STT)',
  summary: 'AI 요약',
  test: '연결 테스트',
  other: '기타',
}

const ROLE_LABELS: Record<string, string> = {
  admin: '관리자',
  user: '사용자',
  other: '기타',
}

type PeriodPreset = 'this-month' | 'last-month' | '7d' | '30d' | 'custom'

const PERIOD_PRESETS: { id: PeriodPreset; label: string }[] = [
  { id: 'this-month', label: '이번 달' },
  { id: 'last-month', label: '지난 달' },
  { id: '7d', label: '최근 7일' },
  { id: '30d', label: '최근 30일' },
  { id: 'custom', label: '직접 선택' },
]

/* ---------- 포맷 헬퍼 ---------- */

function isoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function fmtInt(n: number): string {
  return n.toLocaleString('ko-KR')
}

/** 토큰 축약 표기 — 4,582,910 → 4.58M, 582,000 → 582K */
function fmtTokensShort(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000) return `${Math.round(n / 1_000)}K`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function fmtUsd(n: number): string {
  if (n === 0) return '$0'
  if (n < 0.0001) return '<$0.0001'
  if (n < 0.1) return `$${n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function shortDateLabel(dateStr: string): string {
  const [, m, d] = dateStr.split('-')
  return `${Number(m)}/${Number(d)}`
}

/** 축 눈금용 예쁜 최댓값 — step ∈ {1, 2, 2.5, 5}×10^k, 4칸 */
function niceAxisMax(rawMax: number): number {
  if (rawMax <= 0) return 4
  const rough = rawMax / 4
  const pow = Math.pow(10, Math.floor(Math.log10(rough)))
  const candidates = [1, 2, 2.5, 5, 10].map((c) => c * pow)
  const step = candidates.find((c) => c >= rough) ?? candidates[candidates.length - 1]
  return step * 4
}

/* ---------- 증감 칩 ---------- */

function DeltaChip({ current, previous }: { current: number; previous: number }) {
  if (!previous || previous <= 0) return null
  const pct = ((current - previous) / previous) * 100
  if (!Number.isFinite(pct)) return null
  const up = pct >= 0
  const text = `${up ? '+' : ''}${Math.abs(pct) >= 100 ? pct.toFixed(0) : pct.toFixed(1)}%`
  return (
    <span className={`us-delta ${up ? 'up' : 'down'}`} title="직전 같은 길이 기간 대비">
      <span aria-hidden="true">{up ? '↑' : '↓'}</span> {text}
    </span>
  )
}

/* ---------- 일별 토큰 스택 막대차트 ---------- */

interface BarTip {
  index: number
  x: number
  y: number
}

function DailyTokensChart({ daily }: { daily: UsageDaily[] }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [tip, setTip] = useState<BarTip | null>(null)

  const W = 660
  const H = 250
  const PAD_LEFT = 46
  const PAD_RIGHT = 10
  const PAD_TOP = 12
  const PAD_BOTTOM = 26
  const innerW = W - PAD_LEFT - PAD_RIGHT
  const innerH = H - PAD_TOP - PAD_BOTTOM

  const maxDaily = Math.max(0, ...daily.map((d) => d.prompt_tokens + d.output_tokens))
  const yMax = niceAxisMax(maxDaily)
  const n = daily.length
  const slot = n > 0 ? innerW / n : innerW
  const barW = Math.max(3, Math.min(26, slot * 0.62))

  // x축 라벨 — 겹치지 않게 최대 7개만 표시
  const labelStep = Math.max(1, Math.ceil(n / 7))

  const hasData = maxDaily > 0

  const yTicks = [0, 1, 2, 3, 4].map((i) => (yMax / 4) * i)

  const handleMove = (index: number) => (e: React.MouseEvent) => {
    const rect = wrapRef.current?.getBoundingClientRect()
    if (!rect) return
    setTip({
      index,
      x: Math.min(Math.max(e.clientX - rect.left, 70), rect.width - 70),
      y: Math.max(e.clientY - rect.top, 60),
    })
  }

  const tipDay = tip ? daily[tip.index] : null

  return (
    <div className="us-chart-wrap" ref={wrapRef}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="us-bar-svg"
        role="img"
        aria-label="일별 입력/출력 토큰 사용량 막대차트"
      >
        {/* 그리드 + y축 라벨 */}
        {yTicks.map((v) => {
          const y = PAD_TOP + innerH - (v / yMax) * innerH
          return (
            <g key={v}>
              <line
                x1={PAD_LEFT}
                x2={W - PAD_RIGHT}
                y1={y}
                y2={y}
                stroke="var(--border)"
                strokeWidth={v === 0 ? 1.4 : 1}
                strokeDasharray={v === 0 ? undefined : '3 4'}
              />
              <text x={PAD_LEFT - 8} y={y + 4} textAnchor="end" className="us-axis-text">
                {fmtTokensShort(v)}
              </text>
            </g>
          )
        })}

        {/* 막대 */}
        {daily.map((d, i) => {
          const x = PAD_LEFT + slot * i + (slot - barW) / 2
          const inputH = yMax > 0 ? (d.prompt_tokens / yMax) * innerH : 0
          const outputH = yMax > 0 ? (d.output_tokens / yMax) * innerH : 0
          const baseY = PAD_TOP + innerH
          const inputY = baseY - inputH
          // 세그먼트 사이 2px 흰 간격
          const gap = inputH > 0 && outputH > 0 ? 2 : 0
          const outputY = inputY - gap - outputH
          const dim = tip !== null && tip.index !== i
          return (
            <g key={d.date} opacity={dim ? 0.45 : 1}>
              {inputH > 0.5 && (
                <rect
                  x={x}
                  y={inputY}
                  width={barW}
                  height={inputH}
                  rx={2}
                  fill={BAR_INPUT_COLOR}
                />
              )}
              {outputH > 0.5 && (
                <rect
                  x={x}
                  y={outputY}
                  width={barW}
                  height={outputH}
                  rx={2}
                  fill={BAR_OUTPUT_COLOR}
                />
              )}
              {/* 호버 히트 영역 (막대보다 큼) */}
              <rect
                x={PAD_LEFT + slot * i}
                y={PAD_TOP}
                width={slot}
                height={innerH}
                fill="transparent"
                onMouseMove={handleMove(i)}
                onMouseLeave={() => setTip(null)}
              />
            </g>
          )
        })}

        {/* x축 라벨 */}
        {daily.map((d, i) =>
          i % labelStep === 0 || i === n - 1 ? (
            <text
              key={`label-${d.date}`}
              x={PAD_LEFT + slot * i + slot / 2}
              y={H - 8}
              textAnchor="middle"
              className="us-axis-text"
            >
              {shortDateLabel(d.date)}
            </text>
          ) : null,
        )}
      </svg>

      {!hasData && <div className="us-chart-empty">선택한 기간에 기록된 사용량이 없어요</div>}

      {tipDay && tip && (
        <div className="us-tooltip" style={{ left: tip.x, top: tip.y }}>
          <div className="us-tooltip-title">
            {tipDay.date} · {fmtInt(tipDay.requests)}건
          </div>
          <div className="us-tooltip-row">
            <span className="us-dot" style={{ background: BAR_INPUT_COLOR }} />
            입력 {fmtInt(tipDay.prompt_tokens)} 토큰
          </div>
          <div className="us-tooltip-row">
            <span className="us-dot" style={{ background: BAR_OUTPUT_COLOR }} />
            출력 {fmtInt(tipDay.output_tokens)} 토큰
          </div>
          <div className="us-tooltip-row muted-row">예상 비용 {fmtUsd(tipDay.cost_usd)}</div>
        </div>
      )}
    </div>
  )
}

/* ---------- 모델별 도넛차트 ---------- */

interface DonutSlice {
  label: string
  tokens: number
  cost: number
  requests: number
  share: number
  color: string
}

function donutSegmentPath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  startAngle: number,
  endAngle: number,
): string {
  const toXY = (r: number, a: number) => [cx + r * Math.cos(a), cy + r * Math.sin(a)]
  const [x1, y1] = toXY(rOuter, startAngle)
  const [x2, y2] = toXY(rOuter, endAngle)
  const [x3, y3] = toXY(rInner, endAngle)
  const [x4, y4] = toXY(rInner, startAngle)
  const large = endAngle - startAngle > Math.PI ? 1 : 0
  return [
    `M ${x1} ${y1}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${x2} ${y2}`,
    `L ${x3} ${y3}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${x4} ${y4}`,
    'Z',
  ].join(' ')
}

function buildSlices(byModel: UsageModelStat[]): DonutSlice[] {
  const total = byModel.reduce((sum, m) => sum + m.total_tokens, 0)
  if (total <= 0) return []
  const sorted = [...byModel].sort((a, b) => b.total_tokens - a.total_tokens)
  const top = sorted.slice(0, DONUT_MAX_SLICES)
  const rest = sorted.slice(DONUT_MAX_SLICES)

  // 색은 순위가 아니라 모델명(가나다순)에 고정 배정 — 필터가 바뀌어도 색 유지
  const alphabetical = [...top].sort((a, b) => a.model.localeCompare(b.model))
  const colorOf = new Map(alphabetical.map((m, i) => [m.model, DONUT_COLORS[i % DONUT_COLORS.length]]))

  const slices: DonutSlice[] = top.map((m) => ({
    label: m.model,
    tokens: m.total_tokens,
    cost: m.cost_usd,
    requests: m.requests,
    share: m.total_tokens / total,
    color: colorOf.get(m.model) ?? DONUT_OTHER_COLOR,
  }))
  if (rest.length > 0) {
    const tokens = rest.reduce((s, m) => s + m.total_tokens, 0)
    slices.push({
      label: `기타 ${rest.length}개 모델`,
      tokens,
      cost: rest.reduce((s, m) => s + m.cost_usd, 0),
      requests: rest.reduce((s, m) => s + m.requests, 0),
      share: tokens / total,
      color: DONUT_OTHER_COLOR,
    })
  }
  return slices
}

function ModelDonutChart({
  byModel,
  totalTokens,
}: {
  byModel: UsageModelStat[]
  totalTokens: number
}) {
  const [hover, setHover] = useState<number | null>(null)
  const slices = useMemo(() => buildSlices(byModel), [byModel])

  const SIZE = 190
  const cx = SIZE / 2
  const cy = SIZE / 2
  const rOuter = 88
  const rInner = 58

  if (slices.length === 0) {
    return <div className="us-donut-empty">선택한 기간에 기록된 사용량이 없어요</div>
  }

  let angle = -Math.PI / 2
  const segments = slices.map((s, i) => {
    const sweep = s.share * Math.PI * 2
    const seg = { slice: s, start: angle, end: angle + sweep, index: i }
    angle += sweep
    return seg
  })

  const active = hover !== null ? slices[hover] : null

  return (
    <div className="us-donut-layout">
      <div className="us-donut-figure">
        <svg
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className="us-donut-svg"
          role="img"
          aria-label="모델별 토큰 사용 분포 도넛차트"
        >
          {segments.map(({ slice, start, end, index }) =>
            slice.share >= 0.999 ? (
              <circle
                key={slice.label}
                cx={cx}
                cy={cy}
                r={(rOuter + rInner) / 2}
                fill="none"
                stroke={slice.color}
                strokeWidth={rOuter - rInner}
                onMouseEnter={() => setHover(index)}
                onMouseLeave={() => setHover(null)}
              />
            ) : (
              <path
                key={slice.label}
                d={donutSegmentPath(cx, cy, rOuter, rInner, start, end)}
                fill={slice.color}
                stroke="var(--surface)"
                strokeWidth={2}
                opacity={hover !== null && hover !== index ? 0.4 : 1}
                onMouseEnter={() => setHover(index)}
                onMouseLeave={() => setHover(null)}
              />
            ),
          )}
        </svg>
        <div className="us-donut-center" aria-hidden="true">
          {active ? (
            <>
              <span className="us-donut-center-label">{Math.round(active.share * 100)}%</span>
              <span className="us-donut-center-value">{fmtTokensShort(active.tokens)}</span>
            </>
          ) : (
            <>
              <span className="us-donut-center-label">총 토큰</span>
              <span className="us-donut-center-value">{fmtTokensShort(totalTokens)}</span>
            </>
          )}
        </div>
      </div>

      <ul className="us-donut-legend">
        {slices.map((s, i) => (
          <li
            key={s.label}
            className={`us-legend-item${hover === i ? ' active' : ''}`}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            title={`${s.label} — ${fmtInt(s.tokens)} 토큰 · ${fmtUsd(s.cost)}`}
          >
            <span className="us-dot" style={{ background: s.color }} />
            <span className="us-legend-name">{s.label}</span>
            <span className="us-legend-share">{Math.round(s.share * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ---------- 메인 컴포넌트 ---------- */

export function UsageSummarySettings() {
  const today = useMemo(() => new Date(), [])

  const [preset, setPreset] = useState<PeriodPreset>('this-month')
  const [customStart, setCustomStart] = useState(() =>
    isoDate(new Date(today.getFullYear(), today.getMonth(), 1)),
  )
  const [customEnd, setCustomEnd] = useState(() => isoDate(today))
  const [kindFilter, setKindFilter] = useState<'' | UsageKind>('')
  const [roleFilter, setRoleFilter] = useState<'' | UsageRole>('')
  const [orgFilter, setOrgFilter] = useState('')
  const [selectedUserIds, setSelectedUserIds] = useState<number[]>([])

  const [users, setUsers] = useState<AdminUser[]>([])
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const userMenuRef = useRef<HTMLDivElement>(null)

  const [data, setData] = useState<UsageSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [pricing, setPricing] = useState<{ models: UsagePricingRow[]; asof: string; note: string } | null>(null)
  const [pricingOpen, setPricingOpen] = useState(false)

  const range = useMemo(() => {
    const base = new Date(today.getFullYear(), today.getMonth(), today.getDate())
    switch (preset) {
      case 'this-month':
        return {
          start: isoDate(new Date(base.getFullYear(), base.getMonth(), 1)),
          end: isoDate(base),
          label: '이번 달',
        }
      case 'last-month': {
        const first = new Date(base.getFullYear(), base.getMonth() - 1, 1)
        const last = new Date(base.getFullYear(), base.getMonth(), 0)
        return { start: isoDate(first), end: isoDate(last), label: '지난 달' }
      }
      case '7d': {
        const start = new Date(base)
        start.setDate(start.getDate() - 6)
        return { start: isoDate(start), end: isoDate(base), label: '최근 7일' }
      }
      case '30d': {
        const start = new Date(base)
        start.setDate(start.getDate() - 29)
        return { start: isoDate(start), end: isoDate(base), label: '최근 30일' }
      }
      case 'custom':
        return {
          start: customStart <= customEnd ? customStart : customEnd,
          end: customStart <= customEnd ? customEnd : customStart,
          label: '선택 기간',
        }
    }
  }, [preset, customStart, customEnd, today])

  // 사용자 목록 (필터 선택용) — 실패해도 대시보드는 동작
  useEffect(() => {
    api
      .listAdminUsers()
      .then(setUsers)
      .catch(() => setUsers([]))
  }, [])

  // 단가표 (하단 안내용)
  useEffect(() => {
    api
      .getUsagePricing()
      .then(setPricing)
      .catch(() => setPricing(null))
  }, [])

  // 통계 로드
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    api
      .getUsageSummary({
        start: range.start,
        end: range.end,
        user_ids: selectedUserIds.length ? selectedUserIds : undefined,
        organization: orgFilter || undefined,
        role: roleFilter || undefined,
        kind: kindFilter || undefined,
      })
      .then((res) => {
        if (!cancelled) setData(res)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : '사용량을 불러오지 못했어요')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [range.start, range.end, selectedUserIds, orgFilter, roleFilter, kindFilter])

  // 사용자 선택 팝오버 외부 클릭 닫기
  useEffect(() => {
    if (!userMenuOpen) return
    const onDown = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [userMenuOpen])

  const organizations = useMemo(() => {
    const names = new Set<string>()
    users.forEach((u) => {
      const org = (u.organization ?? '').trim()
      if (org) names.add(org)
    })
    return [...names].sort((a, b) => a.localeCompare(b, 'ko'))
  }, [users])

  const toggleUser = (id: number) => {
    setSelectedUserIds((prev) =>
      prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id],
    )
  }

  const totals = data?.totals
  const previous = data?.previous

  const userFilterLabel =
    selectedUserIds.length === 0
      ? '사용자 전체'
      : selectedUserIds.length === 1
        ? (users.find((u) => u.id === selectedUserIds[0])?.name ?? '사용자 1명')
        : `사용자 ${selectedUserIds.length}명`

  return (
    <section className="card settings-card us-card">
      <div className="settings-card-head">
        <h2 className="settings-card-title">
          <span className="us-title-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M5 20V13" />
              <path d="M12 20V4" />
              <path d="M19 20v-9" />
            </svg>
          </span>
          사용량 요약
        </h2>
        <p className="settings-card-desc">
          Gemini API 호출(음성 변환·요약)의 토큰 사용량과 예상 비용을 집계합니다. 비용은 공식
          가격표 기준 추정치예요.
        </p>
      </div>

      {/* ---------- 필터 ---------- */}
      <div className="us-filters">
        <div className="us-period-presets" role="group" aria-label="조회 기간">
          {PERIOD_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`us-preset-btn${preset === p.id ? ' active' : ''}`}
              onClick={() => setPreset(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>

        {preset === 'custom' && (
          <div className="us-custom-range">
            <input
              type="date"
              className="input us-date-input"
              value={customStart}
              max={customEnd}
              onChange={(e) => setCustomStart(e.target.value)}
              aria-label="시작일"
            />
            <span className="us-range-sep">~</span>
            <input
              type="date"
              className="input us-date-input"
              value={customEnd}
              min={customStart}
              onChange={(e) => setCustomEnd(e.target.value)}
              aria-label="종료일"
            />
          </div>
        )}

        <div className="us-filter-row">
          <div className="us-user-filter" ref={userMenuRef}>
            <button
              type="button"
              className={`us-filter-trigger${selectedUserIds.length ? ' filtered' : ''}`}
              aria-haspopup="listbox"
              aria-expanded={userMenuOpen}
              onClick={() => setUserMenuOpen((open) => !open)}
            >
              👤 {userFilterLabel} <span aria-hidden="true">▾</span>
            </button>
            {userMenuOpen && (
              <div className="us-user-pop" role="listbox" aria-label="사용자 선택">
                <div className="us-user-pop-head">
                  <span>집계할 사용자 선택</span>
                  {selectedUserIds.length > 0 && (
                    <button type="button" className="us-clear-btn" onClick={() => setSelectedUserIds([])}>
                      전체 해제
                    </button>
                  )}
                </div>
                <div className="us-user-pop-list">
                  {users.length === 0 && <div className="us-user-pop-empty">사용자 목록을 불러오지 못했어요</div>}
                  {users.map((u) => (
                    <label key={u.id} className="us-user-option">
                      <input
                        type="checkbox"
                        checked={selectedUserIds.includes(u.id)}
                        onChange={() => toggleUser(u.id)}
                      />
                      <span className="us-user-option-name">{u.name}</span>
                      <span className="us-user-option-meta">
                        {(u.organization ?? '').trim() || '소속 미지정'}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>

          <select
            className="input us-select"
            value={orgFilter}
            onChange={(e) => setOrgFilter(e.target.value)}
            aria-label="소속 필터"
          >
            <option value="">소속 전체</option>
            {organizations.map((org) => (
              <option key={org} value={org}>
                {org}
              </option>
            ))}
            <option value="__none__">소속 미지정</option>
          </select>

          <select
            className="input us-select"
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value as '' | UsageRole)}
            aria-label="계정 역할 필터"
          >
            <option value="">역할 전체</option>
            <option value="admin">관리자</option>
            <option value="user">사용자</option>
            <option value="other">기타</option>
          </select>

          <select
            className="input us-select"
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as '' | UsageKind)}
            aria-label="사용 유형 필터"
          >
            <option value="">유형 전체</option>
            <option value="stt">음성 변환(STT)</option>
            <option value="summary">AI 요약</option>
            <option value="test">연결 테스트</option>
            <option value="other">기타</option>
          </select>
        </div>
      </div>

      {error && <div className="sp-error">{error}</div>}

      {loading && !data ? (
        <div className="sp-loading">
          <span className="spinner" />
        </div>
      ) : data && totals ? (
        <div className={`us-body${loading ? ' us-refreshing' : ''}`}>
          {/* ---------- 히어로 카드 ---------- */}
          <div className="us-hero">
            <div className="us-hero-copy">
              <span className="us-hero-badge">{range.label} 사용 요약</span>
              <p className="us-hero-lead">
                {range.label} 총 사용 비용은
              </p>
              <p className="us-hero-cost">
                {fmtUsd(totals.cost_usd)} <span className="us-hero-unit">USD 입니다.</span>
              </p>
              <p className="us-hero-sub">
                총 <strong>{fmtInt(totals.requests)}건</strong>의 요청으로{' '}
                <strong>{fmtInt(totals.total_tokens)}</strong> 토큰을 사용했어요.
              </p>
            </div>
            <div className="us-hero-art" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z" />
                <path d="M14 2v5h5" />
                <path d="M8.5 13.5h3" />
                <path d="M8.5 10.5h2" />
                <circle cx="14.5" cy="15.5" r="2.6" />
                <path d="M14.5 12.9v2.6l1.8 1" />
              </svg>
            </div>
          </div>

          {/* ---------- 통계 타일 ---------- */}
          <div className="us-tiles">
            <div className="us-tile">
              <span className="us-tile-label">총 요청 수</span>
              <span className="us-tile-value">
                {fmtInt(totals.requests)} <small>건</small>
              </span>
              <DeltaChip current={totals.requests} previous={previous?.requests ?? 0} />
            </div>
            <div className="us-tile">
              <span className="us-tile-label">총 토큰 사용량</span>
              <span className="us-tile-value">{fmtInt(totals.total_tokens)}</span>
              <DeltaChip current={totals.total_tokens} previous={previous?.total_tokens ?? 0} />
            </div>
            <div className="us-tile">
              <span className="us-tile-label">예상 비용 (USD)</span>
              <span className="us-tile-value">{fmtUsd(totals.cost_usd)}</span>
              <DeltaChip current={totals.cost_usd} previous={previous?.cost_usd ?? 0} />
            </div>
            <button
              type="button"
              className="us-tile us-tile-clickable"
              onClick={() => setPricingOpen(true)}
              title="모델별 요금표 보기"
            >
              <span className="us-tile-label accent">
                평균 요청당 비용
                <span className="us-tile-info" aria-hidden="true">
                  ⓘ
                </span>
              </span>
              <span className="us-tile-value">{fmtUsd(totals.avg_cost_usd)}</span>
              <DeltaChip current={totals.avg_cost_usd} previous={previous?.avg_cost_usd ?? 0} />
              <span className="us-tile-hint">모델별 요금 보기</span>
            </button>
          </div>

          {/* ---------- 차트 ---------- */}
          <div className="us-charts">
            <div className="us-panel us-panel-bars">
              <div className="us-panel-head">
                <h3 className="us-panel-title">일별 토큰 사용량</h3>
                <div className="us-legend-inline" aria-hidden="true">
                  <span className="us-legend-chip">
                    <span className="us-dot" style={{ background: BAR_INPUT_COLOR }} /> 입력 토큰
                  </span>
                  <span className="us-legend-chip">
                    <span className="us-dot" style={{ background: BAR_OUTPUT_COLOR }} /> 출력 토큰
                  </span>
                </div>
              </div>
              <DailyTokensChart daily={data.daily} />
            </div>

            <div className="us-panel us-panel-donut">
              <div className="us-panel-head">
                <h3 className="us-panel-title">모델별 사용 분포</h3>
              </div>
              <ModelDonutChart byModel={data.by_model} totalTokens={totals.total_tokens} />
            </div>
          </div>

          {/* ---------- 역할별/유형별 집계 ---------- */}
          <div className="us-breakdowns">
            <div className="us-panel">
              <div className="us-panel-head">
                <h3 className="us-panel-title">역할별 사용량</h3>
              </div>
              {data.by_role.length === 0 ? (
                <div className="us-table-empty">기록이 없어요</div>
              ) : (
                <ul className="us-kind-list">
                  {data.by_role.map((row) => (
                    <li key={row.role} className="us-kind-row">
                      <span className={`us-role-badge role-${row.role}`}>
                        {ROLE_LABELS[row.role] ?? row.role}
                      </span>
                      <span className="us-kind-meta">
                        {fmtInt(row.requests)}건 · {fmtTokensShort(row.total_tokens)} 토큰
                      </span>
                      <span className="us-kind-cost">{fmtUsd(row.cost_usd)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="us-panel">
              <div className="us-panel-head">
                <h3 className="us-panel-title">유형별 사용량</h3>
              </div>
              {data.by_kind.length === 0 ? (
                <div className="us-table-empty">기록이 없어요</div>
              ) : (
                <ul className="us-kind-list">
                  {data.by_kind.map((row) => (
                    <li key={row.kind} className="us-kind-row">
                      <span className="us-kind-name">{KIND_LABELS[row.kind] ?? row.kind}</span>
                      <span className="us-kind-meta">
                        {fmtInt(row.requests)}건 · {fmtTokensShort(row.total_tokens)} 토큰
                      </span>
                      <span className="us-kind-cost">{fmtUsd(row.cost_usd)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

          </div>

          {/* ---------- 사용자별/소속별 집계 ---------- */}
          <div className="us-breakdowns us-detail-tables">
            <div className="us-panel">
              <div className="us-panel-head">
                <h3 className="us-panel-title">사용자별 사용량</h3>
                <span className="us-panel-meta">{data.by_user.length}명</span>
              </div>
              {data.by_user.length === 0 ? (
                <div className="us-table-empty">기록이 없어요</div>
              ) : (
                <div className="us-table-wrap">
                  <table className="us-table">
                    <thead>
                      <tr>
                        <th>사용자</th>
                        <th>소속/부서</th>
                        <th className="num">요청</th>
                        <th className="num">토큰</th>
                        <th className="num">예상 비용</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.by_user.map((row) => (
                        <tr key={`${row.user_id ?? 'deleted'}-${row.name}`}>
                          <td>
                            <span className="us-cell-strong">{row.name}</span>{' '}
                            <span className={`us-role-badge role-${row.role}`}>
                              {ROLE_LABELS[row.role] ?? row.role}
                            </span>
                          </td>
                          <td>{[row.organization, row.department].filter(Boolean).join(' · ') || '미지정'}</td>
                          <td className="num">{fmtInt(row.requests)}</td>
                          <td className="num" title={`${fmtInt(row.total_tokens)} 토큰`}>
                            {fmtTokensShort(row.total_tokens)}
                          </td>
                          <td className="num us-cell-strong">{fmtUsd(row.cost_usd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="us-panel">
              <div className="us-panel-head">
                <h3 className="us-panel-title">소속별 사용량</h3>
              </div>
              {data.by_organization.length === 0 ? (
                <div className="us-table-empty">기록이 없어요</div>
              ) : (
                <div className="us-table-wrap">
                  <table className="us-table">
                    <thead>
                      <tr>
                        <th>소속</th>
                        <th className="num">요청</th>
                        <th className="num">토큰</th>
                        <th className="num">예상 비용</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.by_organization.map((row) => (
                        <tr key={row.organization}>
                          <td className="us-cell-strong">{row.organization}</td>
                          <td className="num">{fmtInt(row.requests)}</td>
                          <td className="num" title={`${fmtInt(row.total_tokens)} 토큰`}>
                            {fmtTokensShort(row.total_tokens)}
                          </td>
                          <td className="num us-cell-strong">{fmtUsd(row.cost_usd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {/* ---------- 모델별 요금 팝업 ---------- */}
      <Modal
        open={pricingOpen}
        title="모델별 요금 안내 (USD / 1M 토큰)"
        width={640}
        onClose={() => setPricingOpen(false)}
      >
        {pricing ? (
          <div className="us-pricing-modal">
            <div className="us-table-wrap">
              <table className="us-table us-pricing-table">
                <thead>
                  <tr>
                    <th>모델</th>
                    <th className="num">입력</th>
                    <th className="num">오디오 입력</th>
                    <th className="num">출력</th>
                    <th className="num">장문(&gt;200K) 입력/출력</th>
                  </tr>
                </thead>
                <tbody>
                  {pricing.models.map((m) => (
                    <tr key={m.model}>
                      <td className="us-cell-strong">{m.model}</td>
                      <td className="num">${m.input}</td>
                      <td className="num">${m.input_audio}</td>
                      <td className="num">${m.output}</td>
                      <td className="num">
                        {m.tier_threshold ? `$${m.tier_input} / $${m.tier_output}` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="us-pricing-note">
              {pricing.note} (기준일: {pricing.asof})
            </p>
          </div>
        ) : (
          <p className="us-pricing-note">단가표를 불러오지 못했어요.</p>
        )}
      </Modal>
    </section>
  )
}

export default UsageSummarySettings
