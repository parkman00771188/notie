import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import { api, type AdminUserInput } from '../api'
import { useAuth } from '../App'
import ComboBox from '../components/ComboBox'
import { useConfirm } from '../components/confirm'
import Modal from '../components/Modal'
import type { AdminUser, OrgKind, OrgOption } from '../types'
import './UserManagementPage.css'

interface UserDraft {
  username: string
  password: string
  name: string
  role: 'admin' | 'user'
  email: string
  organization: string
  department: string
  position: string
  phone: string
  active: boolean
}

const EMPTY_DRAFT: UserDraft = {
  username: '',
  password: '',
  name: '',
  role: 'user',
  email: '',
  organization: '',
  department: '',
  position: '',
  phone: '',
  active: true,
}

const ORG_OPTION_GROUPS: { kind: OrgKind; label: string; placeholder: string }[] = [
  { kind: 'organization', label: '소속', placeholder: '회사 또는 기관' },
  { kind: 'department', label: '부서', placeholder: '부서' },
  { kind: 'role', label: '직책', placeholder: '직책' },
]

const ORG_COLOR_PALETTE = [
  '#16a34a',
  '#2563eb',
  '#e8590c',
  '#7048e8',
  '#d6336c',
  '#0ca678',
  '#f08c00',
  '#1098ad',
]

const NO_ORG_KEY = '__no_organization__'
const DEFAULT_ORG_COLOR = '#8b95a1'
const ORG_USER_FIELD: Record<OrgKind, 'organization' | 'department' | 'position'> = {
  organization: 'organization',
  department: 'department',
  role: 'position',
}

const errMsg = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback)

const sortOrgOptions = (list: OrgOption[]) =>
  [...list].sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name, 'ko') : a.kind.localeCompare(b.kind),
  )

interface UserOrgGroup {
  key: string
  name: string
  color: string
  items: AdminUser[]
}

function OrgColorPicker({
  value,
  onChange,
}: {
  value: string
  onChange: (color: string) => void
}) {
  const isCustom = !ORG_COLOR_PALETTE.includes(value)
  return (
    <div className="user-org-palette" role="group" aria-label="소속 색 선택">
      {ORG_COLOR_PALETTE.map((color) => (
        <button
          key={color}
          type="button"
          className={`user-org-swatch${value === color ? ' selected' : ''}`}
          style={{ background: color }}
          aria-label={`색상 ${color}`}
          aria-pressed={value === color}
          onClick={() => onChange(color)}
        />
      ))}
      <label
        className={`user-org-swatch user-org-swatch-custom${isCustom ? ' selected' : ''}`}
        style={isCustom ? { background: value } : undefined}
        title="직접 색 선택"
      >
        <input
          type="color"
          className="user-org-color-input"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-label="직접 색 선택"
        />
      </label>
    </div>
  )
}

function RoleBadge({ role }: { role: AdminUser['role'] }) {
  const isAdmin = role === 'admin'
  return (
    <span className={`user-role-pill ${role}`}>
      <span className="user-role-icon" aria-hidden="true">
        {isAdmin ? (
          <svg viewBox="0 0 24 24" focusable="false">
            <path d="M12 3.5 18 6v5.2c0 3.8-2.3 7.2-6 8.8-3.7-1.6-6-5-6-8.8V6l6-2.5Z" />
            <path d="m9.8 12 1.4 1.4 3.1-3.4" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" focusable="false">
            <circle cx="9" cy="8.5" r="2.6" />
            <path d="M4.5 18c.5-3 2.1-4.5 4.5-4.5s4 1.5 4.5 4.5" />
            <circle cx="16.5" cy="10" r="2" />
            <path d="M14.3 14.3c1.9.2 3.2 1.4 3.7 3.7" />
          </svg>
        )}
      </span>
      {isAdmin ? '관리자' : '사용자'}
    </span>
  )
}

function toDraft(user: AdminUser): UserDraft {
  return {
    username: user.username,
    password: '',
    name: user.name,
    role: user.role,
    email: user.email?.endsWith('@notie.local') ? '' : user.email,
    organization: user.organization ?? '',
    department: user.department ?? '',
    position: user.position ?? '',
    phone: user.phone ?? '',
    active: user.active,
  }
}

