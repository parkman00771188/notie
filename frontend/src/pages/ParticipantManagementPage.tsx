import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { api } from '../api'
import Avatar from '../components/Avatar'
import ComboBox from '../components/ComboBox'
import { useConfirm } from '../components/confirm'
import Modal from '../components/Modal'
import type { OrgKind, OrgOption, Participant } from '../types'
import './UserManagementPage.css'
import './ParticipantManagementPage.css'

interface ParticipantDraft {
  name: string
  organization: string
  department: string
  role: string
  phone: string
  email: string
  color: string
}

interface ParticipantGroup {
  key: string
  name: string
  color: string
  items: Participant[]
}

const ORG_OPTION_GROUPS: { kind: OrgKind; label: string }[] = [
  { kind: 'organization', label: '소속' },
  { kind: 'department', label: '부서' },
  { kind: 'role', label: '직책' },
]

const ORG_PARTICIPANT_FIELD: Record<OrgKind, 'organization' | 'department' | 'role'> = {
  organization: 'organization',
  department: 'department',
  role: 'role',
}

const EMPTY_DRAFT: ParticipantDraft = {
  name: '',
  organization: '',
  department: '',
  role: '',
  phone: '',
  email: '',
  color: '#2563eb',
}

const NO_ORG_KEY = '__no_organization__'
const DEFAULT_ORG_COLOR = '#8b95a1'
const PARTICIPANT_COLORS = [
  '#2563eb',
  '#e8590c',
  '#0ca678',
  '#7048e8',
  '#d6336c',
  '#f08c00',
  '#1098ad',
  '#5f3dc4',
]

const errMsg = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback)

const sortOrgOptions = (list: OrgOption[]) =>
  [...list].sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name, 'ko') : a.kind.localeCompare(b.kind),
  )

const cleanPayload = (draft: ParticipantDraft) => ({
  name: draft.name.trim(),
  organization: draft.organization.trim() || undefined,
  department: draft.department.trim() || undefined,
  role: draft.role.trim() || undefined,
  phone: draft.phone.trim() || undefined,
  email: draft.email.trim() || undefined,
  color: draft.color,
})

function toDraft(item: Participant): ParticipantDraft {
  return {
    name: item.name,
    organization: item.organization ?? '',
    department: item.department ?? '',
    role: item.role ?? '',
    phone: item.phone ?? '',
    email: item.email?.endsWith('@notie.local') ? '' : (item.email ?? ''),
    color: item.color,
  }
}

interface ParticipantColorPickerProps {
  value: string
  onChange: (color: string) => void
  compact?: boolean
  ariaLabel?: string
}

function ParticipantColorPicker({
  value,
  onChange,
  compact = false,
  ariaLabel = '참여자 색 선택',
}: ParticipantColorPickerProps) {
  const isCustom = !PARTICIPANT_COLORS.includes(value)
  return (
    <div className={`participant-color-picker${compact ? ' compact' : ''}`} role="group" aria-label={ariaLabel}>
      {PARTICIPANT_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          className={`participant-color-swatch${value === color ? ' selected' : ''}`}
          style={{ background: color }}
          aria-label={`색상 ${color}`}
          aria-pressed={value === color}
          onClick={() => onChange(color)}
        />
      ))}
      <label
        className={`participant-color-swatch participant-color-custom${isCustom ? ' selected' : ''}`}
        style={isCustom ? { background: value } : undefined}
        title="원하는 색 직접 선택"
      >
        <input
          type="color"
          value={isCustom ? value : PARTICIPANT_COLORS[0]}
          onChange={(event) => onChange(event.target.value)}
          aria-label="커스텀 색 선택"
        />
      </label>
    </div>
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

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m4 20 4.2-1.1L19.1 8a2.1 2.1 0 0 0 0-3l-.1-.1a2.1 2.1 0 0 0-3 0L5.1 15.8 4 20Z" />
      <path d="m14.5 6.5 3 3" />
    </svg>
  )
}

function BuildingIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4.5 20V5.8a1.8 1.8 0 0 1 1.8-1.8h7.4a1.8 1.8 0 0 1 1.8 1.8V20" />
      <path d="M15.5 9h2.2a1.8 1.8 0 0 1 1.8 1.8V20" />
      <path d="M8 8h.01M12 8h.01M8 12h.01M12 12h.01M8 16h.01M12 16h.01" />
      <path d="M3 20h18" />
    </svg>
  )
}

function UsersIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M16 20v-1.6c0-1.8-1.5-3.3-3.3-3.3H7.3C5.5 15.1 4 16.6 4 18.4V20" />
      <circle cx="10" cy="7.5" r="3.3" />
      <path d="M20 20v-1.3c0-1.5-.9-2.8-2.2-3.3" />
      <path d="M16.3 4.4a3.3 3.3 0 0 1 0 6.2" />
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
  const [selectedGroupKey, setSelectedGroupKey] = useState<string | null>(null)
  const [orgManageOpen, setOrgManageOpen] = useState(false)
  const [orgManageTab, setOrgManageTab] = useState<OrgKind>('organization')
  const [orgManageError, setOrgManageError] = useState('')
  const [orgDrafts, setOrgDrafts] = useState<Record<OrgKind, string>>({
    organization: '',
    department: '',
    role: '',
  })
  const [orgDraftColor, setOrgDraftColor] = useState(PARTICIPANT_COLORS[0])
  const [orgSavingKind, setOrgSavingKind] = useState<OrgKind | null>(null)
  const [orgEditing, setOrgEditing] = useState<{ id: number; name: string } | null>(null)

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
        if (alive) setOrgOptions(sortOrgOptions(list))
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
    return list.sort((a, b) => a.name.localeCompare(b.name, 'ko'))
  }, [participants])

  const organizationColor = (name: string | null | undefined) => {
    if (!name) return DEFAULT_ORG_COLOR
    return organizationOptions.find((option) => option.name === name)?.color ?? DEFAULT_ORG_COLOR
  }

  const participantColor = (item: Participant) => {
    if (!item.organization) return item.color
    return organizationOptions.find((option) => option.name === item.organization)?.color ?? item.color
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

  useEffect(() => {
    if (participants === null) return
    if (groups.length === 0) {
      setSelectedGroupKey(null)
      return
    }
    if (!selectedGroupKey || !groups.some((group) => group.key === selectedGroupKey)) {
      setSelectedGroupKey(groups[0].key)
    }
  }, [groups, participants, selectedGroupKey])

  const selectedGroup =
    selectedGroupKey === null ? null : groups.find((group) => group.key === selectedGroupKey) ?? null

  const setField = <K extends keyof ParticipantDraft>(key: K, value: ParticipantDraft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  const setOrgDraft = (kind: OrgKind, value: string) => {
    setOrgDrafts((prev) => ({ ...prev, [kind]: value }))
  }

  const openOrgManage = () => {
    setOrgManageError('')
    setOrgManageOpen(true)
  }

  const closeOrgManage = () => {
    if (orgSavingKind) return
    setOrgManageOpen(false)
    setOrgManageError('')
    setOrgEditing(null)
  }

  const createOrgOption = async (kind: OrgKind, rawName: string, colorOverride?: string) => {
    const name = rawName.trim()
    if (!name) return null
    const existing = orgOptions.find((option) => option.kind === kind && option.name === name)
    if (existing) return existing

    setOrgSavingKind(kind)
    setOrgManageError('')
    try {
      const orgCount = orgOptions.filter((option) => option.kind === 'organization').length
      const color =
        kind === 'organization'
          ? colorOverride || PARTICIPANT_COLORS[orgCount % PARTICIPANT_COLORS.length]
          : undefined
      const created = await api.createOrgOption(color ? { kind, name, color } : { kind, name })
      setOrgOptions((prev) => sortOrgOptions([...prev, created]))
      return created
    } catch (err: unknown) {
      setOrgManageError(errMsg(err, '항목을 추가하지 못했습니다.'))
      return null
    } finally {
      setOrgSavingKind(null)
    }
  }

  const addOrgOption = async (kind: OrgKind) => {
    const created = await createOrgOption(
      kind,
      orgDrafts[kind],
      kind === 'organization' ? orgDraftColor : undefined,
    )
    if (created) setOrgDraft(kind, '')
  }

  const updateOrgOptionColor = async (option: OrgOption, color: string) => {
    setOrgManageError('')
    try {
      const updated = await api.updateOrgOption(option.id, { color })
      setOrgOptions((prev) => sortOrgOptions(prev.map((item) => (item.id === updated.id ? updated : item))))
    } catch (err: unknown) {
      setOrgManageError(errMsg(err, '소속 색상을 저장하지 못했습니다.'))
    }
  }

  const saveOrgOptionName = async (option: OrgOption) => {
    if (orgEditing?.id !== option.id) return
    const name = orgEditing.name.trim()
    if (!name) {
      setOrgManageError('이름을 입력해주세요.')
      return
    }
    if (name === option.name) {
      setOrgEditing(null)
      return
    }

    const oldName = option.name
    const field = ORG_PARTICIPANT_FIELD[option.kind]
    setOrgSavingKind(option.kind)
    setOrgManageError('')
    try {
      const updated = await api.updateOrgOption(option.id, { name })
      setOrgOptions((prev) => sortOrgOptions(prev.map((item) => (item.id === updated.id ? updated : item))))
      setParticipants((prev) =>
        (prev ?? []).map((item) => (item[field] === oldName ? { ...item, [field]: updated.name } : item)),
      )
      setDraft((prev) => (prev[field] === oldName ? { ...prev, [field]: updated.name } : prev))
      setOrgEditing(null)
    } catch (err: unknown) {
      setOrgManageError(errMsg(err, '항목 이름을 수정하지 못했습니다.'))
    } finally {
      setOrgSavingKind(null)
    }
  }

  const deleteOrgOption = async (option: OrgOption) => {
    const ok = await confirm({
      title: `'${option.name}' 항목을 삭제할까요?`,
      message: '선택 목록에서만 삭제되며, 이미 참여자 정보에 입력된 값은 그대로 유지됩니다.',
      confirmLabel: '삭제',
      danger: true,
    })
    if (!ok) return
    setOrgManageError('')
    try {
      await api.deleteOrgOption(option.id)
      setOrgOptions((prev) => prev.filter((item) => item.id !== option.id))
      if (orgEditing?.id === option.id) setOrgEditing(null)
    } catch (err: unknown) {
      setOrgManageError(errMsg(err, '항목을 삭제하지 못했습니다.'))
    }
  }

  const openCreate = () => {
    setEditing(null)
    const nextColor = PARTICIPANT_COLORS[(participants?.length ?? 0) % PARTICIPANT_COLORS.length]
    setDraft({
      ...EMPTY_DRAFT,
      organization: selectedGroup && selectedGroup.key !== NO_ORG_KEY ? selectedGroup.name : '',
      color: nextColor,
    })
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

  const activeOrgManageGroup =
    ORG_OPTION_GROUPS.find((group) => group.kind === orgManageTab) ?? ORG_OPTION_GROUPS[0]
  const activeOrgManageOptions = orgOptions.filter((option) => option.kind === activeOrgManageGroup.kind)

  const renderRow = (item: Participant, index: number) => {
    const synced = item.source_user_id !== null && item.source_user_id !== undefined
    return (
      <tr key={item.id}>
        <td>{index}</td>
        <td>
          <div className="participant-name-cell">
            <Avatar name={item.name} color={participantColor(item)} size={28} />
            <strong>{item.name}</strong>
          </div>
        </td>
        <td>{item.department || '-'}</td>
        <td>{item.role || '-'}</td>
        <td>{item.email?.endsWith('@notie.local') ? '-' : item.email || '-'}</td>
        <td>
          <div className="user-row-actions participant-row-actions">
            <button
              type="button"
              className="btn-icon participant-edit-btn"
              disabled={synced}
              title={synced ? '사용자 관리에서 수정되는 항목입니다.' : '수정'}
              aria-label={`${item.name} 참여자 수정`}
              onClick={() => openEdit(item)}
            >
              <PencilIcon />
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

      <section className="participant-directory-section">
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
          <div className="participant-directory-layout">
            <aside className="card participant-org-list-card" aria-label="소속 목록">
              <div className="participant-org-list-head">
                <div className="participant-org-list-title">
                  <span className="participant-org-list-icon">
                    <BuildingIcon />
                  </span>
                  <div>
                    <strong>소속</strong>
                    <small>{groups.length}개 그룹</small>
                  </div>
                </div>
                <button
                  type="button"
                  className="participant-org-manage-btn"
                  onClick={openOrgManage}
                  title="소속/부서/직책 관리"
                >
                  관리
                </button>
              </div>
              <div className="participant-org-list">
                {groups.map((group) => (
                  <button
                    key={group.key}
                    type="button"
                    className={`participant-org-item${selectedGroup?.key === group.key ? ' active' : ''}`}
                    onClick={() => setSelectedGroupKey(group.key)}
                  >
                    <span className="participant-org-dot" style={{ background: group.color }} />
                    <span className="participant-org-item-text">
                      <strong>{group.name}</strong>
                      <small>{group.items.length}명 등록</small>
                    </span>
                    <span className="participant-org-count">{group.items.length}</span>
                  </button>
                ))}
              </div>
            </aside>

            <section className="card participant-detail-card" aria-label="소속별 참여자 목록">
              {selectedGroup ? (
                <>
                  <div className="participant-detail-top">
                    <div className="participant-detail-title">
                      <span className="participant-detail-icon">
                        <UsersIcon />
                      </span>
                      <div>
                        <h2>{selectedGroup.name}</h2>
                        <p>이 소속에 등록된 참여자 {selectedGroup.items.length}명</p>
                      </div>
                    </div>
                    <div className="participant-detail-actions">
                      <button type="button" className="btn btn-primary" onClick={openCreate}>
                        + 추가
                      </button>
                    </div>
                  </div>

                  <div className="participant-detail-body">
                    <div className="user-admin-table-wrap participant-table-wrap">
                      <table className="user-admin-table participant-admin-table">
                        <colgroup>
                          <col className="participant-col-index" />
                          <col className="participant-col-name" />
                          <col className="participant-col-department" />
                          <col className="participant-col-role" />
                          <col className="participant-col-email" />
                          <col className="participant-col-actions" />
                        </colgroup>
                        <thead>
                          <tr>
                            <th>순번</th>
                            <th>이름</th>
                            <th>부서</th>
                            <th>직책</th>
                            <th>이메일</th>
                            <th>관리</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedGroup.items.length > 0 ? (
                            selectedGroup.items.map((item, index) => renderRow(item, index + 1))
                          ) : (
                            <tr className="user-admin-empty-row">
                              <td colSpan={6}>이 소속에는 등록된 참여자가 없습니다.</td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              ) : (
                <div className="participant-detail-empty">
                  <UsersIcon />
                  <strong>선택된 소속이 없습니다.</strong>
                  <span>소속을 선택하면 참여자 목록이 표시됩니다.</span>
                </div>
              )
              }
            </section>
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
            <div className="user-form-field participant-color-field">
              <span>참여자 색상</span>
              <div className="participant-color-row">
                <Avatar name={draft.name || '참'} color={draft.color} size={30} />
                <ParticipantColorPicker value={draft.color} onChange={(color) => setField('color', color)} />
              </div>
            </div>
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

      <Modal
        open={orgManageOpen}
        title="소속 · 부서 · 직책 관리"
        width={900}
        onClose={closeOrgManage}
      >
        <div className="org-manage-modal">
          <p className="org-manage-desc">
            참여자 추가/수정 폼에서 선택할 목록을 관리합니다. 목록에서 삭제해도 이미 저장된 참여자 정보는 유지됩니다.
          </p>
          {orgManageError && <div className="user-admin-error org-manage-error">{orgManageError}</div>}

          <div className="org-manage-layout">
            <nav className="org-manage-tabs" aria-label="참여자 소속 정보 관리">
              {ORG_OPTION_GROUPS.map((group) => (
                <button
                  key={group.kind}
                  type="button"
                  className={`org-manage-tab${orgManageTab === group.kind ? ' active' : ''}`}
                  onClick={() => {
                    setOrgManageTab(group.kind)
                    setOrgEditing(null)
                  }}
                >
                  <span className="org-manage-tab-icon" aria-hidden="true">
                    {group.kind === 'organization' ? '🏢' : group.kind === 'department' ? '🧩' : '💼'}
                  </span>
                  {group.label}
                </button>
              ))}
            </nav>

            <section className="org-manage-panel">
              <div className="org-manage-panel-head">
                <h3>{activeOrgManageGroup.label}</h3>
                {activeOrgManageGroup.kind === 'organization' && (
                  <span className="org-manage-panel-badge">색상 지정</span>
                )}
              </div>

              <form
                className="org-manage-add"
                onSubmit={(event) => {
                  event.preventDefault()
                  void addOrgOption(activeOrgManageGroup.kind)
                }}
              >
                <input
                  className="input"
                  value={orgDrafts[activeOrgManageGroup.kind]}
                  onChange={(event) => setOrgDraft(activeOrgManageGroup.kind, event.target.value)}
                  placeholder={`${activeOrgManageGroup.label} 추가`}
                />
                {activeOrgManageGroup.kind === 'organization' && (
                  <ParticipantColorPicker
                    value={orgDraftColor}
                    ariaLabel="소속 색 선택"
                    onChange={setOrgDraftColor}
                  />
                )}
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={
                    !orgDrafts[activeOrgManageGroup.kind].trim() ||
                    orgSavingKind === activeOrgManageGroup.kind
                  }
                >
                  추가
                </button>
              </form>

              <div className="org-manage-list">
                {activeOrgManageOptions.length === 0 ? (
                  <p className="org-manage-empty">
                    등록된 {activeOrgManageGroup.label}이 없습니다.
                  </p>
                ) : (
                  activeOrgManageOptions.map((option) => {
                    const isEditingOption = orgEditing?.id === option.id
                    return (
                      <div key={option.id} className="org-manage-item">
                        {activeOrgManageGroup.kind === 'organization' && (
                          <span
                            className="org-manage-dot"
                            style={{ background: option.color ?? DEFAULT_ORG_COLOR }}
                          />
                        )}
                        {isEditingOption ? (
                          <input
                            className="input org-manage-edit-input"
                            value={orgEditing.name}
                            autoFocus
                            onChange={(event) =>
                              setOrgEditing({ id: option.id, name: event.target.value })
                            }
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault()
                                void saveOrgOptionName(option)
                              }
                              if (event.key === 'Escape') setOrgEditing(null)
                            }}
                          />
                        ) : (
                          <span className="org-manage-name">{option.name}</span>
                        )}
                        {activeOrgManageGroup.kind === 'organization' && (
                          <ParticipantColorPicker
                            value={option.color ?? DEFAULT_ORG_COLOR}
                            ariaLabel={`${option.name} 소속 색 선택`}
                            onChange={(color) => void updateOrgOptionColor(option, color)}
                          />
                        )}
                        <div className="org-manage-actions">
                          {isEditingOption ? (
                            <>
                              <button
                                type="button"
                                className="btn btn-primary"
                                disabled={orgSavingKind === option.kind}
                                onClick={() => void saveOrgOptionName(option)}
                              >
                                저장
                              </button>
                              <button
                                type="button"
                                className="btn btn-ghost"
                                disabled={orgSavingKind === option.kind}
                                onClick={() => setOrgEditing(null)}
                              >
                                취소
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-ghost"
                              onClick={() => setOrgEditing({ id: option.id, name: option.name })}
                            >
                              수정
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn-icon user-icon-danger"
                            aria-label={`${option.name} 삭제`}
                            title="삭제"
                            disabled={orgSavingKind === option.kind}
                            onClick={() => void deleteOrgOption(option)}
                          >
                            ×
                          </button>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            </section>
          </div>
        </div>
      </Modal>
    </div>
  )
}
