import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import './ComboBox.css'

export interface ComboBoxProps {
  value: string
  onChange: (v: string) => void
  /** 정렬된 옵션 목록 */
  options: string[]
  placeholder?: string
  /** 새 값 등록 콜백 — 있으면 목록에 없는 입력값에 "+ 추가" 행 표시 */
  onCreateOption?: (name: string) => void
  /** 있으면 옵션 hover 시 × 버튼으로 삭제(confirm) */
  onDeleteOption?: (name: string) => void
}

/**
 * 커스텀 드롭다운 콤보박스 — 목록에서 고르거나 자유 입력.
 * 부분일치 필터, ↑↓+Enter 탐색, "+ 추가" 행(onCreateOption), 옵션 삭제 ×(onDeleteOption),
 * 외부 클릭/ESC 닫기. 자유 입력값은 등록 없이도 그대로 value로 유지된다.
 */
export function ComboBox({
  value,
  onChange,
  options,
  placeholder,
  onCreateOption,
  onDeleteOption,
}: ComboBoxProps) {
  const [open, setOpen] = useState(false)
  // 드롭다운을 연 뒤 타이핑했는지 — 타이핑 전에는 전체 목록을 보여준다
  const [filtering, setFiltering] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const trimmed = value.trim()
  const query = filtering ? trimmed.toLowerCase() : ''
  const visible = query ? options.filter((o) => o.toLowerCase().includes(query)) : options
  const showCreate = !!onCreateOption && trimmed !== '' && !options.includes(trimmed)
  const createIndex = visible.length // 마지막 "+ 추가" 행
  const lastIndex = showCreate ? createIndex : visible.length - 1

  const close = () => {
    setOpen(false)
    setFiltering(false)
    setActiveIndex(-1)
  }

  // 외부 클릭으로 닫기
  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (e: globalThis.MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
        setFiltering(false)
        setActiveIndex(-1)
      }
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [open])

  // 검색어/목록이 바뀌면 하이라이트 리셋 (타이핑 중엔 첫 항목)
  useEffect(() => {
    setActiveIndex(query && (visible.length > 0 || showCreate) ? 0 : -1)
  }, [query, visible.length, showCreate])

  // 키보드 탐색 시 활성 항목이 보이도록 스크롤
  useEffect(() => {
    if (activeIndex < 0) return
    listRef.current
      ?.querySelector(`[data-idx="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const selectOption = (name: string) => {
    onChange(name)
    close()
  }

  const handleCreate = () => {
    if (!onCreateOption || !trimmed) return
    onCreateOption(trimmed)
    onChange(trimmed)
    close()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return // IME 조합 중에는 무시
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      if (lastIndex < 0) return
      setActiveIndex((i) => (i + 1 > lastIndex ? 0 : i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      if (lastIndex < 0) return
      setActiveIndex((i) => (i - 1 < 0 ? lastIndex : i - 1))
    } else if (e.key === 'Enter') {
      if (!open) return // 닫혀 있으면 폼 제출 등 기본 동작 유지
      e.preventDefault()
      if (showCreate && activeIndex === createIndex) {
        handleCreate()
        return
      }
      const opt = activeIndex >= 0 ? visible[activeIndex] : undefined
      if (opt !== undefined) selectOption(opt)
      else close() // 하이라이트 없으면 자유 입력 확정 — 드롭다운만 닫는다
    } else if (e.key === 'Escape') {
      if (!open) return
      e.stopPropagation() // 모달까지 닫지 않고 드롭다운만 닫는다
      close()
    }
  }

  return (
    <div className="combobox" ref={rootRef}>
      <input
        ref={inputRef}
        className="input combobox-input"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          setFiltering(true)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        className="combobox-caret"
        tabIndex={-1}
        aria-label={open ? '목록 닫기' : '목록 열기'}
        onClick={() => {
          if (open) {
            close()
          } else {
            inputRef.current?.focus()
            setOpen(true)
          }
        }}
      >
        <span className={`combobox-caret-icon${open ? ' open' : ''}`} aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div
          className="combobox-pop"
          role="listbox"
          ref={listRef}
          onMouseDown={(e) => e.preventDefault() /* 클릭 시 인풋 blur 방지 */}
        >
          {visible.map((o, i) => (
            <div
              key={o}
              role="option"
              aria-selected={o === trimmed}
              data-idx={i}
              className={`combobox-option${i === activeIndex ? ' active' : ''}${
                o === trimmed ? ' selected' : ''
              }`}
              onClick={() => selectOption(o)}
              onMouseEnter={() => setActiveIndex(i)}
            >
              <span className="combobox-option-name">{o}</span>
              {o === trimmed && (
                <span className="combobox-check" aria-hidden="true">
                  ✓
                </span>
              )}
              {onDeleteOption && (
                <button
                  type="button"
                  className="combobox-option-x"
                  aria-label={`${o} 삭제`}
                  title="목록에서 삭제"
                  onClick={(e) => {
                    e.stopPropagation()
                    if (window.confirm(`'${o}' 항목을 목록에서 삭제할까요?`)) {
                      onDeleteOption(o)
                    }
                  }}
                >
                  ×
                </button>
              )}
            </div>
          ))}

          {visible.length === 0 && !showCreate && (
            <p className="combobox-empty">
              {options.length === 0 ? '등록된 항목이 없어요.' : '일치하는 항목이 없어요.'}
            </p>
          )}

          {showCreate && (
            <button
              type="button"
              data-idx={createIndex}
              className={`combobox-create${activeIndex === createIndex ? ' active' : ''}`}
              onClick={handleCreate}
              onMouseEnter={() => setActiveIndex(createIndex)}
            >
              <span aria-hidden="true">+</span>
              <span className="combobox-create-name">‘{trimmed}’ 추가</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export default ComboBox
