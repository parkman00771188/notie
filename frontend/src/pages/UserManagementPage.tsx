import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import { api, type AdminUserInput } from '../api'
import { useAuth } from '../App'
import ComboBox from '../components/ComboBox'
import { useConfirm } from '../components/confirm'
import Modal from '../components/Modal'
import type { AdminUser, OrgKind, OrgOption, UserRole } from '../types'
import './UserManagementPage.css'

interface UserDraft {
  username: string
  password: string
  name: string
  role: UserRole
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
const ALL_USERS_KEY = '__all_users__'
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
const uniqueSortedNames = (list: string[]) =>
  [...new Set(list)].sort((a, b) => a.localeCompare(b, 'ko'))

interface UserOrgGroup {
  key: string
  name: string
  color: string
  items: AdminUser[]
}

type UserFilter = 'all' | 'active' | 'inactive' | 'admin' | 'user' | 'other'

const USER_FILTER_LABELS: Record<UserFilter, string> = {
  all: '전체',
  active: '활성',
  inactive: '비활성',
  admin: '관리자',
  user: '사용자',
  other: '기타',
}

const USER_FILTER_TITLES: Record<UserFilter, string> = {
  all: '전체 사용자',
  active: '활성 사용자',
  inactive: '비활성 사용자',
  admin: '관리자',
  user: '사용자',
  other: '기타',
}

const USER_FILTER_DESCRIPTIONS: Record<UserFilter, string> = {
  all: '등록된 전체 사용자',
  active: '활성 상태인 사용자',
  inactive: '비활성 상태인 사용자',
  admin: '관리자 권한 사용자',
  user: '일반 사용자',
  other: '외부 사용자',
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
  const isOther = role === 'other'
  const label = isAdmin ? '관리자' : isOther ? '기타' : '사용자'
  return (
    <span className={`user-role-pill ${role}`}>
      <span className="user-role-icon" aria-hidden="true">
        {isAdmin ? (
          <svg viewBox="0 0 24 24" focusable="false">
            <path d="M12 3.5 18 6v5.2c0 3.8-2.3 7.2-6 8.8-3.7-1.6-6-5-6-8.8V6l6-2.5Z" />
            <path d="m9.8 12 1.4 1.4 3.1-3.4" />
          </svg>
        ) : isOther ? (
          <svg viewBox="0 0 24 24" focusable="false">
            <circle cx="12" cy="8" r="3" />
            <path d="M6.5 19c.6-3.2 2.5-4.8 5.5-4.8s4.9 1.6 5.5 4.8" />
            <path d="M4 5.5 7 8.5" />
            <path d="M20 5.5 17 8.5" />
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
      {label}
    </span>
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

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m4 20 4.2-1.1L19.1 8a2.1 2.1 0 0 0 0-3l-.1-.1a2.1 2.1 0 0 0-3 0L5.1 15.8 4 20Z" />
      <path d="m14.5 6.5 3 3" />
    </svg>
  )
}

function EyeIcon({ hidden }: { hidden: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {hidden ? (
        <>
          <path d="M3 3l18 18" />
          <path d="M10.7 5.1A10.6 10.6 0 0 1 12 5c5 0 8.5 4.4 9.6 6a1.8 1.8 0 0 1 0 2c-.4.6-1.2 1.6-2.2 2.5" />
          <path d="M14.1 14.1A3 3 0 0 1 9.9 9.9" />
          <path d="M6.4 6.5A16 16 0 0 0 2.4 11a1.8 1.8 0 0 0 0 2C3.5 14.6 7 19 12 19c1.6 0 3-.4 4.2-1" />
        </>
      ) : (
        <>
          <path d="M2.4 11a1.8 1.8 0 0 0 0 2C3.5 14.6 7 19 12 19s8.5-4.4 9.6-6a1.8 1.8 0 0 0 0-2C20.5 9.4 17 5 12 5S3.5 9.4 2.4 11Z" />
          <circle cx="12" cy="12" r="3" />
        </>
      )}
    </svg>
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

const displayUserEmail = (email?: string | null) =>
  email && !email.endsWith('@notie.local') ? email : '-'

export default function UserManagementPage() {
  const { user } = useAuth()
  const confirm = useConfirm()
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [error, setError] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<AdminUser | null>(null)
  const [detailUserId, setDetailUserId] = useState<number | null>(null)
  const [draft, setDraft] = useState<UserDraft>(EMPTY_DRAFT)
  const [roleMenuOpen, setRoleMenuOpen] = useState(false)
  const [showUserPassword, setShowUserPassword] = useState(false)
  const [saving, setSaving] = useState(false)
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
  const [selectedGroupKey, setSelectedGroupKey] = useState<string>(ALL_USERS_KEY)
  const [userFilter, setUserFilter] = useState<UserFilter>('all')

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
    return list.sort((a, b) => a.name.localeCompare(b.name, 'ko') || a.username.localeCompare(b.username))
  }, [users])

  const stats = useMemo(() => {
    const list = users ?? []
    return {
      total: list.length,
      active: list.filter((item) => item.active).length,
      inactive: list.filter((item) => !item.active).length,
      admin: list.filter((item) => item.role === 'admin').length,
      user: list.filter((item) => item.role === 'user').length,
      other: list.filter((item) => item.role === 'other').length,
    }
  }, [users])

  const filteredUsers = useMemo(() => {
    switch (userFilter) {
      case 'active':
        return sortedUsers.filter((item) => item.active)
      case 'inactive':
        return sortedUsers.filter((item) => !item.active)
      case 'admin':
        return sortedUsers.filter((item) => item.role === 'admin')
      case 'user':
        return sortedUsers.filter((item) => item.role === 'user')
      case 'other':
        return sortedUsers.filter((item) => item.role === 'other')
      case 'all':
      default:
        return sortedUsers
    }
  }, [sortedUsers, userFilter])

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
    for (const item of filteredUsers) {
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
  }, [filteredUsers, organizationOptions])

  useEffect(() => {
    if (users === null) return
    if (selectedGroupKey === ALL_USERS_KEY) return
    if (organizationGroups.length === 0) {
      setSelectedGroupKey(ALL_USERS_KEY)
      return
    }
    if (!selectedGroupKey || !organizationGroups.some((group) => group.key === selectedGroupKey)) {
      setSelectedGroupKey(ALL_USERS_KEY)
    }
  }, [organizationGroups, selectedGroupKey, users])

  const selectedGroup =
    selectedGroupKey === ALL_USERS_KEY
      ? null
      : organizationGroups.find((group) => group.key === selectedGroupKey) ?? null
  const displayedUsers = selectedGroup ? selectedGroup.items : filteredUsers
  const tableFilterDescription = USER_FILTER_DESCRIPTIONS[userFilter]
  const tableTitle = selectedGroup ? selectedGroup.name : USER_FILTER_TITLES[userFilter]
  const tableDescription = selectedGroup
    ? `이 소속의 ${tableFilterDescription} ${displayedUsers.length}명`
    : `${tableFilterDescription} ${displayedUsers.length}명`
  const detailUser =
    detailUserId === null ? null : (users ?? []).find((item) => item.id === detailUserId) ?? null

  if (user && user.role !== 'admin') {
    return <Navigate to="/" replace />
  }

  const setField = <K extends keyof UserDraft>(key: K, value: UserDraft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  const orgOptionNames = (kind: OrgKind) =>
    uniqueSortedNames(orgOptions.filter((option) => option.kind === kind).map((option) => option.name))

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

  const openCreate = () => {
    setEditing(null)
    setDraft({
      ...EMPTY_DRAFT,
      organization: selectedGroup && selectedGroup.key !== NO_ORG_KEY ? selectedGroup.name : '',
    })
    setRoleMenuOpen(false)
    setShowUserPassword(false)
    setError('')
    setModalOpen(true)
  }

  const openEdit = (target: AdminUser) => {
    setDetailUserId(null)
    setEditing(target)
    setDraft(toDraft(target))
    setRoleMenuOpen(false)
    setShowUserPassword(false)
    setError('')
    setModalOpen(true)
  }

  const closeModal = () => {
    if (saving) return
    setModalOpen(false)
    setEditing(null)
    setDraft(EMPTY_DRAFT)
    setRoleMenuOpen(false)
    setShowUserPassword(false)
  }

  const openUserDetail = (target: AdminUser) => {
    setDetailUserId(target.id)
    setError('')
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
      setShowUserPassword(false)
    } catch (err: unknown) {
      setError(errMsg(err, '사용자 정보를 저장하지 못했습니다'))
    } finally {
      setSaving(false)
    }
  }

  const toggleActive = async (target: AdminUser) => {
    const nextActive = !target.active
    const ok = await confirm({
      title: nextActive ? `${target.name} 계정을 활성화하시겠습니까?` : `${target.name} 계정을 비활성화하시겠습니까?`,
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
      return updated
    } catch (err: unknown) {
      setError(errMsg(err, '계정 상태를 변경하지 못했습니다'))
      return null
    }
  }

  const renderUserRow = (item: AdminUser, groupIndex: number) => (
    <tr
      key={item.id}
      className={`user-clickable-row${!item.active ? ' inactive' : ''}`}
      tabIndex={0}
      onClick={() => openUserDetail(item)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          openUserDetail(item)
        }
      }}
    >
      <td>{groupIndex}</td>
      <td>
        <RoleBadge role={item.role} />
      </td>
      <td>
        <div className="user-name-cell">
          <strong>{item.name}</strong>
        </div>
      </td>
      <td className="user-id-cell">{item.username}</td>
      <td>{item.department || '-'}</td>
      <td>{item.position || '-'}</td>
      <td className="user-email-cell" title={displayUserEmail(item.email)}>
        {displayUserEmail(item.email)}
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
      </div>

      <div className="user-admin-stats" aria-label="사용자 현황 필터">
        {([
          ['all', stats.total],
          ['active', stats.active],
          ['inactive', stats.inactive],
          ['admin', stats.admin],
          ['user', stats.user],
          ['other', stats.other],
        ] as const).map(([filter, count]) => (
          <button
            key={filter}
            type="button"
            className={`user-admin-stat-card${userFilter === filter ? ' active' : ''}`}
            aria-pressed={userFilter === filter}
            onClick={() => {
              setUserFilter(filter)
              setSelectedGroupKey(ALL_USERS_KEY)
            }}
          >
            <span>{USER_FILTER_LABELS[filter]}</span>
            <strong>{count}</strong>
          </button>
        ))}
      </div>

      <section className="user-directory-section">
        {error && <div className="user-admin-error">{error}</div>}

        {users === null ? (
          <div className="user-admin-loading">
            <span className="spinner" />
          </div>
        ) : users.length === 0 ? (
          <div className="card user-admin-empty-card">
            <div className="user-admin-empty">등록된 사용자가 없습니다.</div>
          </div>
        ) : (
          <div className="user-directory-layout">
            <aside className="card user-org-list-card" aria-label="소속 목록">
              <div className="user-org-list-head">
                <div className="user-org-list-title">
                  <span className="user-org-list-icon">
                    <BuildingIcon />
                  </span>
                  <div>
                    <strong>소속</strong>
                    <small>{organizationGroups.length}개 그룹</small>
                  </div>
                </div>
                <button
                  type="button"
                  className="user-org-manage-btn"
                  onClick={openOrgManage}
                  title="소속/부서/직책 관리"
                >
                  관리
                </button>
              </div>
              <div className="user-org-list">
                {organizationGroups.length === 0 ? (
                  <div className="user-org-list-empty">조건에 맞는 소속이 없습니다.</div>
                ) : (
                  organizationGroups.map((group) => {
                  const adminCount = group.items.filter((item) => item.role === 'admin').length
                  const activeCount = group.items.filter((item) => item.active).length
                  return (
                  <button
                    key={group.key}
                    type="button"
                    className={`user-org-list-item${selectedGroup?.key === group.key ? ' active' : ''}`}
                    onClick={() => setSelectedGroupKey(group.key)}
                  >
                    <span className="user-org-dot" style={{ background: group.color }} />
                    <span className="user-org-item-text">
                      <strong>{group.name}</strong>
                      <small>
                        활성 {activeCount}명
                        {adminCount > 0 ? ` · 관리자 ${adminCount}명` : ''}
                      </small>
                    </span>
                    <span className="user-org-count">{group.items.length}</span>
                  </button>
                  )
                }))}
              </div>
            </aside>

            <section className="card user-detail-card" aria-label="사용자 목록">
                <>
                  <div className="user-detail-top">
                    <div className="user-detail-title">
                      <span className="user-detail-icon">
                        <UsersIcon />
                      </span>
                      <div>
                        <h2>{tableTitle}</h2>
                        <p>{tableDescription}</p>
                      </div>
                    </div>
                    <div className="user-detail-actions">
                      <button type="button" className="btn btn-primary" onClick={openCreate}>
                        + 사용자 추가
                      </button>
                    </div>
                  </div>

                  <div className="user-detail-body">
                    <div className="user-admin-table-wrap user-table-wrap">
                      <table className="user-admin-table">
                        <colgroup>
                          <col className="user-admin-col-index" />
                          <col className="user-admin-col-role" />
                          <col className="user-admin-col-name" />
                          <col className="user-admin-col-username" />
                          <col className="user-admin-col-department" />
                          <col className="user-admin-col-position" />
                          <col className="user-admin-col-email" />
                        </colgroup>
                        <thead>
                          <tr>
                            <th>순번</th>
                            <th>권한</th>
                            <th>이름</th>
                            <th>사용자 ID</th>
                            <th>부서</th>
                            <th>직책</th>
                            <th>이메일</th>
                          </tr>
                        </thead>
                        <tbody>
                          {displayedUsers.length > 0 ? (
                            displayedUsers.map((item, index) => renderUserRow(item, index + 1))
                          ) : (
                            <tr className="user-admin-empty-row">
                              <td colSpan={7}>조건에 맞는 사용자가 없습니다.</td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
            </section>
          </div>
        )}
      </section>

      <Modal
        open={detailUser !== null}
        title="사용자 정보"
        width={620}
        onClose={() => setDetailUserId(null)}
      >
        {detailUser && (
          <div className="user-detail-modal">
            <div className="user-detail-modal-head">
              <div className="user-detail-identity">
                <strong>{detailUser.name}</strong>
                <span>{detailUser.username}</span>
              </div>
              <div className="user-detail-modal-badges">
                <RoleBadge role={detailUser.role} />
                <span className={`user-status-pill ${detailUser.active ? 'active' : 'inactive'}`}>
                  {detailUser.active ? '활성' : '비활성'}
                </span>
              </div>
            </div>

            <dl className="user-detail-list">
              <div>
                <dt>소속</dt>
                <dd>{detailUser.organization || '-'}</dd>
              </div>
              <div>
                <dt>부서</dt>
                <dd>{detailUser.department || '-'}</dd>
              </div>
              <div>
                <dt>직책</dt>
                <dd>{detailUser.position || '-'}</dd>
              </div>
              <div>
                <dt>이메일</dt>
                <dd>{displayUserEmail(detailUser.email)}</dd>
              </div>
              <div>
                <dt>연락처</dt>
                <dd>{detailUser.phone || '-'}</dd>
              </div>
              <div>
                <dt>회의 수</dt>
                <dd>{detailUser.meeting_count}개</dd>
              </div>
            </dl>

            <div className="user-detail-modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setDetailUserId(null)}>
                닫기
              </button>
              <button type="button" className="btn btn-soft user-detail-edit-action" onClick={() => openEdit(detailUser)}>
                <PencilIcon />
                수정
              </button>
              <button
                type="button"
                className={`btn ${detailUser.active ? 'btn-danger' : 'btn-primary'}`}
                onClick={() => void toggleActive(detailUser)}
              >
                {detailUser.active ? '비활성화' : '활성화'}
              </button>
            </div>
          </div>
        )}
      </Modal>

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
              <div className="user-password-wrap">
                <input
                  className="input user-password-input"
                  type={showUserPassword ? 'text' : 'password'}
                  value={draft.password}
                  onChange={(e) => setField('password', e.target.value)}
                  placeholder={editing ? '새 비밀번호' : '초기 비밀번호'}
                  autoComplete="new-password"
                  required={!editing}
                />
                <button
                  type="button"
                  className="user-password-toggle"
                  onClick={() => setShowUserPassword((value) => !value)}
                  aria-label={showUserPassword ? '비밀번호 숨기기' : '비밀번호 표시'}
                  title={showUserPassword ? '비밀번호 숨기기' : '비밀번호 표시'}
                >
                  <EyeIcon hidden={showUserPassword} />
                </button>
              </div>
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
                    {(['admin', 'user', 'other'] as const).map((role) => (
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
            {editing && (
              <label className="user-active-toggle">
                <input
                  type="checkbox"
                  checked={draft.active}
                  onChange={(e) => setField('active', e.target.checked)}
                />
                <span>활성 계정</span>
              </label>
            )}
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
