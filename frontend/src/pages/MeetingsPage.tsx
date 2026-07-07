import { useEffect, useState } from 'react'
import type { MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { AvatarStack } from '../components/Avatar'
import { useConfirm } from '../components/confirm'
import { MeetingDetailView } from '../components/MeetingDetailView'
import Modal from '../components/Modal'
import { StatusBadge } from '../components/StatusBadge'
import { TrashModal } from '../components/TrashModal'
import type { Meeting, Tag } from '../types'
import { formatClock, formatKoreanDateTime } from '../utils'
import './MeetingsPage.css'

/** 태그 필터: 'all'(전체) | 'none'(태그 없음) | { tag: 태그명 } */
type TagFilter = 'all' | 'none' | { tag: string }

interface MeetingGroup {
  key: string
  name: string
  color: string | null
  items: Meeting[]
}

export default function MeetingsPage() {
  const navigate = useNavigate()
  const confirm = useConfirm()
  const [q, setQ] = useState('')
  const [meetings, setMeetings] = useState<Meeting[] | null>(null)
  const [trashOpen, setTrashOpen] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [tags, setTags] = useState<Tag[]>([])
  const [tagFilter, setTagFilter] = useState<TagFilter>('all')
  const [tagFilterOpen, setTagFilterOpen] = useState(false)
  const [view, setView] = useState<'list' | 'folder'>('folder')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [detailId, setDetailId] = useState<number | null>(null)

  // 태그 사전 로드 (필터 칩 + 폴더 색)
  useEffect(() => {
    api
      .listTags()
      .then(setTags)
      .catch(() => {
        /* 태그 사전 없이도 목록은 동작 */
      })
  }, [])

  // 검색어/태그 필터 300ms 디바운스 후 목록 조회
  useEffect(() => {
    let alive = true
    const timer = window.setTimeout(() => {
      const tagName = typeof tagFilter === 'object' ? tagFilter.tag : undefined
      api
        .listMeetings(q.trim() || undefined, tagName)
        .then((list) => {
          if (alive) setMeetings(list)
        })
        .catch(() => {
          if (alive) setMeetings([])
        })
    }, 300)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [q, tagFilter, reloadKey])

  const handleDelete = async (e: MouseEvent, m: Meeting) => {
    e.stopPropagation()
    const ok = await confirm({
      title: `'${m.title}' 회의를 휴지통으로 이동할까요?`,
      message: '휴지통에서 복원하거나 완전 삭제할 수 있어요.',
      confirmLabel: '휴지통으로 이동',
      danger: true,
    })
    if (!ok) return
    try {
      await api.deleteMeeting(m.id)
      setMeetings((prev) => (prev ? prev.filter((x) => x.id !== m.id) : prev))
    } catch (err) {
      alert(err instanceof Error ? err.message : '삭제에 실패했어요')
    }
  }

  const toggleGroup = (key: string) => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const loading = meetings === null
  const list = (meetings ?? []).filter((m) => m.status !== 'scheduled')
  // '태그 없음'은 클라이언트에서 tag가 비어 있는 회의만 필터
  const visible = tagFilter === 'none' ? list.filter((m) => !m.tag) : list
  const filtered = q.trim().length > 0 || tagFilter !== 'all'
  const selectedTag = typeof tagFilter === 'object' ? tags.find((t) => t.name === tagFilter.tag) : null
  const selectedFilterLabel =
    tagFilter === 'all' ? '전체' : tagFilter === 'none' ? '태그 없음' : tagFilter.tag
  const selectedFilterColor =
    typeof tagFilter === 'object' ? (selectedTag?.color ?? '#2563eb') : undefined

  const applyTagFilter = (next: TagFilter) => {
    setTagFilter(next)
    setTagFilterOpen(false)
  }

  /** 폴더(그룹) 보기: 등록 태그(name ASC) → 미등록 태그 → 미분류 순 */
  const buildGroups = (): MeetingGroup[] => {
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
    if (byTag.has('')) keys.push('') // 태그 없는 회의는 '미분류'로 맨 마지막
    return keys.map((key) => ({
      key: key || '__untagged__',
      name: key || '미분류',
      color: tags.find((t) => t.name === key)?.color ?? null,
      items: byTag.get(key) ?? [],
    }))
  }

  const renderRow = (m: Meeting) => (
    <div
      key={m.id}
      className="meeting-row"
      role="button"
      tabIndex={0}
      onClick={() => setDetailId(m.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') setDetailId(m.id)
      }}
    >
      <span className="row-title" title={m.title}>
        {m.tag &&
          (() => {
            const c = tags.find((t) => t.name === m.tag)?.color ?? '#16a34a'
            return (
              <span
                className="tag-pill row-tag"
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
        <span className="row-title-text">{m.title}</span>
        {m.locked && (
          <span className="lock-pill lock-pill-icon" title="잠금됨" aria-label="잠금됨">
            🔒
          </span>
        )}
      </span>
      <span className="row-badge">
        <StatusBadge status={m.status} />
      </span>
      <span className="row-date">{formatKoreanDateTime(m.started_at)}</span>
      <span className="row-dur">{m.status === 'scheduled' ? '예정' : formatClock(m.duration_sec)}</span>
      <span className="row-people">
        {m.participants.length > 0 ? (
          <AvatarStack participants={m.participants} max={3} />
        ) : (
          <span className="muted">-</span>
        )}
      </span>
      <button
        className="btn-icon row-delete"
        aria-label="회의 삭제"
        title={m.locked ? '잠긴 회의는 삭제할 수 없어요' : '삭제'}
        disabled={m.locked}
        onClick={(e) => handleDelete(e, m)}
      >
        🗑️
      </button>
    </div>
  )

  return (
    <div className="page meetings-page">
      <div className="meetings-header">
        <div className="meetings-title-row">
          <h1 className="page-title">회의 목록</h1>
          <button
            type="button"
            className="btn btn-ghost meetings-title-trash"
            onClick={() => setTrashOpen(true)}
          >
            🗑 휴지통
          </button>
        </div>
        <div className="upload-entry-actions">
          <button
            type="button"
            className="tag-filter-mobile"
            onClick={() => setTagFilterOpen(true)}
            aria-haspopup="dialog"
          >
            <span className="tag-filter-mobile-copy">
              <span className="tag-filter-mobile-label">태그 필터</span>
              <span className="tag-filter-mobile-value">
                {typeof tagFilter === 'object' && (
                  <span
                    className="tag-filter-dot"
                    style={{ background: selectedFilterColor ?? '#2563eb' }}
                  />
                )}
                {selectedFilterLabel}
              </span>
            </span>
            <span className="tag-filter-mobile-chevron" aria-hidden="true">
              ▾
            </span>
          </button>
          <input
            className="input meetings-search"
            type="search"
            placeholder="회의 제목 검색"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>

      {/* 태그 필터 칩 행 + 보기 토글 */}
      <div className="meetings-toolbar">
        <div className="tag-filter-row" role="group" aria-label="태그 필터">
          <button
            type="button"
            className={`tag-filter-chip${tagFilter === 'all' ? ' active' : ''}`}
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
                className={`tag-filter-chip${active ? ' active' : ''}`}
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
                <span className="tag-filter-dot" style={{ background: t.color }} />
                {t.name}
              </button>
            )
          })}
          <button
            type="button"
            className={`tag-filter-chip${tagFilter === 'none' ? ' active' : ''}`}
            onClick={() => setTagFilter('none')}
          >
            태그 없음
          </button>
        </div>

        <div className="view-toggle" role="group" aria-label="보기 방식">
          <button
            type="button"
            className={`view-toggle-btn${view === 'list' ? ' active' : ''}`}
            aria-pressed={view === 'list'}
            onClick={() => setView('list')}
          >
            ☰ 목록
          </button>
          <button
            type="button"
            className={`view-toggle-btn${view === 'folder' ? ' active' : ''}`}
            aria-pressed={view === 'folder'}
            onClick={() => setView('folder')}
          >
            📁 폴더
          </button>
        </div>
      </div>

      {loading ? (
        <div className="meetings-loading">
          <span className="spinner" />
        </div>
      ) : visible.length === 0 ? (
        <div className="card">
          {filtered ? (
            <div className="empty-state">
              <div className="emoji">🔍</div>
              <p className="empty-title">조건에 맞는 회의가 없어요</p>
              <p>다른 검색어나 태그로 다시 시도해보세요.</p>
            </div>
          ) : (
            <div className="empty-state">
              <div className="emoji">🎙️</div>
              <p className="empty-title">아직 기록된 회의가 없어요</p>
              <p>첫 회의를 녹음하면 여기에 표시돼요.</p>
              <button className="btn btn-primary empty-cta" onClick={() => navigate('/record')}>
                녹음 시작하기
              </button>
            </div>
          )}
        </div>
      ) : view === 'list' ? (
        <div className="card meeting-list">{visible.map(renderRow)}</div>
      ) : (
        <div className="folder-groups">
          {buildGroups().map((g) => {
            const isCollapsed = !!collapsed[g.key]
            return (
              <div key={g.key} className="card folder-group">
                <button
                  type="button"
                  className="folder-head"
                  aria-expanded={!isCollapsed}
                  onClick={() => toggleGroup(g.key)}
                >
                  <span className={`folder-caret${isCollapsed ? '' : ' open'}`}>▸</span>
                  <span className="folder-icon">📁</span>
                  {g.color && <span className="folder-dot" style={{ background: g.color }} />}
                  <span className="folder-name">{g.name}</span>
                  <span className="folder-count">{g.items.length}</span>
                </button>
                {!isCollapsed && <div className="folder-body">{g.items.map(renderRow)}</div>}
              </div>
            )
          })}
        </div>
      )}

      <Modal open={tagFilterOpen} title="태그 필터" width={520} onClose={() => setTagFilterOpen(false)}>
        <div className="tag-filter-sheet">
          <button
            type="button"
            className={`tag-filter-option${tagFilter === 'all' ? ' selected' : ''}`}
            onClick={() => applyTagFilter('all')}
          >
              <span className="tag-filter-option-main">
                <span className="tag-filter-option-icon all">전체</span>
              <span className="tag-filter-option-name">전체</span>
              </span>
            {tagFilter === 'all' && <span className="tag-filter-option-check">✓</span>}
          </button>
          {tags.map((t) => {
            const active = typeof tagFilter === 'object' && tagFilter.tag === t.name
            return (
              <button
                key={t.id}
                type="button"
                className={`tag-filter-option${active ? ' selected' : ''}`}
                onClick={() => applyTagFilter({ tag: t.name })}
              >
                <span className="tag-filter-option-main">
                  <span className="tag-filter-option-dot" style={{ background: t.color }} />
                  <span className="tag-filter-option-name">{t.name}</span>
                </span>
                {active && <span className="tag-filter-option-check">✓</span>}
              </button>
            )
          })}
          <button
            type="button"
            className={`tag-filter-option${tagFilter === 'none' ? ' selected' : ''}`}
            onClick={() => applyTagFilter('none')}
          >
            <span className="tag-filter-option-main">
              <span className="tag-filter-option-icon none">없음</span>
              <span className="tag-filter-option-name">태그 없음</span>
            </span>
            {tagFilter === 'none' && <span className="tag-filter-option-check">✓</span>}
          </button>
        </div>
      </Modal>
      <Modal open={detailId !== null} title="회의 내용" width={960} onClose={() => setDetailId(null)}>
        {detailId !== null && (
          <MeetingDetailView
            meetingId={detailId}
            onBack={() => setDetailId(null)}
            onDeleted={() => {
              setDetailId(null)
              setReloadKey((k) => k + 1)
            }}
            onChanged={() => setReloadKey((k) => k + 1)}
          />
        )}
      </Modal>
      <TrashModal
        open={trashOpen}
        onClose={() => setTrashOpen(false)}
        onChanged={() => setReloadKey((k) => k + 1)}
      />
    </div>
  )
}