function buildPayload(draft: UserDraft, includePassword: boolean, includeUsername = true): AdminUserInput {
  const payload: AdminUserInput = {
    name: draft.name.trim(),
    role: draft.role,
    email: draft.email.trim() || undefined,
    organization: draft.organization.trim() || undefined,
    department: draft.department.trim() || undefined,
    position: draft.position.trim() || undefined,
    phone: draft.phone.trim() || undefined,
    team: draft.department.trim() || undefined,
    active: draft.active,
  }
  if (includeUsername) payload.username = draft.username.trim()
  if (includePassword && draft.password.trim()) payload.password = draft.password
  return payload
}

export default function UserManagementPage() {
  const { user } = useAuth()
  const confirm = useConfirm()
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [error, setError] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<AdminUser | null>(null)
  const [draft, setDraft] = useState<UserDraft>(EMPTY_DRAFT)
  const [roleMenuOpen, setRoleMenuOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [sort, setSort] = useState<'name' | 'department'>('name')
  const [orgOptions, setOrgOptions] = useState<OrgOption[]>([])
  const [orgManageOpen, setOrgManageOpen] = useState(false)
  const [orgManageTab, setOrgManageTab] = useState<OrgKind>('organization')
  const [orgManageError, setOrgManageError] = useState('')
  const [orgDrafts, setOrgDrafts] = useState<Record<OrgKind, string>>({
    organization: '',
    department: '',
    role: '',
  })
  const [orgDraftColor, setOrgDraftColor] = useState(ORG_COLOR_PALETTE[0])
  const [orgSavingKind, setOrgSavingKind] = useState<OrgKind | null>(null)
  const [orgEditing, setOrgEditing] = useState<{ id: number; name: string } | null>(null)
  const [collapsedOrgGroups, setCollapsedOrgGroups] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (user?.role !== 'admin') return
    let alive = true
    api
      .listAdminUsers()
      .then((list) => {
        if (alive) setUsers(list)
      })
      .catch((err: unknown) => {
        if (alive) {
          setUsers([])
          setError(errMsg(err, '사용자 목록을 불러오지 못했습니다'))
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
  }, [user?.role])

  const sortedUsers = useMemo(() => {
    const list = [...(users ?? [])]
    return list.sort((a, b) => {
      if (sort === 'department') {
        const left = `${a.department ?? ''}${a.name}`
        const right = `${b.department ?? ''}${b.name}`
        return left.localeCompare(right, 'ko')
      }
      return a.name.localeCompare(b.name, 'ko') || a.username.localeCompare(b.username)
    })
  }, [sort, users])

  const stats = useMemo(() => {
    const list = users ?? []
    return {
      total: list.length,
      admin: list.filter((item) => item.role === 'admin').length,
      active: list.filter((item) => item.active).length,
    }
  }, [users])

  const organizationOptions = useMemo(
    () => orgOptions.filter((option) => option.kind === 'organization'),
    [orgOptions],
  )

  const organizationColor = (name: string | null | undefined) => {
    if (!name) return DEFAULT_ORG_COLOR
    return organizationOptions.find((option) => option.name === name)?.color ?? DEFAULT_ORG_COLOR
  }

  const organizationGroups = useMemo<UserOrgGroup[]>(() => {
    const byOrg = new Map<string, AdminUser[]>()
    for (const item of sortedUsers) {
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
  }, [organizationOptions, sortedUsers])

  const userIndexById = useMemo(
    () => new Map(sortedUsers.map((item, index) => [item.id, index + 1])),
    [sortedUsers],
  )

  if (user && user.role !== 'admin') {
    return <Navigate to="/" replace />
  }

  const setField = <K extends keyof UserDraft>(key: K, value: UserDraft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  const orgOptionNames = (kind: OrgKind) =>
    orgOptions.filter((option) => option.kind === kind).map((option) => option.name)

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

  const setOrgDraft = (kind: OrgKind, value: string) => {
    setOrgDrafts((prev) => ({ ...prev, [kind]: value }))
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
          ? colorOverride || ORG_COLOR_PALETTE[orgCount % ORG_COLOR_PALETTE.length]
          : undefined
      const created = await api.createOrgOption(color ? { kind, name, color } : { kind, name })
      setOrgOptions((prev) => {
        if (prev.some((option) => option.kind === kind && option.name === name)) return prev
        return sortOrgOptions([...prev, created])
      })
      return created
    } catch (err: unknown) {
      setOrgManageError(errMsg(err, '항목을 추가하지 못했습니다'))
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

  const deleteOrgOption = async (option: OrgOption) => {
    const ok = await confirm({
      title: `'${option.name}' 항목을 삭제할까요?`,
      message: '선택 목록에서만 삭제되며, 이미 사용자 정보에 입력된 값은 그대로 유지됩니다.',
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
      setOrgManageError(errMsg(err, '항목을 삭제하지 못했습니다'))
    }
  }

  const registerOrgOption = (kind: OrgKind) => (name: string) => {
    void createOrgOption(kind, name)
  }

  const removeOrgOption = (kind: OrgKind) => (name: string) => {
    const target = orgOptions.find((option) => option.kind === kind && option.name === name)
    if (!target) return
    setOrgManageError('')
    api
      .deleteOrgOption(target.id)
      .then(() => setOrgOptions((prev) => prev.filter((option) => option.id !== target.id)))
      .catch((err: unknown) => setOrgManageError(errMsg(err, '항목을 삭제하지 못했습니다')))
  }

  const updateOrgOptionColor = async (option: OrgOption, color: string) => {
    setOrgManageError('')
    try {
      const updated = await api.updateOrgOption(option.id, { color })
      setOrgOptions((prev) => sortOrgOptions(prev.map((item) => (item.id === updated.id ? updated : item))))
    } catch (err: unknown) {
      setOrgManageError(errMsg(err, '소속 색을 저장하지 못했습니다'))
    }
  }

  const saveOrgOptionName = async (option: OrgOption) => {
    if (orgEditing?.id !== option.id) return
    const name = orgEditing.name.trim()
    if (!name) {
      setOrgManageError('이름을 입력해주세요')
      return
    }
    if (name === option.name) {
      setOrgEditing(null)
      return
    }

    const oldName = option.name
    const field = ORG_USER_FIELD[option.kind]
    setOrgSavingKind(option.kind)
    setOrgManageError('')
    try {
      const updated = await api.updateOrgOption(option.id, { name })
      setOrgOptions((prev) => sortOrgOptions(prev.map((item) => (item.id === updated.id ? updated : item))))
      setUsers((prev) =>
        (prev ?? []).map((item) => (item[field] === oldName ? { ...item, [field]: updated.name } : item)),
      )
      setDraft((prev) => (prev[field] === oldName ? { ...prev, [field]: updated.name } : prev))
      setOrgEditing(null)
    } catch (err: unknown) {
      setOrgManageError(errMsg(err, '항목 이름을 수정하지 못했습니다'))
    } finally {
      setOrgSavingKind(null)
    }
  }

  const toggleOrgGroup = (key: string) => {
    setCollapsedOrgGroups((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const openCreate = () => {
    setEditing(null)
    setDraft(EMPTY_DRAFT)
    setRoleMenuOpen(false)
    setError('')
    setModalOpen(true)
  }

  const openEdit = (target: AdminUser) => {
    setEditing(target)
    setDraft(toDraft(target))
    setRoleMenuOpen(false)
    setError('')
    setModalOpen(true)
  }

  const closeModal = () => {
    if (saving) return
    setModalOpen(false)
    setEditing(null)
    setDraft(EMPTY_DRAFT)
    setRoleMenuOpen(false)
  }

  const saveUser = async (e: FormEvent) => {
    e.preventDefault()
    if (saving) return
    if (!draft.username.trim() || !draft.name.trim()) return
    if (!editing && !draft.password.trim()) return
    setSaving(true)
    setError('')
    try {
      if (editing) {
        const payload = buildPayload(draft, !!draft.password.trim(), false)
        const updated = await api.updateAdminUser(editing.id, payload)
        setUsers((prev) => (prev ?? []).map((item) => (item.id === updated.id ? updated : item)))
      } else {
        const created = await api.createAdminUser({
          ...buildPayload(draft, true),
          username: draft.username.trim(),
          password: draft.password,
        })
        setUsers((prev) => [...(prev ?? []), created])
      }
      setModalOpen(false)
      setEditing(null)
      setDraft(EMPTY_DRAFT)
    } catch (err: unknown) {
      setError(errMsg(err, '사용자 정보를 저장하지 못했습니다'))
    } finally {
      setSaving(false)
    }
  }

  const toggleActive = async (target: AdminUser) => {
    const nextActive = !target.active
    const ok = await confirm({
      title: nextActive ? `${target.name} 계정을 활성화할까요?` : `${target.name} 계정을 비활성화할까요?`,
      message: nextActive
        ? '활성화하면 해당 사용자가 다시 로그인할 수 있습니다.'
        : '비활성화하면 해당 사용자는 로그인할 수 없지만 기존 회의 데이터는 유지됩니다.',
      confirmLabel: nextActive ? '활성화' : '비활성화',
      danger: !nextActive,
    })
    if (!ok) return
    setError('')
    try {
      const updated = await api.updateAdminUser(target.id, { active: nextActive })
      setUsers((prev) => (prev ?? []).map((item) => (item.id === updated.id ? updated : item)))
    } catch (err: unknown) {
      setError(errMsg(err, '계정 상태를 변경하지 못했습니다'))
    }
  }

  const deleteUser = async (target: AdminUser) => {
    if (target.id === user?.id) return
    const ok = await confirm({
      title: `${target.name} 계정을 삭제할까요?`,
      message: '삭제하면 해당 사용자의 로그인 계정과 기존 회의 데이터가 함께 삭제됩니다. 이 작업은 되돌릴 수 없습니다.',
      confirmLabel: '삭제',
      danger: true,
    })
    if (!ok) return
    setError('')
    try {
      await api.deleteAdminUser(target.id)
      setUsers((prev) => (prev ?? []).filter((item) => item.id !== target.id))
    } catch (err: unknown) {
      setError(errMsg(err, '사용자를 삭제하지 못했습니다'))
    }
  }

  const renderUserRow = (item: AdminUser) => (
    <tr key={item.id} className={!item.active ? 'inactive' : undefined}>
      <td>{userIndexById.get(item.id) ?? '-'}</td>
      <td>
        <RoleBadge role={item.role} />
      </td>
      <td>
        <div className="user-name-cell">
          <strong>{item.name}</strong>
        </div>
      </td>
      <td className="user-id-cell">{item.username}</td>
      <td>{item.organization || '-'}</td>
      <td>{item.department || '-'}</td>
      <td>{item.position || '-'}</td>
      <td>{item.phone || '-'}</td>
      <td>
        <span className={`user-status-pill ${item.active ? 'active' : 'inactive'}`}>
          {item.active ? '활성' : '비활성'}
        </span>
      </td>
      <td>
        <div className="user-row-actions">
          <button type="button" className="btn btn-ghost" onClick={() => openEdit(item)}>
            수정
          </button>
          <button
            type="button"
            className={`btn ${item.active ? 'btn-danger' : 'btn-soft'}`}
            onClick={() => void toggleActive(item)}
          >
            {item.active ? '비활성' : '활성'}
          </button>
          <button
            type="button"
            className="btn-icon user-delete-btn"
            disabled={item.id === user?.id}
            title={item.id === user?.id ? '현재 로그인한 계정은 삭제할 수 없습니다' : '삭제'}
            aria-label={`${item.name} 계정 삭제`}
            onClick={() => void deleteUser(item)}
          >
            🗑️
          </button>
        </div>
      </td>
    </tr>
  )

  const activeOrgManageGroup =
    ORG_OPTION_GROUPS.find((group) => group.kind === orgManageTab) ?? ORG_OPTION_GROUPS[0]
  const activeOrgManageOptions = orgOptions.filter((option) => option.kind === activeOrgManageGroup.kind)

  return (
    <div className="page user-admin-page">
      <div className="user-admin-head">
        <div>
          <h1 className="page-title">사용자 관리</h1>
          <p className="user-admin-subtitle">
            관리자만 계정을 추가하고 권한을 변경할 수 있습니다.
          </p>
        </div>
        <div className="user-admin-head-actions">
          <button type="button" className="btn btn-ghost" onClick={openOrgManage}>
            소속/부서/직책 관리
          </button>
          <button type="button" className="btn btn-primary" onClick={openCreate}>
            사용자 추가
          </button>
        </div>
      </div>

      <div className="user-admin-stats" aria-label="사용자 현황">
        <div>
          <span>전체</span>
          <strong>{stats.total}</strong>
        </div>
        <div>
          <span>활성</span>
          <strong>{stats.active}</strong>
        </div>
        <div>
          <span>관리자</span>
          <strong>{stats.admin}</strong>
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

        {users === null ? (
          <div className="user-admin-loading">
            <span className="spinner" />
          </div>
        ) : organizationGroups.length === 0 ? (
          <div className="card user-admin-empty-card">
            <div className="user-admin-empty">등록된 사용자가 없습니다.</div>
          </div>
        ) : (
          <div className="user-org-groups">
            {organizationGroups.map((group) => {
              const isCollapsed = !!collapsedOrgGroups[group.key]
              return (
                <div key={group.key} className="card user-org-group">
                  <button
                    type="button"
                    className="user-org-head"
                    aria-expanded={!isCollapsed}
                    onClick={() => toggleOrgGroup(group.key)}
                  >
                    <span className={`user-org-caret${isCollapsed ? '' : ' open'}`}>▸</span>
                    <span className="user-org-dot" style={{ background: group.color }} />
                    <span className="user-org-name">{group.name}</span>
                    <span className="user-org-count">{group.items.length}명</span>
                  </button>
                  {!isCollapsed && (
                    <div className="user-admin-table-wrap user-org-table-wrap">
                      <table className="user-admin-table">
                        <colgroup>
                          <col className="user-admin-col-index" />
                          <col className="user-admin-col-role" />
                          <col className="user-admin-col-name" />
                          <col className="user-admin-col-username" />
                          <col className="user-admin-col-organization" />
                          <col className="user-admin-col-department" />
                          <col className="user-admin-col-position" />
                          <col className="user-admin-col-phone" />
                          <col className="user-admin-col-status" />
                          <col className="user-admin-col-actions" />
                        </colgroup>
                        <thead>
                          <tr>
                            <th>순번</th>
                            <th>권한</th>
                            <th>이름</th>
                            <th>사용자 ID</th>
                            <th>소속</th>
                            <th>부서</th>
                            <th>직책</th>
                            <th>연락처</th>
                            <th>상태</th>
                            <th>관리</th>
                          </tr>
                        </thead>
                        <tbody>
                          {group.items.length > 0 ? (
                            group.items.map(renderUserRow)
                          ) : (
                            <tr className="user-admin-empty-row">
                              <td colSpan={10}>이 소속에는 등록된 사용자가 없습니다.</td>
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
        title={editing ? '사용자 수정' : '사용자 추가'}
        width={780}
        onClose={closeModal}
      >
        <form className="user-form" onSubmit={saveUser}>
          <div className="user-form-grid">
            <label className="user-form-field">
              <span>사용자 ID *</span>
              <input
                className={`input${editing ? ' user-id-locked-input' : ''}`}
                value={draft.username}
                onChange={(e) => setField('username', e.target.value)}
                placeholder="admin"
                autoComplete="off"
                disabled={!!editing}
                title={editing ? '사용자 ID는 생성 후 변경할 수 없습니다' : undefined}
                required
              />
              {editing && <small>사용자 ID는 생성 후 변경할 수 없습니다.</small>}
            </label>
            <label className="user-form-field">
              <span>비밀번호 {editing ? '(변경 시 입력)' : '*'}</span>
              <input
                className="input"
                type="password"
                value={draft.password}
                onChange={(e) => setField('password', e.target.value)}
                placeholder={editing ? '새 비밀번호' : '초기 비밀번호'}
                autoComplete="new-password"
                required={!editing}
              />
            </label>
            <label className="user-form-field">
              <span>이름 *</span>
              <input
                className="input"
                value={draft.name}
                onChange={(e) => setField('name', e.target.value)}
                placeholder="홍길동"
                required
              />
            </label>
            <div className="user-form-field">
              <span>권한</span>
              <div
                className="user-role-dropdown"
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setRoleMenuOpen(false)
                  }
                }}
              >
                <button
                  type="button"
                  className={`user-role-dropdown-button${roleMenuOpen ? ' open' : ''}`}
                  aria-haspopup="listbox"
                  aria-expanded={roleMenuOpen}
                  onClick={() => setRoleMenuOpen((open) => !open)}
                >
                  <RoleBadge role={draft.role} />
                  <span className="user-role-dropdown-caret" aria-hidden="true">
                    ▾
                  </span>
                </button>
                {roleMenuOpen && (
                  <div className="user-role-dropdown-menu" role="listbox" aria-label="권한 선택">
                    {(['admin', 'user'] as const).map((role) => (
                      <button
                        key={role}
                        type="button"
                        role="option"
                        aria-selected={draft.role === role}
                        className={`user-role-dropdown-option${draft.role === role ? ' selected' : ''}`}
                        onClick={() => {
                          setField('role', role)
                          setRoleMenuOpen(false)
                        }}
                      >
                        <RoleBadge role={role} />
                        {draft.role === role && (
                          <span className="user-role-dropdown-check" aria-hidden="true">
                            ✓
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <label className="user-form-field">
              <span>소속</span>
              <ComboBox
                value={draft.organization}
                onChange={(value) => setField('organization', value)}
                options={orgOptionNames('organization')}
                placeholder="회사 또는 기관"
                onCreateOption={registerOrgOption('organization')}
                onDeleteOption={removeOrgOption('organization')}
              />
            </label>
            <label className="user-form-field">
              <span>부서</span>
              <ComboBox
                value={draft.department}
                onChange={(value) => setField('department', value)}
                options={orgOptionNames('department')}
                placeholder="부서"
                onCreateOption={registerOrgOption('department')}
                onDeleteOption={removeOrgOption('department')}
              />
            </label>
            <label className="user-form-field">
              <span>직책</span>
              <ComboBox
                value={draft.position}
                onChange={(value) => setField('position', value)}
                options={orgOptionNames('role')}
                placeholder="직책"
                onCreateOption={registerOrgOption('role')}
                onDeleteOption={removeOrgOption('role')}
              />
            </label>
            <label className="user-form-field">
              <span>연락처</span>
              <input
                className="input"
                value={draft.phone}
                onChange={(e) => setField('phone', e.target.value)}
                placeholder="010-0000-0000"
              />
            </label>
            <label className="user-form-field user-form-field-wide">
              <span>이메일</span>
              <input
                className="input"
                type="email"
                value={draft.email}
                onChange={(e) => setField('email', e.target.value)}
                placeholder="name@example.com"
              />
            </label>
            <label className="user-active-toggle">
              <input
                type="checkbox"
                checked={draft.active}
                onChange={(e) => setField('active', e.target.checked)}
              />
              <span>활성 계정</span>
            </label>
          </div>

          <div className="user-form-actions">
            <button type="button" className="btn btn-ghost" onClick={closeModal} disabled={saving}>
              취소
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!draft.username.trim() || !draft.name.trim() || (!editing && !draft.password.trim()) || saving}
            >
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
            사용자 추가/수정 폼에서 선택할 목록을 관리합니다. 목록에서 삭제해도 이미 저장된 사용자 정보는 유지됩니다.
          </p>
          {orgManageError && <div className="user-admin-error org-manage-error">{orgManageError}</div>}

          <div className="org-manage-layout">
            <nav className="org-manage-tabs" aria-label="소속 정보 관리">
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
                  <OrgColorPicker value={orgDraftColor} onChange={setOrgDraftColor} />
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
                          <OrgColorPicker
                            value={option.color ?? DEFAULT_ORG_COLOR}
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
