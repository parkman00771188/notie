import { useEffect, useState } from 'react'
import type { FormEvent, MouseEvent } from 'react'
import { api } from '../api'
import type { Participant } from '../types'
import Modal from './Modal'
import './components.css'

export interface ParticipantPickerProps {
  open: boolean
  onClose: () => void
  selected: Participant[]
  onChange: (p: Participant[]) => void
}

export function ParticipantPicker({ open, onClose, selected, onChange }: ParticipantPickerProps) {
  const [all, setAll] = useState<Participant[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError('')
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

  const handleAdd = async (e: FormEvent) => {
    e.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName || adding) return
    setAdding(true)
    setError('')
    try {
      const trimmedRole = role.trim()
      const created = await api.createParticipant(
        trimmedRole ? { name: trimmedName, role: trimmedRole } : { name: trimmedName },
      )
      setAll((prev) => [...prev, created])
      onChange([...selected, created])
      setName('')
      setRole('')
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

      {loading ? (
        <div className="pp-loading">
          <span className="spinner" />
        </div>
      ) : all.length === 0 ? (
        <p className="pp-empty">등록된 참석자가 없어요. 아래에서 새 참석자를 추가해보세요.</p>
      ) : (
        <div className="pp-chips">
          {all.map((p) => {
            const sel = isSelected(p.id)
            return (
              <button
                key={p.id}
                type="button"
                className="pp-chip"
                aria-pressed={sel}
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
        <div className="pp-add-row">
          <input
            className="input"
            placeholder="이름"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="input"
            placeholder="직함/역할 (선택)"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          />
          <button type="submit" className="btn btn-primary" disabled={!name.trim() || adding}>
            {adding ? '추가 중...' : '추가'}
          </button>
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
