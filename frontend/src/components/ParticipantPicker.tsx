import { useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { api } from '../api'
import type { OrgKind, OrgOption, Participant } from '../types'
import Avatar from './Avatar'
import ComboBox from './ComboBox'
import Modal from './Modal'
import './components.css'
import './ParticipantPicker.css'

export interface ParticipantPickerProps {
  open: boolean
  onClose: () => void
  selected: Participant[]
  onChange: (p: Participant[]) => void
}

/** 제안 리스트 서브텍스트: "소속 · 부서 · 직책" */
function subText(p: Participant): string {
  return [p.organization, p.department, p.role].filter(Boolean).join(' · ')
}

/** 선택 칩 서브텍스트: "소속 · 직책" (없으면 부서로 폴백) */
function chipSub(p: Participant): string {
  return [p.organization, p.role].filter(Boolean).join(' · ') || (p.department ?? '')
}

export function ParticipantPicker({ open, onClose, selected, onChange }: ParticipantPickerProps) {
  const [all, setAll] = useState<Participant[]>([])
  const [orgOptions, setOrgOptions] = useState<OrgOption[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // 검색 + 제안 리스트 (열면 처음부터 목록 표시)
  const [search, setSearch] = useState('')
  const [activeIndex, setActiveIndex] = useState(-1)
  const suggestRef = useRef<HTMLDivElement>(null)

  // 새 참석자 인라인 폼
  const [mode, setMode] = useState<'search' | 'form'>('search')
  const [fName, setFName] = useState('')
  const [fOrganization, setFOrganization] = useState('')
  const [fDepartment, setFDepartment] = useState('')
  const [fRole, setFRole] = useState('')
  const [fEmail, setFEmail] = useState('')
  const [fPhone, setFPhone] = useState('')
  const [adding, setAdding] = useState(false)

  const resetForm = () => {
    setFName('')
    setFOrganization('')
    setFDepartment('')
    setFRole('')
    setFEmail('')
    setFPhone('')
  }

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError('')
    setSearch('')
    setActiveIndex(-1)
    setMode('search')
    resetForm()
    api
      .listParticipants()
      .then((list) => {
        if (!cancelled) setAll(list)
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : '참석자 목록을 불러오지 못했어요')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    api
      .listOrgOptions()
      .then((opts) => {
        if (!cancelled) setOrgOptions(opts)
      })
      .catch(() => {
        /* 목록을 못 불러와도 자유 입력은 계속 가능하므로 조용히 무시 */
      })
    return () => {
      cancelled = true
    }
  }, [open])

  // ---- 제안 계산: 미선택 참석자 중 이름/소속/부서/직책 부분일치 ----
  const query = search.trim().toLowerCase()
  const unselected = all.filter((p) => !selected.some((s) => s.id === p.id))
  const suggestions = query
    ? unselected.filter((p) =>
        [p.name, p.organization ?? '', p.department ?? '', p.role ?? ''].some((v) =>
          v.toLowerCase().includes(query),
        ),
      )
    : unselected // 검색 전에는 미선택 전체 표시 (리스트 자체가 스크롤)
  const addNewIndex = suggestions.length // 마지막 "+ 새 참석자로 추가" 항목

  // 검색어/제안 목록이 바뀌면 하이라이트 리셋 (검색 중엔 첫 항목)
  useEffect(() => {
    setActiveIndex(query ? 0 : -1)
  }, [query, suggestions.length])

  // 키보드 탐색 시 활성 항목이 보이도록 스크롤
  useEffect(() => {
    if (activeIndex < 0) return
    suggestRef.current
      ?.querySelector(`[data-idx="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const addToSelection = (p: Participant) => {
    if (selected.some((s) => s.id === p.id)) return
    onChange([...selected, p])
    setSearch('')
  }

  const removeFromSelection = (id: number) => {
    onChange(selected.filter((s) => s.id !== id))
  }

  const openForm = () => {
    setMode('form')
    setFName(search.trim())
    setError('')
  }

  const closeForm = () => {
    setMode('search')
    resetForm()
  }

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => (i + 1 > addNewIndex ? 0 : i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => (i - 1 < 0 ? addNewIndex : i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (activeIndex < 0) return
      if (activeIndex === addNewIndex) openForm()
      else if (suggestions[activeIndex]) addToSelection(suggestions[activeIndex])
    }
  }

  const sortNames = (list: OrgOption[]) =>
    list.map((o) => o.name).sort((a, b) => a.localeCompare(b, 'ko'))
  const organizationNames = sortNames(orgOptions.filter((o) => o.kind === 'organization'))
  const departmentNames = sortNames(orgOptions.filter((o) => o.kind === 'department'))
  const roleNames = sortNames(orgOptions.filter((o) => o.kind === 'role'))

  /** 콤보박스 "+ 추가" — org-options 사전에 등록 (중복 400은 조용히 무시) */
  const registerOrgOption = (kind: OrgKind) => (rawName: string) => {
    const name = rawName.trim()
    if (!name) return
    if (orgOptions.some((o) => o.kind === kind && o.name === name)) return
    api
      .createOrgOption({ kind, name })
      .then((created) => {
        setOrgOptions((prev) =>
          prev.some((o) => o.kind === kind && o.name === name) ? prev : [...prev, created],
        )
      })
      .catch(() => {
        /* 이미 등록돼 있어요(400) 등은 조용히 무시 */
      })
  }

  const handleAdd = async (e: FormEvent) => {
    e.preventDefault()
    const name = fName.trim()
    if (!name || adding) return
    setAdding(true)
    setError('')
    try {
      const organization = fOrganization.trim()
      const department = fDepartment.trim()
      const role = fRole.trim()
      const email = fEmail.trim()
      const phone = fPhone.trim()
      const created = await api.createParticipant({
        name,
        ...(organization ? { organization } : {}),
        ...(department ? { department } : {}),
        ...(role ? { role } : {}),
        ...(email ? { email } : {}),
        ...(phone ? { phone } : {}),
      })
      setAll((prev) => [...prev, created])
      onChange([...selected, created])
      closeForm()
      setSearch('')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '참석자를 추가하지 못했어요')
    } finally {
      setAdding(false)
    }
  }

  return (
    <Modal open={open} title="참석자 선택" width={520} onClose={onClose}>
      {error && <div className="pp-error">{error}</div>}

      {/* ---- 선택된 참석자 칩 (검색 인풋 위) ---- */}
      <div className="pp-selected">
        {selected.length === 0 ? (
          <span className="pp-selected-empty">
            선택된 참석자가 없어요. 아래 목록에서 선택하거나 검색해 보세요.
          </span>
        ) : (
          selected.map((p) => (
            <span
              key={p.id}
              className="pp-sel-chip"
              title={subText(p) || undefined}
              style={{
                borderColor: p.color,
                color: p.color,
                background: `color-mix(in srgb, ${p.color} 12%, transparent)`,
              }}
            >
              {p.name}
              {chipSub(p) && <span className="pp-sel-chip-sub">{chipSub(p)}</span>}
              <button
                type="button"
                className="pp-sel-chip-x"
                aria-label={`${p.name} 선택 해제`}
                onClick={() => removeFromSelection(p.id)}
              >
                ×
              </button>
            </span>
          ))
        )}
      </div>

      {mode === 'search' ? (
        <div className="pp-searchbox">
          <input
            className="input"
            type="search"
            placeholder="이름, 소속, 부서, 직책으로 검색"
            aria-label="참석자 검색"
            value={search}
            autoFocus
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={onSearchKeyDown}
          />

          {
            <div
              className="pp-suggest"
              ref={suggestRef}
              role="listbox"
              onMouseDown={(e) => e.preventDefault() /* 클릭 시 인풋 blur 방지 */}
            >
              {loading ? (
                <div className="pp-loading">
                  <span className="spinner" />
                </div>
              ) : (
                <>
                  {suggestions.map((p, i) => {
                    const sub = subText(p)
                    return (
                      <button
                        key={p.id}
                        type="button"
                        data-idx={i}
                        className={`pp-suggest-item${i === activeIndex ? ' active' : ''}`}
                        onClick={() => addToSelection(p)}
                        onMouseEnter={() => setActiveIndex(i)}
                      >
                        <Avatar name={p.name} color={p.color} size={30} />
                        <span className="pp-suggest-texts">
                          <span className="pp-suggest-name">{p.name}</span>
                          {sub && <span className="pp-suggest-sub">{sub}</span>}
                        </span>
                      </button>
                    )
                  })}

                  {suggestions.length === 0 && (
                    <p className="pp-suggest-empty">
                      {all.length === 0
                        ? '등록된 참석자가 없어요.'
                        : query
                          ? `‘${search.trim()}’ 검색 결과가 없어요.`
                          : '추가할 수 있는 참석자가 모두 선택됐어요.'}
                    </p>
                  )}

                  <button
                    type="button"
                    data-idx={addNewIndex}
                    className={`pp-suggest-new${activeIndex === addNewIndex ? ' active' : ''}`}
                    onClick={openForm}
                    onMouseEnter={() => setActiveIndex(addNewIndex)}
                  >
                    + {query ? `‘${search.trim()}’ 새 참석자로 추가` : '새 참석자 추가'}
                  </button>
                </>
              )}
            </div>
          }
        </div>
      ) : (
        <form className="pp-form" onSubmit={handleAdd}>
          <div className="pp-form-title">새 참석자 추가</div>
          <div className="pp-form-fields">
            <input
              className="input"
              placeholder="이름 *"
              aria-label="이름"
              value={fName}
              autoFocus
              onChange={(e) => setFName(e.target.value)}
            />
            <div className="pp-form-row">
              <ComboBox
                value={fOrganization}
                onChange={setFOrganization}
                options={organizationNames}
                placeholder="소속 (선택)"
                onCreateOption={registerOrgOption('organization')}
              />
              <ComboBox
                value={fDepartment}
                onChange={setFDepartment}
                options={departmentNames}
                placeholder="부서 (선택)"
                onCreateOption={registerOrgOption('department')}
              />
              <ComboBox
                value={fRole}
                onChange={setFRole}
                options={roleNames}
                placeholder="직책 (선택)"
                onCreateOption={registerOrgOption('role')}
              />
            </div>
            <div className="pp-form-row">
              <input
                className="input"
                type="email"
                placeholder="이메일 (선택)"
                aria-label="이메일"
                value={fEmail}
                onChange={(e) => setFEmail(e.target.value)}
              />
              <input
                className="input"
                type="tel"
                placeholder="전화번호 (선택)"
                aria-label="전화번호"
                value={fPhone}
                onChange={(e) => setFPhone(e.target.value)}
              />
            </div>
          </div>
          <div className="pp-form-actions">
            <button type="button" className="btn btn-ghost" onClick={closeForm} disabled={adding}>
              취소
            </button>
            <button type="submit" className="btn btn-primary" disabled={!fName.trim() || adding}>
              {adding ? '추가 중...' : '추가'}
            </button>
          </div>
        </form>
      )}

      <div className="pp-footer">
        <span className="muted">{selected.length}명 선택됨</span>
        <button type="button" className="btn btn-primary" onClick={onClose}>
          완료
        </button>
      </div>
    </Modal>
  )
}

export default ParticipantPicker
