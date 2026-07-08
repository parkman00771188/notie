import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { api } from '../api'
import ComboBox from '../components/ComboBox'
import { useConfirm } from '../components/confirm'
import Modal from '../components/Modal'
import type { OrgOption, Participant } from '../types'
import './UserManagementPage.css'
import './ParticipantManagementPage.css'

interface ParticipantDraft {
  name: string
  organization: string
  department: string
  role: string
  phone: string
  email: string
}

interface ParticipantGroup {
  key: string
  name: string
  color: string
  items: Participant[]
}

const EMPTY_DRAFT: ParticipantDraft = {
  name: '',
  organization: '',
  department: '',
  role: '',
  phone: '',
  email: '',
}

const NO_ORG_KEY = '__no_organization__'
const DEFAULT_ORG_COLOR = '#8b95a1'

const errMsg = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback)

const cleanPayload = (draft: ParticipantDraft) => ({
  name: draft.name.trim(),
  organization: draft.organization.trim() || undefined,
  department: draft.department.trim() || undefined,
  role: draft.role.trim() || undefined,
  phone: draft.phone.trim() || undefined,
  email: draft.email.trim() || undefined,
})

function toDraft(item: Participant): ParticipantDraft {
  return {
    name: item.name,
    organization: item.organization ?? '',
    department: item.department ?? '',
    role: item.role ?? '',
    phone: item.phone ?? '',
    email: item.email?.endsWith('@notie.local') ? '' : (item.email ?? ''),
  }
}

function SourceBadge({ item }: { item: Participant }) {
  const synced = item.source_user_id !== null && item.source_user_id !== undefined
  return (
    <span className={`participant-source-pill ${synced ? 'synced' : 'custom'}`}>
      <span className="participant-source-icon" aria-hidden="true">
        {synced ? (
          <svg viewBox="0 0 24 24" focusable="false">
            <circle cx="12" cy="8" r="3.1" />
            <path d="M5.5 19c.9-3.7 3.1-5.5 6.5-5.5s5.6 1.8 6.5 5.5" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" focusable="false">
            <path d="M12 5v14" />
            <path d="M5 12h14" />
          </svg>
        )}
      </span>
      {synced ? '사용자' : '직접 추가'}
    </span>
  )
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 7h16" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M6.5 7l.8 13h9.4l.8-13" />
      <path d="M9 7V4.8h6V7" />
    </svg>
  )
}

