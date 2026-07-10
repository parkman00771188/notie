import { useEffect, useState } from 'react'
import type { FormEvent, MouseEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../App'
import { AvatarStack } from '../components/Avatar'
import { useConfirm } from '../components/confirm'
import { MeetingDetailView } from '../components/MeetingDetailView'
import Modal from '../components/Modal'
import { RecentMeetingsPanel } from '../components/RecentMeetingsPanel'
import { StatusBadge } from '../components/StatusBadge'
import { TrashModal } from '../components/TrashModal'
import type { Meeting, Tag } from '../types'
import { formatClock, formatKoreanDateTime } from '../utils'
import './MeetingsPage.css'

/** 태그 필터: 'all'(전체) | 'none'(태그 없음) | { tag: 태그명 } */
type TagFilter = 'all' | 'none' | { tag: string }
type MeetingScope = 'shared' | 'mine'

const scopeFromSearch = (search: string): MeetingScope => {
  const value = new URLSearchParams(search).get('scope')
  return value === 'shared' ? 'shared' : 'mine'
}

const TAG_PALETTE = [
  '#16a34a',
  '#2563eb',
  '#e8590c',
  '#7048e8',
  '#d6336c',
  '#0ca678',
  '#f08c00',
  '#1098ad',
]

interface MeetingGroup {
  key: string
  name: string
  color: string | null
  items: Meeting[]
  kind?: 'shared' | 'mine' | 'tag'
  tag: Tag | null
  children?: MeetingGroup[]
}

function TagColorPicker({
  value,
  onChange,
}: {
  value: string | null
  onChange: (color: string | null) => void
}) {
  const isCustom = value !== null && !TAG_PALETTE.includes(value)
  return (
    <div className="meeting-tag-palette" role="group" aria-label="태그 색 선택">
      {TAG_PALETTE.map((color) => (
        <button
          key={color}
          type="button"
          className={`meeting-tag-swatch${value === color ? ' selected' : ''}`}
          style={{ background: color }}
          aria-label={`색상 ${color}`}
          aria-pressed={value === color}
          title={value === color ? '선택 해제' : color}
          onClick={() => onChange(value === color ? null : color)}
        />
      ))}
      <label
        className={`meeting-tag-swatch meeting-tag-swatch-custom${isCustom ? ' selected' : ''}`}
        style={isCustom ? { background: value } : undefined}
        title="직접 색 선택"
      >
        <input
          type="color"
          className="meeting-tag-color-input"
          value={isCustom ? value : '#2563eb'}
          onChange={(event) => onChange(event.target.value)}
          aria-label="직접 색 선택"
        />
      </label>
    </div>
  )
}

export default function MeetingsPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const confirm = useConfirm()
  const { user } = useAuth()
  const [q, setQ] = useState('')
  const [meetings, setMeetings] = useState<Meeting[] | null>(null)
  const [trashOpen, setTrashOpen] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [tags, setTags] = useState<Tag[]>([])
  const [tagFilter, setTagFilter] = useState<TagFilter>('all')
  const [tagFilterOpen, setTagFilterOpen] = useState(false)
  const [tagAddOpen, setTagAddOpen] = useState(false)
  const [tagAddName, setTagAddName] = useState('')
  const [tagAddColor, setTagAddColor] = useState<string | null>(null)
  const [tagAddError, setTagAddError] = useState('')
  const [tagAdding, setTagAdding] = useState(false)
  const [editingTagId, setEditingTagId] = useState<number | null>(null)
  const [editTagName, setEditTagName] = useState('')
  const [editTagColor, setEditTagColor] = useState<string | null>(null)
  const [tagSaving, setTagSaving] = useState(false)
  const [scope, setScope] = useState<MeetingScope>(() => scopeFromSearch(location.search))
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

  useEffect(() => {
    const nextScope = scopeFromSearch(location.search)
    setScope((current) => (current === nextScope ? current : nextScope))
  }, [location.search])

  const handleScopeChange = (nextScope: MeetingScope) => {
    setScope(nextScope)
    navigate(`/meetings?scope=${nextScope}`)
  }

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
  const sharedVisible = visible.filter((m) => m.is_shared)
  const mineVisible = visible.filter((m) => m.user_id === user?.id)
  const scopedVisible = scope === 'shared' ? sharedVisible : mineVisible
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

  const closeTagAdd = () => {
    if (tagAdding || tagSaving) return
    setTagAddOpen(false)
    setTagAddError('')
    setEditingTagId(null)
  }

  const handleAddTag = async (event: FormEvent) => {
    event.preventDefault()
    const name = tagAddName.trim()
    if (!name || tagAdding) return
    setTagAdding(true)
    setTagAddError('')
    try {
      const data: {
        name: string
        color?: string
      } = { name }
      if (tagAddColor) data.color = tagAddColor
      const created = await api.createTag(data)
      setTags((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name, 'ko')))
      setTagAddName('')
      setTagAddColor(null)
      setTagAddOpen(false)
    } catch (err) {
      setTagAddError(err instanceof Error ? err.message : '태그를 추가하지 못했어요')
    } finally {
      setTagAdding(false)
    }
  }

  const startTagEdit = (tag: Tag) => {
    if (tag.is_project_tag) {
      setTagAddError('프로젝트 태그는 프로젝트 관리에서만 수정할 수 있어요')
      return
    }
    setEditingTagId(tag.id)
    setEditTagName(tag.name)
    setEditTagColor(tag.color)
    setTagAddError('')
  }

  const handleTagEditSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (editingTagId === null || tagSaving) return
    const name = editTagName.trim()
    if (!name) return

    const current = tags.find((tag) => tag.id === editingTagId)
    if (current?.is_project_tag) {
      setTagAddError('프로젝트 태그는 프로젝트 관리에서만 수정할 수 있어요')
      setEditingTagId(null)
      return
    }
    const data: { name?: string; color?: string } = {}
    if (!current || current.name !== name) data.name = name
    if (editTagColor && (!current || current.color !== editTagColor)) data.color = editTagColor
    if (Object.keys(data).length === 0) {
      setEditingTagId(null)
      return
    }

    setTagSaving(true)
    setTagAddError('')
    try {
      const updated = await api.updateTag(editingTagId, data)
      setTags((prev) =>
        prev.map((tag) => (tag.id === updated.id ? updated : tag)).sort((a, b) => a.name.localeCompare(b.name, 'ko')),
      )
      if (current && typeof tagFilter === 'object' && tagFilter.tag === current.name) {
        setTagFilter({ tag: updated.name })
      }
      setReloadKey((key) => key + 1)
      setEditingTagId(null)
    } catch (err) {
      setTagAddError(err instanceof Error ? err.message : '태그를 수정하지 못했어요')
    } finally {
      setTagSaving(false)
    }
  }

  const handleDeleteTag = async (tag: Tag, event: MouseEvent) => {
    event.stopPropagation()
    if (tag.is_project_tag) {
      setTagAddError('프로젝트 태그는 프로젝트 관리에서만 삭제할 수 있어요')
      return
    }
    const ok = await confirm({
      title: `'${tag.name}' 태그를 삭제할까요?`,
      message: '기존 회의에 표시된 태그는 그대로 남아요.',
      confirmLabel: '삭제',
      danger: true,
    })
    if (!ok) return

    setTagAddError('')
    try {
      await api.deleteTag(tag.id)
      setTags((prev) => prev.filter((item) => item.id !== tag.id))
      if (editingTagId === tag.id) setEditingTagId(null)
      if (typeof tagFilter === 'object' && tagFilter.tag === tag.name) setTagFilter('all')
    } catch (err) {
      setTagAddError(err instanceof Error ? err.message : '태그를 삭제하지 못했어요')
    }
  }

  const buildTagGroups = (source: Meeting[], keyPrefix: string): MeetingGroup[] => {
    const byTag = new Map<string, Meeting[]>()
    for (const m of source) {
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
    return keys.map((key) => {
      const tag = tags.find((t) => t.name === key) ?? null
      return {
        key: `${keyPrefix}${key || '__untagged__'}`,
        name: key || '미분류',
        color: tag?.color ?? null,
        items: byTag.get(key) ?? [],
        kind: 'tag' as const,
        tag,
      }
    })
  }

  const renderRow = (m: Meeting) => {
    const isOwner = user?.id === m.user_id

    return (
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
          {m.is_shared && <span className="shared-pill">공유</span>}
          {!isOwner && m.owner_name && <span className="owner-pill">{m.owner_name}</span>}
        </span>
        <span className="row-badge">
          <StatusBadge status={m.status} />
        </span>
        <span className="row-date">
          <span>{formatKoreanDateTime(m.started_at)}</span>
          <span className="row-date-duration">
            {m.status === 'scheduled' ? '예정' : formatClock(m.duration_sec)}
          </span>
        </span>
        <span className="row-people">
          {m.participants.length > 0 ? (
            <AvatarStack participants={m.participants} max={3} />
          ) : (
            <span className="muted">-</span>
          )}
        </span>
        {isOwner ? (
          <button
            type="button"
            className="btn-icon row-delete"
            aria-label="회의 삭제"
            title={m.locked ? '잠긴 회의는 삭제할 수 없어요' : '삭제'}
            disabled={m.locked}
            onClick={(e) => handleDelete(e, m)}
          >
            🗑️
          </button>
        ) : (
          <span className="row-delete-placeholder" aria-hidden="true" />
        )}
      </div>
    )
  }

  const renderFolderGroup = (g: MeetingGroup, nested = false) => {
    const isCollapsed = !!collapsed[g.key]
    const hasChildren = !!g.children?.length

    return (
      <div
        key={g.key}
        className={[
          nested ? 'folder-group nested-folder-group' : 'card folder-group',
          g.kind === 'shared' ? 'shared-folder-group' : '',
          g.kind === 'mine' ? 'mine-folder-group' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <button
          type="button"
          className={[
            'folder-head',
            g.kind === 'shared' ? 'shared-folder-head' : '',
            g.kind === 'mine' ? 'mine-folder-head' : '',
            nested ? 'nested-folder-head' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          aria-expanded={!isCollapsed}
          onClick={() => toggleGroup(g.key)}
        >
          <span className={`folder-caret${isCollapsed ? '' : ' open'}`}>▸</span>
          <span
            className={[
              'folder-icon',
              g.kind === 'shared' ? 'shared-folder-icon' : '',
              g.kind === 'mine' ? 'mine-folder-icon' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {g.kind === 'shared' ? '↗' : g.kind === 'mine' ? '' : '📁'}
          </span>
          {g.color && <span className="folder-dot" style={{ background: g.color }} />}
          <span className="folder-name">{g.name}</span>
          <span className="folder-count">{g.items.length}</span>
        </button>
        {!isCollapsed && (
          <div className={`folder-body${nested ? ' nested-folder-body' : ''}`}>
            {hasChildren ? (
              <div className="nested-folder-groups">
                {g.children?.map((child) => renderFolderGroup(child, true))}
              </div>
            ) : (
              g.items.map(renderRow)
            )}
          </div>
        )}
      </div>
    )
  }

  const folderGroups = buildTagGroups(scopedVisible, `${scope}:`)
  const showFolderGroups = view === 'folder' && folderGroups.length > 0
  const emptyTitle = filtered
    ? '조건에 맞는 회의가 없어요'
    : scope === 'shared'
      ? '공유된 회의가 없어요'
      : '아직 내 회의가 없어요'
  const emptyDescription = filtered
    ? '다른 검색어나 태그로 다시 시도해보세요.'
    : scope === 'shared'
      ? '공유된 회의가 생기면 여기에 표시돼요.'
      : '첫 회의를 녹음하면 여기에 표시돼요.'

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
      </div>

      <div className="meetings-scope-tabs" role="tablist" aria-label="회의 범위">
        <button
          type="button"
          className={`meetings-scope-tab${scope === 'shared' ? ' active' : ''}`}
          role="tab"
          aria-selected={scope === 'shared'}
          onClick={() => handleScopeChange('shared')}
        >
          <span className="meetings-scope-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <path d="M7 17 17 7" />
              <path d="M9 7h8v8" />
            </svg>
          </span>
          공유된 회의
        </button>
        <button
          type="button"
          className={`meetings-scope-tab${scope === 'mine' ? ' active' : ''}`}
          role="tab"
          aria-selected={scope === 'mine'}
          onClick={() => handleScopeChange('mine')}
        >
          <span className="meetings-scope-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <circle cx="12" cy="8" r="3.2" />
              <path d="M5.5 19c.9-3.7 3.1-5.6 6.5-5.6s5.6 1.9 6.5 5.6" />
            </svg>
          </span>
          내 회의
        </button>
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
          <button
            type="button"
            className="tag-filter-add-btn"
            onClick={() => {
              setTagAddError('')
              setTagAddOpen(true)
            }}
          >
            <svg className="tag-filter-add-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z" />
              <path d="M19.4 15a1.8 1.8 0 0 0 .36 2l.05.05a2.1 2.1 0 0 1-2.97 2.97l-.05-.05a1.8 1.8 0 0 0-2-.36 1.8 1.8 0 0 0-1.1 1.66v.08a2.1 2.1 0 0 1-4.2 0v-.08a1.8 1.8 0 0 0-1.1-1.66 1.8 1.8 0 0 0-2 .36l-.05.05a2.1 2.1 0 1 1-2.97-2.97l.05-.05a1.8 1.8 0 0 0 .36-2 1.8 1.8 0 0 0-1.66-1.1H2.1a2.1 2.1 0 1 1 0-4.2h.08a1.8 1.8 0 0 0 1.66-1.1 1.8 1.8 0 0 0-.36-2l-.05-.05a2.1 2.1 0 1 1 2.97-2.97l.05.05a1.8 1.8 0 0 0 2 .36 1.8 1.8 0 0 0 1.1-1.66V2.1a2.1 2.1 0 1 1 4.2 0v.08a1.8 1.8 0 0 0 1.1 1.66 1.8 1.8 0 0 0 2-.36l.05-.05a2.1 2.1 0 1 1 2.97 2.97l-.05.05a1.8 1.8 0 0 0-.36 2 1.8 1.8 0 0 0 1.66 1.1h.08a2.1 2.1 0 1 1 0 4.2h-.08a1.8 1.8 0 0 0-1.66 1.1Z" />
            </svg>
            태그 설정
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
      </div>

      <div className="meetings-content-grid">
        <main className="meetings-main-panel">
          {loading ? (
            <div className="meetings-loading">
              <span className="spinner" />
            </div>
          ) : showFolderGroups ? (
            <div className="folder-groups">
              {folderGroups.map((g) => renderFolderGroup(g))}
            </div>
          ) : scopedVisible.length === 0 ? (
            <div className="card">
              <div className="empty-state">
                <div className="emoji">{filtered ? '🔍' : scope === 'shared' ? '↗' : '🎙️'}</div>
                <p className="empty-title">{emptyTitle}</p>
                <p>{emptyDescription}</p>
                {!filtered && scope === 'mine' && (
                  <button className="btn btn-primary empty-cta" onClick={() => navigate('/record')}>
                    녹음 시작하기
                  </button>
                )}
              </div>
            </div>
          ) : view === 'list' ? (
            <div className="card meeting-list">{scopedVisible.map(renderRow)}</div>
          ) : (
            <div className="folder-groups">
              {folderGroups.map((g) => renderFolderGroup(g))}
            </div>
          )}
        </main>
        <RecentMeetingsPanel
          refreshKey={reloadKey}
          limit={5}
          showPromo={false}
          onChanged={() => setReloadKey((key) => key + 1)}
        />
      </div>

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
          <button
            type="button"
            className="tag-filter-option tag-filter-option-add"
            onClick={() => {
              setTagFilterOpen(false)
              setTagAddError('')
              setTagAddOpen(true)
            }}
          >
            <span className="tag-filter-option-main">
              <span className="tag-filter-option-icon gear" aria-hidden="true">
                <svg className="tag-filter-add-icon" viewBox="0 0 24 24">
                  <path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z" />
                  <path d="M19.4 15a1.8 1.8 0 0 0 .36 2l.05.05a2.1 2.1 0 0 1-2.97 2.97l-.05-.05a1.8 1.8 0 0 0-2-.36 1.8 1.8 0 0 0-1.1 1.66v.08a2.1 2.1 0 0 1-4.2 0v-.08a1.8 1.8 0 0 0-1.1-1.66 1.8 1.8 0 0 0-2 .36l-.05.05a2.1 2.1 0 1 1-2.97-2.97l.05-.05a1.8 1.8 0 0 0 .36-2 1.8 1.8 0 0 0-1.66-1.1H2.1a2.1 2.1 0 1 1 0-4.2h.08a1.8 1.8 0 0 0 1.66-1.1 1.8 1.8 0 0 0-.36-2l-.05-.05a2.1 2.1 0 1 1 2.97-2.97l.05.05a1.8 1.8 0 0 0 2 .36 1.8 1.8 0 0 0 1.1-1.66V2.1a2.1 2.1 0 1 1 4.2 0v.08a1.8 1.8 0 0 0 1.1 1.66 1.8 1.8 0 0 0 2-.36l.05-.05a2.1 2.1 0 1 1 2.97 2.97l-.05.05a1.8 1.8 0 0 0-.36 2 1.8 1.8 0 0 0 1.66 1.1h.08a2.1 2.1 0 1 1 0 4.2h-.08a1.8 1.8 0 0 0-1.66 1.1Z" />
                </svg>
              </span>
              <span className="tag-filter-option-name">태그 설정</span>
            </span>
          </button>
        </div>
      </Modal>
      <Modal open={tagAddOpen} title="태그 · 프로젝트" width={760} onClose={closeTagAdd}>
        <div className="meeting-tag-add-panel">
          <div className="meeting-tag-add-head">
            <span aria-hidden="true">🏷️</span>
            <div>
              <h3>태그 · 프로젝트</h3>
              <p>회의를 프로젝트/과제별로 분류합니다.</p>
            </div>
          </div>
          {tagAddError && <div className="meeting-tag-add-error">{tagAddError}</div>}
          <form className="meeting-tag-add-form" onSubmit={handleAddTag}>
            <input
              className="input meeting-tag-name-input"
              value={tagAddName}
              onChange={(event) => setTagAddName(event.target.value)}
              placeholder="새 태그 이름"
              autoFocus
            />
            <TagColorPicker value={tagAddColor} onChange={setTagAddColor} />
            <button type="submit" className="btn btn-primary" disabled={!tagAddName.trim() || tagAdding}>
              {tagAdding ? '추가 중...' : '추가'}
            </button>
          </form>
          <p className="meeting-tag-add-hint">
            색을 고르지 않으면 팔레트에서 자동으로 배정돼요.
          </p>
          {tags.length === 0 ? (
            <p className="meeting-tag-empty">등록된 태그가 없어요.</p>
          ) : (
            <ul className="meeting-tag-list" aria-label="태그 관리">
              {tags.map((tag) => {
                const canManageTag = tag.can_manage !== false
                const isProjectTag = Boolean(tag.is_project_tag)
                const isReadonly = isProjectTag || !canManageTag
                const deleteDisabled = isReadonly
                const editTitle = isProjectTag
                  ? '프로젝트 태그는 프로젝트 관리에서만 이름과 색상을 수정할 수 있습니다'
                  : isReadonly
                    ? '이 태그는 수정 권한이 없습니다'
                    : '이름/색 수정'
                const deleteTitle = isProjectTag
                  ? '프로젝트 태그는 프로젝트 관리에서만 삭제할 수 있습니다'
                  : isReadonly
                    ? '이 태그는 삭제 권한이 없습니다'
                    : '삭제'
                const isEditing = editingTagId === tag.id
                return (
                  <li
                    key={tag.id}
                    className={`meeting-tag-row${isReadonly ? ' readonly' : ''}${isProjectTag ? ' project-managed' : ''}`}
                  >
                    <span
                      className="meeting-tag-row-dot"
                      style={{ background: isEditing ? (editTagColor ?? tag.color) : tag.color }}
                    />
                    {isEditing ? (
                      <form className="meeting-tag-edit-form" onSubmit={handleTagEditSubmit}>
                        <input
                          autoFocus
                          className="input meeting-tag-edit-input"
                          value={editTagName}
                          onChange={(event) => setEditTagName(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') setEditingTagId(null)
                          }}
                        />
                        <TagColorPicker value={editTagColor} onChange={setEditTagColor} />
                        <button
                          type="submit"
                          className="btn btn-soft"
                          disabled={!editTagName.trim() || tagSaving}
                        >
                          {tagSaving ? '저장 중...' : '저장'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          disabled={tagSaving}
                          onClick={() => setEditingTagId(null)}
                        >
                          취소
                        </button>
                      </form>
                    ) : (
                      <>
                        <span className="meeting-tag-row-name">{tag.name}</span>
                        {isProjectTag && <span className="meeting-tag-project-badge">프로젝트</span>}
                        <div className="meeting-tag-row-actions">
                          <button
                            type="button"
                            className="btn-icon"
                            disabled={isReadonly}
                            title={editTitle}
                            aria-label={`${tag.name} 수정`}
                            onClick={() => startTagEdit(tag)}
                          >
                            ✏️
                          </button>
                          <button
                            type="button"
                            className="btn-icon row-delete meeting-tag-delete-btn"
                            disabled={deleteDisabled}
                            title={deleteTitle}
                            aria-label={`${tag.name} 삭제`}
                            onClick={(event) => void handleDeleteTag(tag, event)}
                          >
                            🗑
                          </button>
                        </div>
                      </>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
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
