import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { api } from '../api'
import type { Tag } from '../types'
import './TagPicker.css'

/** 태그 사전에서 찾지 못한 태그명에 쓰는 기본 색 (초록) */
const DEFAULT_TAG_COLOR = '#16a34a'

export interface TagPickerProps {
  value: string | null
  onChange: (tag: string | null) => void
  compact?: boolean
}

export function TagPicker({ value, onChange, compact = false }: TagPickerProps) {
  const [open, setOpen] = useState(false)
  const [tags, setTags] = useState<Tag[]>([])
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  // 마운트 시 1회 로드 — 현재 태그 칩 색을 이름 매칭으로 반영하기 위해
  useEffect(() => {
    let cancelled = false
    api
      .listTags()
      .then((list) => {
        if (!cancelled) setTags(list)
      })
      .catch(() => {
        /* 목록 로드 실패 시 기본 색으로 표시 */
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 팝오버가 열리면 최신 목록으로 갱신 + 외부 클릭/ESC로 닫기
  useEffect(() => {
    if (!open) return
    let cancelled = false
    api
      .listTags()
      .then((list) => {
        if (!cancelled) setTags(list)
      })
      .catch(() => {})
    const onDocMouseDown = (e: globalThis.MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onDocKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onDocKeyDown)
    return () => {
      cancelled = true
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onDocKeyDown)
    }
  }, [open])

  const close = () => {
    setOpen(false)
    setNewName('')
    setError('')
  }

  const select = (tag: string | null) => {
    close()
    if (tag !== value) onChange(tag)
  }

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name || creating) return
    // 이미 있는 이름이면 새로 만들지 않고 바로 선택
    const existing = tags.find((t) => t.name === name)
    if (existing) {
      select(existing.name)
      return
    }
    setCreating(true)
    setError('')
    try {
      const created = await api.createTag({ name })
      setTags((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name, 'ko')))
      select(created.name)
    } catch (err) {
      setError(err instanceof Error ? err.message : '태그를 만들지 못했어요')
    } finally {
      setCreating(false)
    }
  }

  const onNewKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void handleCreate()
    }
  }

  const current = value ? tags.find((t) => t.name === value) : undefined
  const chipColor = current?.color ?? DEFAULT_TAG_COLOR

  return (
    <div className={`tagpicker${compact ? ' tagpicker-compact' : ''}`} ref={rootRef}>
      <button
        type="button"
        className={`tagpicker-trigger${value ? ' has-tag' : ''}`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={value ? `태그: ${value}` : '태그 추가'}
        style={
          value
            ? {
                borderColor: chipColor,
                color: chipColor,
                background: `color-mix(in srgb, ${chipColor} 12%, transparent)`,
              }
            : undefined
        }
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="tagpicker-trigger-label">{value ? `# ${value}` : '+ 태그'}</span>
      </button>

      {open && (
        <div className="tagpicker-pop" role="menu">
          <div className="tagpicker-list">
            {tags.length === 0 ? (
              <p className="tagpicker-empty">등록된 태그가 없어요.</p>
            ) : (
              tags.map((t) => {
                const selected = t.name === value
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="menuitem"
                    className={`tagpicker-item${selected ? ' selected' : ''}`}
                    onClick={() => select(t.name)}
                  >
                    <span className="tagpicker-dot" style={{ background: t.color }} />
                    <span className="tagpicker-item-name">{t.name}</span>
                    {selected && <span className="tagpicker-check">✓</span>}
                  </button>
                )
              })
            )}
          </div>

          <div className="tagpicker-divider" />

          <button
            type="button"
            role="menuitem"
            className={`tagpicker-item${value == null ? ' selected' : ''}`}
            onClick={() => select(null)}
          >
            <span className="tagpicker-dot tagpicker-dot-none" />
            <span className="tagpicker-item-name">태그 없음</span>
            {value == null && <span className="tagpicker-check">✓</span>}
          </button>

          <div className="tagpicker-new">
            {error && <p className="tagpicker-error">{error}</p>}
            <div className="tagpicker-new-row">
              <input
                className="input tagpicker-new-input"
                placeholder="새 태그 만들기"
                aria-label="새 태그 이름"
                value={newName}
                onChange={(e) => {
                  setNewName(e.target.value)
                  if (error) setError('')
                }}
                onKeyDown={onNewKeyDown}
                disabled={creating}
              />
              <button
                type="button"
                className="btn btn-soft tagpicker-new-btn"
                onClick={() => void handleCreate()}
                disabled={!newName.trim() || creating}
              >
                {creating ? '추가 중...' : '추가'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default TagPicker