export default function ParticipantManagementPage() {
  const confirm = useConfirm()
  const [participants, setParticipants] = useState<Participant[] | null>(null)
  const [orgOptions, setOrgOptions] = useState<OrgOption[]>([])
  const [error, setError] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Participant | null>(null)
  const [draft, setDraft] = useState<ParticipantDraft>(EMPTY_DRAFT)
  const [saving, setSaving] = useState(false)
  const [sort, setSort] = useState<'name' | 'department'>('name')
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})

  useEffect(() => {
    let alive = true
    api
      .listParticipants()
      .then((list) => {
        if (alive) setParticipants(list)
      })
      .catch((err: unknown) => {
        if (alive) {
          setParticipants([])
          setError(errMsg(err, '참여자 목록을 불러오지 못했습니다.'))
        }
      })
    api
      .listOrgOptions()
      .then((list) => {
        if (alive) setOrgOptions(list)
      })
      .catch(() => {
        if (alive) setOrgOptions([])
      })
    return () => {
      alive = false
    }
  }, [])

  const organizationOptions = useMemo(
    () =>
      orgOptions
        .filter((option) => option.kind === 'organization')
        .sort((a, b) => a.name.localeCompare(b.name, 'ko')),
    [orgOptions],
  )

  const organizationNames = useMemo(() => organizationOptions.map((option) => option.name), [organizationOptions])
  const departmentNames = useMemo(
    () =>
      orgOptions
        .filter((option) => option.kind === 'department')
        .map((option) => option.name)
        .sort((a, b) => a.localeCompare(b, 'ko')),
    [orgOptions],
  )
  const roleNames = useMemo(
    () =>
      orgOptions
        .filter((option) => option.kind === 'role')
        .map((option) => option.name)
        .sort((a, b) => a.localeCompare(b, 'ko')),
    [orgOptions],
  )

  const sortedParticipants = useMemo(() => {
    const list = [...(participants ?? [])]
    return list.sort((a, b) => {
      if (sort === 'department') {
        const left = `${a.department ?? ''}${a.name}`
        const right = `${b.department ?? ''}${b.name}`
        return left.localeCompare(right, 'ko')
      }
      return a.name.localeCompare(b.name, 'ko')
    })
  }, [participants, sort])

  const stats = useMemo(() => {
    const list = participants ?? []
    return {
      total: list.length,
      synced: list.filter((item) => item.source_user_id !== null && item.source_user_id !== undefined).length,
      custom: list.filter((item) => item.source_user_id === null || item.source_user_id === undefined).length,
    }
  }, [participants])

  const organizationColor = (name: string | null | undefined) => {
    if (!name) return DEFAULT_ORG_COLOR
    return organizationOptions.find((option) => option.name === name)?.color ?? DEFAULT_ORG_COLOR
  }

  const groups = useMemo<ParticipantGroup[]>(() => {
    const byOrg = new Map<string, Participant[]>()
    for (const item of sortedParticipants) {
      const key = (item.organization ?? '').trim()
      const list = byOrg.get(key)
      if (list) list.push(item)
      else byOrg.set(key, [item])
    }

    const registered = organizationOptions.map((option) => option.name)
    const unknown = [...byOrg.keys()]
      .filter((key) => key !== '' && !organizationOptions.some((option) => option.name === key))
      .sort((a, b) => a.localeCompare(b, 'ko'))
    const keys = [...registered, ...unknown]
    if (byOrg.has('')) keys.push('')

    return keys.map((key) => ({
      key: key || NO_ORG_KEY,
      name: key || '소속 미지정',
      color: organizationColor(key),
      items: byOrg.get(key) ?? [],
    }))
  }, [organizationOptions, sortedParticipants])

  const indexById = useMemo(
    () => new Map(sortedParticipants.map((item, index) => [item.id, index + 1])),
    [sortedParticipants],
  )

  const setField = <K extends keyof ParticipantDraft>(key: K, value: ParticipantDraft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const openCreate = () => {
    setEditing(null)
    setDraft(EMPTY_DRAFT)
    setError('')
    setModalOpen(true)
  }

  const openEdit = (item: Participant) => {
    if (item.source_user_id !== null && item.source_user_id !== undefined) return
    setEditing(item)
    setDraft(toDraft(item))
    setError('')
    setModalOpen(true)
  }

  const closeModal = () => {
    if (saving) return
    setModalOpen(false)
    setEditing(null)
    setDraft(EMPTY_DRAFT)
  }

  const saveParticipant = async (event: FormEvent) => {
    event.preventDefault()
    if (saving || !draft.name.trim()) return
    setSaving(true)
    setError('')
    try {
      if (editing) {
        const updated = await api.updateParticipant(editing.id, cleanPayload(draft))
        setParticipants((prev) => (prev ?? []).map((item) => (item.id === updated.id ? updated : item)))
      } else {
        const created = await api.createParticipant(cleanPayload(draft))
        setParticipants((prev) => [...(prev ?? []), created])
      }
      setModalOpen(false)
      setEditing(null)
      setDraft(EMPTY_DRAFT)
    } catch (err: unknown) {
      setError(errMsg(err, '참여자 정보를 저장하지 못했습니다.'))
    } finally {
      setSaving(false)
    }
  }

  const deleteParticipant = async (item: Participant) => {
    if (item.source_user_id !== null && item.source_user_id !== undefined) return
    const ok = await confirm({
      title: `${item.name} 참여자를 삭제할까요?`,
      message: '참여자 사전에서만 제거됩니다. 기존 회의 기록에 이미 표시된 참석자 정보는 유지됩니다.',
      confirmLabel: '삭제',
      danger: true,
    })
    if (!ok) return
    setError('')
    try {
      await api.deleteParticipant(item.id)
      setParticipants((prev) => (prev ?? []).filter((target) => target.id !== item.id))
    } catch (err: unknown) {
      setError(errMsg(err, '참여자를 삭제하지 못했습니다.'))
    }
  }

  const renderRow = (item: Participant) => {
    const synced = item.source_user_id !== null && item.source_user_id !== undefined
    return (
      <tr key={item.id}>
        <td>{indexById.get(item.id) ?? '-'}</td>
        <td>
          <SourceBadge item={item} />
        </td>
        <td>
          <div className="user-name-cell">
            <strong>{item.name}</strong>
          </div>
        </td>
        <td className={item.source_username ? 'user-id-cell' : undefined}>{item.source_username || '-'}</td>
        <td>{item.organization || '-'}</td>
        <td>{item.department || '-'}</td>
        <td>{item.role || '-'}</td>
        <td>{item.phone || '-'}</td>
        <td>{item.email?.endsWith('@notie.local') ? '-' : item.email || '-'}</td>
        <td>
          <div className="user-row-actions participant-row-actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={synced}
              title={synced ? '사용자 관리에서 수정되는 항목입니다.' : '수정'}
              onClick={() => openEdit(item)}
            >
              수정
            </button>
            <button
              type="button"
              className="btn-icon user-delete-btn"
              disabled={synced}
              title={synced ? '사용자 계정에서 동기화된 참여자는 삭제할 수 없습니다.' : '삭제'}
              aria-label={`${item.name} 참여자 삭제`}
              onClick={() => void deleteParticipant(item)}
            >
              <TrashIcon />
            </button>
          </div>
        </td>
      </tr>
    )
  }

  return (
    <div className="page user-admin-page participant-admin-page">
      <div className="user-admin-head">
        <div>
          <h1 className="page-title">참여자 관리</h1>
          <p className="user-admin-subtitle">
            회의 목록과 회의 기록에서 선택할 참여자를 미리 저장하고 관리합니다.
          </p>
        </div>
        <div className="user-admin-head-actions">
          <button type="button" className="btn btn-primary" onClick={openCreate}>
            참여자 추가
          </button>
        </div>
      </div>

      <div className="user-admin-stats" aria-label="참여자 현황">
        <div>
          <span>전체</span>
          <strong>{stats.total}</strong>
        </div>
        <div>
          <span>사용자 동기화</span>
          <strong>{stats.synced}</strong>
        </div>
        <div>
          <span>직접 추가</span>
          <strong>{stats.custom}</strong>
        </div>
      </div>

      <section className="user-admin-section">
        <div className="user-admin-toolbar">
          <span className="user-admin-toolbar-label">정렬 기준</span>
          <div className="user-admin-sort">
            <button
              type="button"
              className={`btn ${sort === 'name' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setSort('name')}
            >
              이름순
            </button>
            <button
              type="button"
              className={`btn ${sort === 'department' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setSort('department')}
            >
              부서순
            </button>
          </div>
        </div>

        {error && <div className="user-admin-error">{error}</div>}

        {participants === null ? (
          <div className="user-admin-loading">
            <span className="spinner" />
          </div>
        ) : groups.length === 0 ? (
          <div className="card user-admin-empty-card">
            <div className="user-admin-empty">등록된 참여자가 없습니다.</div>
          </div>
        ) : (
          <div className="user-org-groups">
            {groups.map((group) => {
              const isCollapsed = !!collapsedGroups[group.key]
              return (
                <div key={group.key} className="card user-org-group">
                  <button
                    type="button"
                    className="user-org-head"
                    aria-expanded={!isCollapsed}
                    onClick={() => toggleGroup(group.key)}
                  >
                    <span className={`user-org-caret${isCollapsed ? '' : ' open'}`}>›</span>
                    <span className="user-org-dot" style={{ background: group.color }} />
                    <span className="user-org-name">{group.name}</span>
                    <span className="user-org-count">{group.items.length}명</span>
                  </button>
                  {!isCollapsed && (
                    <div className="user-admin-table-wrap user-org-table-wrap">
                      <table className="user-admin-table participant-admin-table">
                        <colgroup>
                          <col className="participant-col-index" />
                          <col className="participant-col-source" />
                          <col className="participant-col-name" />
                          <col className="participant-col-username" />
                          <col className="participant-col-organization" />
                          <col className="participant-col-department" />
                          <col className="participant-col-role" />
                          <col className="participant-col-phone" />
                          <col className="participant-col-email" />
                          <col className="participant-col-actions" />
                        </colgroup>
                        <thead>
                          <tr>
                            <th>순번</th>
                            <th>구분</th>
                            <th>이름</th>
                            <th>사용자 ID</th>
                            <th>소속</th>
                            <th>부서</th>
                            <th>직책</th>
                            <th>전화</th>
                            <th>이메일</th>
                            <th>관리</th>
                          </tr>
                        </thead>
                        <tbody>
                          {group.items.length > 0 ? (
                            group.items.map(renderRow)
                          ) : (
                            <tr className="user-admin-empty-row">
                              <td colSpan={10}>이 소속에는 등록된 참여자가 없습니다.</td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>

      <Modal
        open={modalOpen}
        title={editing ? '참여자 수정' : '참여자 추가'}
        width={780}
        onClose={closeModal}
      >
        <form className="user-form" onSubmit={saveParticipant}>
          <div className="user-form-grid">
            <label className="user-form-field">
              <span>이름 *</span>
              <input
                className="input"
                value={draft.name}
                onChange={(event) => setField('name', event.target.value)}
                placeholder="참여자 이름을 입력해주세요"
                required
              />
            </label>
            <label className="user-form-field">
              <span>소속</span>
              <ComboBox
                value={draft.organization}
                onChange={(value) => setField('organization', value)}
                options={organizationNames}
                placeholder="소속"
              />
            </label>
            <label className="user-form-field">
              <span>부서</span>
              <ComboBox
                value={draft.department}
                onChange={(value) => setField('department', value)}
                options={departmentNames}
                placeholder="부서"
              />
            </label>
            <label className="user-form-field">
              <span>직책</span>
              <ComboBox
                value={draft.role}
                onChange={(value) => setField('role', value)}
                options={roleNames}
                placeholder="직책"
              />
            </label>
            <label className="user-form-field">
              <span>전화</span>
              <input
                className="input"
                value={draft.phone}
                onChange={(event) => setField('phone', event.target.value)}
                placeholder="010-0000-0000"
              />
            </label>
            <label className="user-form-field">
              <span>이메일</span>
              <input
                className="input"
                type="email"
                value={draft.email}
                onChange={(event) => setField('email', event.target.value)}
                placeholder="name@example.com"
              />
            </label>
          </div>

          <div className="user-form-actions">
            <button type="button" className="btn btn-ghost" onClick={closeModal} disabled={saving}>
              취소
            </button>
            <button type="submit" className="btn btn-primary" disabled={!draft.name.trim() || saving}>
              {saving ? '저장 중...' : '저장'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
