import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import type { Meeting, Tag } from '../types'
import { formatClock, formatRelativeDate } from '../utils'
import { MeetingDetailView } from './MeetingDetailView'
import Modal from './Modal'
import StatusBadge from './StatusBadge'
import './components.css'
import './RecentMeetingsModal.css'

export interface RecentMeetingsPanelProps {
  refreshKey?: number
}

/** 전체 보기 모달 태그 필터: 'all'(전체) | { tag: 태그명 } */
type ModalTagFilter = 'all' | { tag: string }

interface ModalGroup {
  key: string
  name: string
  color: string | null
  untagged: boolean
  items: Meeting[]
}

export function RecentMeetingsPanel({ refreshKey = 0 }: RecentMeetingsPanelProps) {
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)
  const navigate = useNavigate()

  // ---- 전체 보기 모달 상태 ----
  const [modalOpen, setModalOpen] = useState(false)
  const [tags, setTags] = useState<Tag[]>([])
  const [tagFilter, setTagFilter] = useState<ModalTagFilter>('all')
  const [view, setView] = useState<'list' | 'folder'>('folder')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [detailId, setDetailId] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api
      .listMeetings()
      .then((list) => {
        if (!cancelled) setMeetings(list)
      })
      .catch(() => {
        if (!cancelled) setMeetings([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    // 태그 사전 — 패널 목록의 태그 칩 색에도 필요하므로 처음부터 로드
    api
      .listTags()
      .then((list) => {
        if (!cancelled) setTags(list)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [refreshKey, reloadKey])

  const recent = meetings.slice(0, 6)

  const openAll = () => {
    setTagFilter('all')
    setView('folder')
    setCollapsed({})
    setDetailId(null)
    setModalOpen(true)
  }

  const closeModal = () => {
    setModalOpen(false)
    setDetailId(null)
  }

  const reloadList = () => setReloadKey((k) => k + 1)

  const goAllMeetings = () => {
    closeModal()
    navigate('/meetings')
  }

  // 태그 필터 적용된 모달 목록
  const visible = useMemo(() => {
    if (typeof tagFilter === 'object') return meetings.filter((m) => m.tag === tagFilter.tag)
    return meetings
  }, [meetings, tagFilter])

  const tagColor = (name: string): string | null =>
    tags.find((t) => t.name === name)?.color ?? null

  /** 폴더(그룹) 보기: 등록 태그(name ASC) → 미등록 태그 → "태그 없음" 마지막 */
  const groups = useMemo<ModalGroup[]>(() => {
    const byTag = new Map<string, Meeting[]>()
    for (const m of visible) {
      const key = m.tag ?? ''
      const arr = byTag.get(key)
      if (arr) arr.push(m)
      else byTag.set(key, [m])
    }
    const registered = tags.map((t) => t.name).filter((name) => byTag.has(name))
    const unknown = [...byTag.keys()]
      .filter((key) => key !== '' && !tags.some((t) => t.name === key))
      .sort((a, b) => a.localeCompare(b, 'ko'))
    const keys = [...registered, ...unknown]
    if (byTag.has('')) keys.push('')
    return keys.map((key) => ({
      key: key || '__untagged__',
      name: key || '태그 없음',
      color: key ? (tags.find((t) => t.name === key)?.color ?? null) : null,
      untagged: key === '',
      items: byTag.get(key) ?? [],
    }))
  }, [visible, tags])

  const toggleGroup = (key: string) => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const renderRow = (m: Meeting) => {
    const color = (m.tag ? tagColor(m.tag) : null) ?? '#16a34a'
    return (
      <button key={m.id} type="button" className="rmm-row" onClick={() => setDetailId(m.id)}>
        <span className="rmm-row-title" title={m.title}>
          {m.tag && (
            <span
              className="tag-pill rmm-row-tag"
              style={{
                color,
                borderColor: color,
                background: `color-mix(in srgb, ${color} 10%, transparent)`,
              }}
            >
              #{m.tag}
            </span>
          )}
          {m.title}
        </span>
        <StatusBadge status={m.status} />
        <span className="rmm-row-meta">
          {formatRelativeDate(m.started_at)} · {formatClock(m.duration_sec)}
        </span>
      </button>
    )
  }

  return (
    <aside className="recent-panel">
      <div className="card recent-card">
        <div className="recent-head">
          <h3>최근 회의</h3>
          <button type="button" className="link-btn" onClick={openAll}>
            전체 보기
          </button>
        </div>

        {loading ? (
          <div className="recent-loading">
            <span className="spinner" />
          </div>
        ) : recent.length === 0 ? (
          <div className="recent-empty">아직 회의 기록이 없어요</div>
        ) : (
          <div className="recent-list">
            {recent.map((m) => (
              <button
                key={m.id}
                type="button"
                className="recent-item"
                onClick={() => navigate(`/meetings/${m.id}`)}
              >
                <span className="recent-item-title">
                  <span className="recent-item-icon">📄</span>
                  {m.tag &&
                    (() => {
                      const c = tagColor(m.tag) ?? '#16a34a'
                      return (
                        <span
                          className="tag-pill recent-item-tag"
                          style={{
                            color: c,
                            borderColor: c,
                            background: `color-mix(in srgb, ${c} 10%, transparent)`,
                          }}
                        >
                          #{m.tag}
                        </span>
                      )
                    })()}
                  <span className="recent-item-name">{m.title}</span>
                </span>
                <span className="recent-item-meta">
                  {/* 요약 완료(정상 상태)는 배지 생략 — 진행 중/실패만 표시 */}
                  {m.status !== 'done' && <StatusBadge status={m.status} />}
                  <span className="muted">
                    {formatRelativeDate(m.started_at)} · {formatClock(m.duration_sec)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="ai-promo">
        <div className="ai-promo-emoji">✨</div>
        <p className="ai-promo-title">회의를 더 빠르게 정리해보세요</p>
        <button type="button" className="ai-promo-link" onClick={() => navigate('/meetings')}>
          AI 요약 사용하기 →
        </button>
      </div>

      {/* 전체 보기 팝업 — 태그 필터 + 목록/폴더 보기 + 팝업 내 상세 */}
      <Modal open={modalOpen} title="전체 회의" width={960} onClose={closeModal}>
        <div className="rmm-root">
          {detailId == null ? (
            <>
              <div className="rmm-toolbar">
                <div className="rmm-chips" role="group" aria-label="태그 필터">
                  <button
                    type="button"
                    className={`rmm-chip${tagFilter === 'all' ? ' active' : ''}`}
                    onClick={() => setTagFilter('all')}
                  >
                    전체
                  </button>
                  {tags.map((t) => {
                    const active = typeof tagFilter === 'object' && tagFilter.tag === t.name
                    return (
                      <button
                        key={t.id}
                        type="button"
                        className={`rmm-chip${active ? ' active' : ''}`}
                        style={
                          active
                            ? {
                                borderColor: t.color,
                                color: t.color,
                                background: `color-mix(in srgb, ${t.color} 12%, transparent)`,
                              }
                            : undefined
                        }
                        onClick={() => setTagFilter({ tag: t.name })}
                      >
                        <span className="rmm-chip-dot" style={{ background: t.color }} />
                        {t.name}
                      </button>
                    )
                  })}
                </div>

                <div className="rmm-toggle" role="group" aria-label="보기 방식">
                  <button
                    type="button"
                    className={`rmm-toggle-btn${view === 'list' ? ' active' : ''}`}
                    aria-pressed={view === 'list'}
                    onClick={() => setView('list')}
                  >
                    ☰ 목록 보기
                  </button>
                  <button
                    type="button"
                    className={`rmm-toggle-btn${view === 'folder' ? ' active' : ''}`}
                    aria-pressed={view === 'folder'}
                    onClick={() => setView('folder')}
                  >
                    📁 폴더 보기
                  </button>
                </div>
              </div>

              <div className="rmm-scroll">
                {visible.length === 0 ? (
                  <div className="empty-state">
                    <div className="emoji">🔍</div>
                    {meetings.length === 0 ? '아직 회의 기록이 없어요' : '조건에 맞는 회의가 없어요'}
                  </div>
                ) : view === 'list' ? (
                  <div className="rmm-list">{visible.map(renderRow)}</div>
                ) : (
                  <div className="rmm-groups">
                    {groups.map((g) => {
                      const isCollapsed = !!collapsed[g.key]
                      return (
                        <div key={g.key} className="rmm-group">
                          <button
                            type="button"
                            className="rmm-group-head"
                            aria-expanded={!isCollapsed}
                            onClick={() => toggleGroup(g.key)}
                          >
                            <span className={`rmm-caret${isCollapsed ? '' : ' open'}`}>▸</span>
                            <span className="rmm-folder-icon">📁</span>
                            {g.color && <span className="rmm-group-dot" style={{ background: g.color }} />}
                            <span className={`rmm-group-name${g.untagged ? ' untagged' : ''}`}>
                              {g.name}
                            </span>
                            <span className="rmm-group-count">{g.items.length}</span>
                          </button>
                          {!isCollapsed && <div className="rmm-group-body">{g.items.map(renderRow)}</div>}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="rmm-scroll rmm-detail">
              <MeetingDetailView
                meetingId={detailId}
                onBack={() => setDetailId(null)}
                onDeleted={() => {
                  setDetailId(null)
                  reloadList()
                }}
                onChanged={reloadList}
              />
            </div>
          )}

          <div className="rmm-footer">
            <span className="muted rmm-footer-hint">
              💡 회의를 클릭하면 상세 내용을 확인할 수 있어요.
            </span>
            <button type="button" className="link-btn" onClick={goAllMeetings}>
              전체 회의 보기 →
            </button>
          </div>
        </div>
      </Modal>
    </aside>
  )
}

export default RecentMeetingsPanel
