import { useEffect, useId, useState } from 'react'
import type { FormEvent, MouseEvent } from 'react'
import { api } from '../api'
import type { OrgOption, Participant } from '../types'
import Modal from './Modal'
import './components.css'
import './ParticipantPicker.css'

export interface ParticipantPickerProps {
  open: boolean
  onClose: () => void
  selected: Participant[]
  onChange: (p: Participant[]) => void
}

export function ParticipantPicker({ open, onClose, selected, onChange }: ParticipantPickerProps) {
  const [all, setAll] = useState<Participant[]>([])
  const [orgOptions, setOrgOptions] = useState<OrgOption[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [name, setName] = useState('')
  const [department, setDepartment] = useState('')
  const [role, setRole] = useState('')
  const [adding, setAdding] = useState(false)
  const deptListId = useId()
  const roleListId = useId()

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError('')
    setSearch('')
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

  const isSelected = (id: number) => selected.some((p) => p.id === id)

  const toggle = (p: Participant) => {
    if (isSelected(p.id)) {
      onChange(selected.filter((s) => s.id !== p.id))
    } else {
      onChange([...selected, p])
    }
  }

  const query = search.trim().toLowerCase()
  const filtered = query
    ? all.filter((p) =>
        [p.name, p.department ?? '', p.role ?? ''].some((v) =>
          v.toLowerCase().includes(query),
        ),
      )
    : all

  const departments = orgOptions.filter((o) => o.kind === 'department')
  const roles = orgOptions.filter((o) => o.kind === 'role')

  /** 자유 입력한 소속/직책을 org-options 사전에 자동 등록 (중복 400은 조용히 무시) */
  const registerOrgOption = async (kind: 'department' | 'role', value: string) => {
    if (!value) return
    if (orgOptions.some((o) => o.kind === kind && o.name === value)) return
    try {
      const created = await api.createOrgOption({ kind, name: value })
      setOrgOptions((prev) => [...prev, created])
    } catch {
      /* 이미 등록돼 있어요(400) 등은 조용히 무시 */
    }
  }

  const handleAdd = async (e: FormEvent) => {
    e.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName || adding) return
    setAdding(true)
    setError('')
    try {
      const trimmedDept = department.trim()
      const trimmedRole = role.trim()
      const created = await api.createParticipant({
        name: trimmedName,
        ...(trimmedDept ? { department: trimmedDept } : {}),
        ...(trimmedRole ? { role: trimmedRole } : {}),
      })
      setAll((prev) => [...prev, created])
      onChange([...selected, created])
      await Promise.all([
        registerOrgOption('department', trimmedDept),
        registerOrgOption('role', trimmedRole),
      ])
      setName('')
      setDepartment('')
      setRole('')
      setSearch('')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '참석자를 추가하지 못했어요')
    } finally {
      setAdding(false)
    }
  }

  const handleDelete = async (p: Participant, e: MouseEvent) => {
    e.stopPropagation()
    if (!window.confirm(`'${p.name}' 참석자를 디렉터리에서 삭제할까요?`)) return
    setError('')
    try {
      await api.deleteParticipant(p.id)
      setAll((prev) => prev.filter((x) => x.id !== p.id))
      if (isSelected(p.id)) {
        onChange(selected.filter((s) => s.id !== p.id))
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '참석자를 삭제하지 못했어요')
    }
  }

  return (
    <Modal open={open} title="참석자 선택" width={520} onClose={onClose}>
      {error && <div className="pp-error">{error}</div>}

      <div className="pp-search">
        <input
          className="input"
          type="search"
          placeholder="이름, 소속, 직책으로 검색"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {loading ? (
        <div className="pp-loading">
          <span className="spinner" />
        </div>
      ) : all.length === 0 ? (
        <p className="pp-empty">등록된 참석자가 없어요. 아래에서 새 참석자를 추가해보세요.</p>
      ) : filtered.length === 0 ? (
        <p className="pp-no-result">‘{search.trim()}’ 검색 결과가 없어요.</p>
      ) : (
        <div className="pp-chips">
          {filtered.map((p) => {
            const sel = isSelected(p.id)
            const tooltip = [p.department, p.role].filter(Boolean).join(' · ')
            return (
              <button
                key={p.id}
                type="button"
                className="pp-chip"
                aria-pressed={sel}
                title={tooltip || undefined}
                style={{
                  borderColor: p.color,
                  color: p.color,
                  background: sel
                    ? `color-mix(in srgb, ${p.color} 15%, transparent)`
                    : undefined,
                }}
                onClick={() => toggle(p)}
              >
                {sel && <span className="pp-chip-check">✓</span>}
                <span>{p.name}</span>
                {p.role && <span className="pp-chip-role">{p.role}</span>}
                <span
                  className="pp-chip-x"
                  role="button"
                  aria-label={`${p.name} 삭제`}
                  title="디렉터리에서 삭제"
                  onClick={(e) => handleDelete(p, e)}
                >
                  ×
                </span>
              </button>
            )
          })}
        </div>
      )}

      <form className="pp-add" onSubmit={handleAdd}>
        <div className="pp-add-title">새 참석자 추가</div>
        <div className="pp-add-fields">
          <div className="pp-add-row">
            <input
              className="input"
              placeholder="이름"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="pp-add-row">
            <input
              className="input"
              placeholder="소속 (선택)"
              list={deptListId}
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
            />
            <datalist id={deptListId}>
              {departments.map((o) => (
                <option key={o.id} value={o.name} />
              ))}
            </datalist>
            <input
              className="input"
              placeholder="직책 (선택)"
              list={roleListId}
              value={role}
              onChange={(e) => setRole(e.target.value)}
            />
            <datalist id={roleListId}>
              {roles.map((o) => (
                <option key={o.id} value={o.name} />
              ))}
            </datalist>
            <button type="submit" className="btn btn-primary" disabled={!name.trim() || adding}>
              {adding ? '추가 중...' : '추가'}
            </button>
          </div>
        </div>
      </form>

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
