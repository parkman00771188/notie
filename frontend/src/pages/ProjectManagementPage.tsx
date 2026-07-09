import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { api, type AdminUserInput, type ProjectInput } from '../api'
import { useAuth } from '../App'
import { useConfirm } from '../components/confirm'
import Modal from '../components/Modal'
import type { Project, Tag, User } from '../types'
import './ProjectManagementPage.css'

type ProjectTab = 'basic' | 'members'

interface ProjectDraft {
  title: string
  task_number: string
  task_title: string
  principal_investigator: string
  research_institution: string
  period_start: string
  period_end: string
  color: string
  tag_ids: number[]
  member_user_ids: number[]
}

interface ProjectMemberDraft {
  name: string
  organization: string
  department: string
  position: string
  email: string
}

const PROJECT_COLORS = [
  '#16a34a',
  '#2563eb',
  '#e8590c',
  '#7048e8',
  '#d6336c',
  '#0ca678',
  '#f08c00',
  '#1098ad',
]

const EMPTY_DRAFT: ProjectDraft = {
  title: '',
  task_number: '',
  task_title: '',
  principal_investigator: '',
  research_institution: '',
  period_start: '',
  period_end: '',
  color: PROJECT_COLORS[0],
  tag_ids: [],
  member_user_ids: [],
}

const DETAIL_TABS: { key: ProjectTab; label: string }[] = [
  { key: 'basic', label: '기본 정보' },
  { key: 'members', label: '프로젝트 참여자' },
]

const errMsg = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback)

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.8 6.5a2 2 0 0 1 2-2h4.4l2 2h6a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5.8a2 2 0 0 1-2-2v-11Z" />
      <path d="M3.8 9h16.4" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.8-3.8" />
    </svg>
  )
}

function EditIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5Z" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h16" />
      <path d="M10 11v6M14 11v6" />
      <path d="M6 7l1 14h10l1-14" />
      <path d="M9 7V4h6v3" />
    </svg>
  )
}

function UsersIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M16 20v-1.6c0-1.8-1.5-3.3-3.3-3.3H7.3C5.5 15.1 4 16.6 4 18.4V20" />
      <circle cx="10" cy="7.5" r="3.3" />
      <path d="M20 20v-1.3c0-1.5-.9-2.8-2.2-3.3" />
      <path d="M16.3 4.4a3.3 3.3 0 0 1 0 6.2" />
    </svg>
  )
}

function BuildingIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4.5 20V5.8a1.8 1.8 0 0 1 1.8-1.8h7.4a1.8 1.8 0 0 1 1.8 1.8V20" />
      <path d="M15.5 9h2.2a1.8 1.8 0 0 1 1.8 1.8V20" />
      <path d="M8 8h.01M12 8h.01M8 12h.01M12 12h.01M8 16h.01M12 16h.01" />
      <path d="M3 20h18" />
    </svg>
  )
}

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m7 10 5 5 5-5" />
    </svg>
  )
}

function toDraft(project: Project): ProjectDraft {
  return {
    title: project.title,
    task_number: project.task_number ?? '',
    task_title: project.task_title ?? '',
    principal_investigator: project.principal_investigator ?? '',
    research_institution: project.research_institution ?? '',
    period_start: project.period_start ?? '',
    period_end: project.period_end ?? '',
    color: project.color || PROJECT_COLORS[0],
    tag_ids: project.tags.map((tag) => tag.id),
    member_user_ids: project.members.map((member) => member.id),
  }
}

function buildPayload(draft: ProjectDraft): ProjectInput {
  return {
    title: draft.title.trim(),
    task_number: draft.task_number.trim() || undefined,
    task_title: draft.task_title.trim() || undefined,
    principal_investigator: draft.principal_investigator.trim() || undefined,
    research_institution: draft.research_institution.trim() || undefined,
    period_start: draft.period_start || undefined,
    period_end: draft.period_end || undefined,
    color: draft.color,
    tag_ids: draft.tag_ids,
    member_user_ids: draft.member_user_ids,
  }
}

function formatPeriod(project: Project | ProjectDraft) {
  const start = project.period_start || ''
  const end = project.period_end || ''
  if (!start && !end) return '-'
  if (start && end) return `${start} ~ ${end}`
  return start || end
}

function groupUsersByOrganization(users: User[]) {
  const groups = new Map<string, User[]>()
  users.forEach((item) => {
    const key = item.organization?.trim() || '소속 미지정'
    groups.set(key, [...(groups.get(key) ?? []), item])
  })
  return [...groups.entries()]
    .map(([name, items]) => ({
      name,
      users: items.sort((a, b) => a.name.localeCompare(b.name, 'ko')),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'))
}

function displayUserEmail(user: User) {
  const email = user.email?.trim()
  if (!email || email.toLowerCase().endsWith('@notie.local')) return '-'
  return email
}

function toProjectMemberDraft(user: User): ProjectMemberDraft {
  return {
    name: user.name,
    organization: user.organization ?? '',
    department: user.department ?? '',
    position: user.position ?? '',
    email: user.email?.toLowerCase().endsWith('@notie.local') ? '' : user.email,
  }
}

function buildMemberPayload(draft: ProjectMemberDraft): Partial<AdminUserInput> {
  return {
    name: draft.name.trim(),
    organization: draft.organization.trim() || undefined,
    department: draft.department.trim() || undefined,
    position: draft.position.trim() || undefined,
    email: draft.email.trim() || undefined,
  }
}

export default function ProjectManagementPage() {
  const { user } = useAuth()
  const confirm = useConfirm()
  const isAdmin = user?.role === 'admin'
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [allTags, setAllTags] = useState<Tag[]>([])
  const [directoryUsers, setDirectoryUsers] = useState<User[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [activeTab, setActiveTab] = useState<ProjectTab>('basic')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Project | null>(null)
  const [draft, setDraft] = useState<ProjectDraft>(EMPTY_DRAFT)
  const [tagEditorProject, setTagEditorProject] = useState<Project | null>(null)
  const [tagEditorName, setTagEditorName] = useState('')
  const [tagEditorColor, setTagEditorColor] = useState(PROJECT_COLORS[0])
  const [tagSaving, setTagSaving] = useState(false)
  const [memberSavingId, setMemberSavingId] = useState<number | null>(null)
  const [memberAddOpen, setMemberAddOpen] = useState(false)
  const [memberEditTarget, setMemberEditTarget] = useState<User | null>(null)
  const [memberEditDraft, setMemberEditDraft] = useState<ProjectMemberDraft | null>(null)
  const [memberEditSaving, setMemberEditSaving] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!user) return
    let alive = true
    Promise.all([api.listProjects(), api.listTags(), api.listUserDirectory()])
      .then(([projectList, tagList, userList]) => {
        if (!alive) return
        setProjects(projectList)
        setAllTags(tagList)
        setDirectoryUsers(userList)
        setSelectedId((current) => current ?? projectList[0]?.id ?? null)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setProjects([])
        setError(errMsg(err, '프로젝트 정보를 불러오지 못했습니다.'))
      })
    return () => {
      alive = false
    }
  }, [user])

  const filteredProjects = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return (projects ?? []).filter((project) => {
      if (!keyword) return true
      return [
        project.title,
        project.task_title,
        project.task_number,
        project.principal_investigator,
        project.research_institution,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(keyword))
    })
  }, [projects, query])

  useEffect(() => {
    if (projects === null) return
    if (filteredProjects.length === 0) {
      setSelectedId(null)
      return
    }
    if (!filteredProjects.some((project) => project.id === selectedId)) {
      setSelectedId(filteredProjects[0].id)
    }
  }, [filteredProjects, projects, selectedId])

  const selectedProject =
    selectedId === null ? null : projects?.find((project) => project.id === selectedId) ?? null

  const canManageProject = (project: Project) => isAdmin || project.created_by === user?.id

  const setField = <K extends keyof ProjectDraft>(key: K, value: ProjectDraft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  const mergeTagsIntoState = (tags: Tag[]) => {
    if (tags.length === 0) return
    setAllTags((prev) => {
      const byId = new Map(prev.map((tag) => [tag.id, tag]))
      tags.forEach((tag) => {
        byId.set(tag.id, { ...(byId.get(tag.id) ?? {}), ...tag })
      })
      return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'))
    })
  }

  const updateProjectInState = (updated: Project) => {
    mergeTagsIntoState(updated.tags)
    setProjects((prev) =>
      (prev ?? []).map((project) => (project.id === updated.id ? updated : project)),
    )
    setSelectedId(updated.id)
  }

  const updateUserInState = (updated: User) => {
    setDirectoryUsers((prev) => prev.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)))
    setProjects((prev) =>
      (prev ?? []).map((project) => ({
        ...project,
        members: project.members.map((member) => (member.id === updated.id ? { ...member, ...updated } : member)),
      })),
    )
  }

  const openCreate = () => {
    const nextColor = PROJECT_COLORS[(projects?.length ?? 0) % PROJECT_COLORS.length]
    setEditing(null)
    setDraft({
      ...EMPTY_DRAFT,
      color: nextColor,
      member_user_ids: user?.id ? [user.id] : [],
    })
    setActiveTab('basic')
    setError('')
    setModalOpen(true)
  }

  const openEdit = (project: Project) => {
    if (!canManageProject(project)) return
    setEditing(project)
    setDraft(toDraft(project))
    setActiveTab('basic')
    setError('')
    setModalOpen(true)
  }

  const closeModal = () => {
    if (saving) return
    setModalOpen(false)
    setEditing(null)
    setDraft(EMPTY_DRAFT)
  }

  const openTagEditor = (project: Project) => {
    if (!canManageProject(project)) return
    const primaryTag = project.tags[0]
    setTagEditorProject(project)
    setTagEditorName(primaryTag?.name ?? project.title)
    setTagEditorColor(primaryTag?.color ?? project.color ?? PROJECT_COLORS[0])
    setError('')
  }

  const closeTagEditor = () => {
    if (tagSaving) return
    setTagEditorProject(null)
    setTagEditorName('')
  }

  const saveProjectTags = async () => {
    const name = tagEditorName.trim()
    if (!tagEditorProject || tagSaving) return
    if (!name) {
      setError('태그 이름을 입력해주세요.')
      return
    }
    const primaryTag = tagEditorProject.tags[0]
    setError('')
    setTagSaving(true)
    try {
      const memberIds = tagEditorProject.members.map((member) => member.id)
      let savedTag: Tag
      if (primaryTag && primaryTag.can_manage !== false) {
        savedTag = await api.updateTag(primaryTag.id, {
          name,
          color: tagEditorColor,
          allowed_user_ids: memberIds,
        })
      } else {
        const existing = allTags.find((tag) => tag.name === name)
        if (existing) {
          savedTag = existing
        } else {
          savedTag = await api.createTag({
            name,
            color: tagEditorColor,
            allowed_user_ids: memberIds,
          })
        }
      }
      setAllTags((prev) => {
        const exists = prev.some((tag) => tag.id === savedTag.id)
        const next = exists
          ? prev.map((tag) => (tag.id === savedTag.id ? savedTag : tag))
          : [...prev, savedTag]
        return next.sort((a, b) => a.name.localeCompare(b.name, 'ko'))
      })
      const updated = await api.updateProject(tagEditorProject.id, {
        tag_ids: [savedTag.id],
        color: tagEditorColor,
      })
      updateProjectInState(updated)
      setTagEditorProject(null)
      setTagEditorName('')
    } catch (err: unknown) {
      setError(errMsg(err, '프로젝트 태그를 저장하지 못했습니다.'))
    } finally {
      setTagSaving(false)
    }
  }

  const saveProject = async (event: FormEvent) => {
    event.preventDefault()
    if (saving || !draft.title.trim()) return
    setSaving(true)
    setError('')
    try {
      if (editing) {
        const updated = await api.updateProject(editing.id, buildPayload(draft))
        updateProjectInState(updated)
      } else {
        const created = await api.createProject(buildPayload(draft))
        mergeTagsIntoState(created.tags)
        setProjects((prev) => [created, ...(prev ?? [])])
        setSelectedId(created.id)
      }
      setModalOpen(false)
      setEditing(null)
      setDraft(EMPTY_DRAFT)
    } catch (err: unknown) {
      setError(errMsg(err, '프로젝트 정보를 저장하지 못했습니다.'))
    } finally {
      setSaving(false)
    }
  }

  const deleteProject = async (project: Project) => {
    const ok = await confirm({
      title: `'${project.title}' 프로젝트를 삭제할까요?`,
      message: '삭제하면 프로젝트 관리 목록에서 사라집니다.',
      confirmLabel: '삭제',
      danger: true,
    })
    if (!ok) return
    setError('')
    try {
      await api.deleteProject(project.id)
      setProjects((prev) => (prev ?? []).filter((item) => item.id !== project.id))
      if (selectedId === project.id) {
        const next = filteredProjects.find((item) => item.id !== project.id)
        setSelectedId(next?.id ?? null)
      }
    } catch (err: unknown) {
      setError(errMsg(err, '프로젝트를 삭제하지 못했습니다.'))
    }
  }

  const saveProjectMembers = async (project: Project, nextIds: number[], targetUser?: User) => {
    if (memberSavingId !== null) return
    setMemberSavingId(targetUser?.id ?? 0)
    setError('')
    try {
      const updated = await api.updateProject(project.id, { member_user_ids: nextIds })
      updateProjectInState(updated)
    } catch (err: unknown) {
      setError(errMsg(err, '프로젝트 참여자를 저장하지 못했습니다.'))
    } finally {
      setMemberSavingId(null)
    }
  }

  const addProjectMember = async (project: Project, targetUser: User) => {
    const currentIds = project.members.map((member) => member.id)
    if (currentIds.includes(targetUser.id)) return
    await saveProjectMembers(project, [...currentIds, targetUser.id], targetUser)
  }

  const removeProjectMember = async (project: Project, targetUser: User) => {
    const nextIds = project.members
      .map((member) => member.id)
      .filter((id) => id !== targetUser.id)
    await saveProjectMembers(project, nextIds, targetUser)
  }

  const openProjectMemberEdit = (targetUser: User) => {
    if (!isAdmin) return
    setMemberEditTarget(targetUser)
    setMemberEditDraft(toProjectMemberDraft(targetUser))
    setError('')
  }

  const closeProjectMemberEdit = () => {
    if (memberEditSaving) return
    setMemberEditTarget(null)
    setMemberEditDraft(null)
  }

  const setMemberEditField = <K extends keyof ProjectMemberDraft>(
    key: K,
    value: ProjectMemberDraft[K],
  ) => {
    setMemberEditDraft((prev) => (prev ? { ...prev, [key]: value } : prev))
  }

  const saveProjectMemberEdit = async (event: FormEvent) => {
    event.preventDefault()
    if (!memberEditTarget || !memberEditDraft || memberEditSaving || !memberEditDraft.name.trim()) return
    setMemberEditSaving(true)
    setError('')
    try {
      const updated = await api.updateAdminUser(memberEditTarget.id, buildMemberPayload(memberEditDraft))
      updateUserInState(updated)
      setMemberEditTarget(null)
      setMemberEditDraft(null)
    } catch (err: unknown) {
      setError(errMsg(err, '프로젝트 참여자 정보를 수정하지 못했습니다.'))
    } finally {
      setMemberEditSaving(false)
    }
  }

  const renderTagChips = (tags: Tag[]) => {
    if (tags.length === 0) return <span className="project-muted-value">태그 없음</span>
    return (
      <div className="project-tag-chip-list">
        {tags.map((tag) => (
          <span key={tag.id} className="project-tag-chip" style={{ color: tag.color }}>
            #{tag.name}
          </span>
        ))}
      </div>
    )
  }

  const renderBasicInfo = (project: Project) => (
    <div className="project-info-table" aria-label="프로젝트 기본 정보">
      <div>
        <span>과제번호</span>
        <strong>{project.task_number || '-'}</strong>
      </div>
      <div>
        <span>과제명</span>
        <strong>{project.task_title || '-'}</strong>
      </div>
      <div>
        <span>연구책임자</span>
        <strong>{project.principal_investigator || '-'}</strong>
      </div>
      <div>
        <span>연구기관</span>
        <strong>{project.research_institution || '-'}</strong>
      </div>
      <div>
        <span>태그</span>
        <strong className="project-info-tags">
          {renderTagChips(project.tags)}
        </strong>
      </div>
      <div>
        <span>연구기간</span>
        <strong>{formatPeriod(project)}</strong>
      </div>
    </div>
  )

  const renderMembers = (project: Project) => {
    const memberIds = project.members.map((member) => member.id)
    const availableUsers = directoryUsers.filter((item) => !memberIds.includes(item.id))
    const canManage = canManageProject(project)
    const groups = groupUsersByOrganization(project.members)
    return (
      <div className="project-members-panel">
        <div className="project-members-directory-head">
          <div className="project-members-title-block">
            <span className="project-members-title-icon">
              <UsersIcon />
            </span>
            <div>
              <h3>참여자</h3>
              <p>프로젝트 참여자에게는 이 프로젝트에 연결된 태그가 회의 목록과 회의 기록에 표시됩니다.</p>
            </div>
          </div>
          <div className="project-members-toolbar">
            <span className="project-members-total">{memberIds.length}명</span>
            {canManage && (
              <button type="button" className="btn btn-primary" onClick={() => setMemberAddOpen(true)}>
                + 추가
              </button>
            )}
            {!canManage && <span className="project-readonly-badge">읽기 전용</span>}
          </div>
        </div>

        <div className="project-member-org-list">
          {groups.length === 0 ? (
            <div className="project-member-empty">아직 추가된 참여자가 없습니다.</div>
          ) : (
            groups.map((group) => (
              <section key={group.name} className="project-member-org-card">
                <div className="project-member-org-head">
                  <span className="project-member-chevron">
                    <ChevronDownIcon />
                  </span>
                  <span className="project-member-org-icon">
                    <BuildingIcon />
                  </span>
                  <strong>{group.name}</strong>
                  <span className="project-member-count">{group.users.length}명</span>
                </div>

                <div className={`project-member-table${canManage ? ' with-actions' : ''}`}>
                  <div className="project-member-table-head">
                    <span>이름</span>
                    <span>ID</span>
                    <span>부서</span>
                    <span>직책</span>
                    <span>이메일</span>
                    {canManage && <span>관리</span>}
                  </div>
                  {group.users.map((item) => (
                    <div key={item.id} className="project-member-table-row">
                      <span className="project-member-name-cell">
                        <span className="project-member-avatar">{item.name.slice(0, 1)}</span>
                        <strong>{item.name}</strong>
                      </span>
                      <span className="project-member-id-cell">{item.username}</span>
                      <span>{item.department || '-'}</span>
                      <span>{item.position || '-'}</span>
                      <span>{displayUserEmail(item)}</span>
                      {canManage && (
                        <span className="project-member-action-cell">
                          {isAdmin && (
                            <button
                              type="button"
                              className="btn-icon project-member-edit-icon"
                              disabled={memberEditSaving}
                              onClick={() => openProjectMemberEdit(item)}
                              aria-label={`${item.name} 참여자 수정`}
                              title="참여자 수정"
                            >
                              <EditIcon />
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn-icon project-member-remove-icon"
                            disabled={memberSavingId !== null}
                            onClick={() => void removeProjectMember(project, item)}
                            aria-label={`${item.name} 참여자 삭제`}
                            title="참여자 삭제"
                          >
                            <TrashIcon />
                          </button>
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            ))
          )}
        </div>

        {canManage && memberAddOpen && selectedProject?.id === project.id && (
          <Modal open title="프로젝트 참여자 추가" width={640} onClose={() => setMemberAddOpen(false)}>
            <div className="project-member-add-modal">
              <div className="project-member-add-head">
                <strong>{project.title}</strong>
                <span>{availableUsers.length}명 추가 가능</span>
              </div>
              <div className="project-member-add-list">
                {availableUsers.length === 0 ? (
                  <div className="project-member-empty">추가할 사용자가 없습니다.</div>
                ) : (
                  availableUsers.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className="project-member-add-card"
                      disabled={memberSavingId !== null}
                      onClick={() => void addProjectMember(project, item)}
                    >
                      <span className="project-member-avatar">{item.name.slice(0, 1)}</span>
                      <span className="project-member-text">
                        <strong>{item.name}</strong>
                        <small>
                          {[item.organization, item.department, item.position].filter(Boolean).join(' · ') ||
                            item.username}
                        </small>
                      </span>
                      <span className="project-member-action">
                        {memberSavingId === item.id ? '추가 중' : '추가'}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>
          </Modal>
        )}
      </div>
    )
  }

  return (
    <div className="page project-admin-page">
      <div className="project-admin-head">
        <div className="project-title-wrap">
          <span className="project-title-icon">
            <FolderIcon />
          </span>
          <div>
            <h1 className="page-title">프로젝트 관리</h1>
            <p className="project-admin-subtitle">프로젝트를 생성하고 기본 정보와 참여자를 관리할 수 있습니다.</p>
          </div>
        </div>
        <div className="project-admin-actions">
          <label className="project-search">
            <SearchIcon />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="프로젝트 이름 검색"
            />
          </label>
          <button type="button" className="btn btn-primary" onClick={openCreate}>
            + 프로젝트 추가
          </button>
        </div>
      </div>

      <div className="project-total-row">
        <span>총 {filteredProjects.length}개 프로젝트</span>
      </div>

      {error && <div className="project-admin-error">{error}</div>}

      <div className="project-admin-layout">
        <aside className="card project-list-card" aria-label="프로젝트 목록">
          {projects === null ? (
            <div className="project-loading">
              <span className="spinner" />
            </div>
          ) : filteredProjects.length === 0 ? (
            <div className="project-list-empty">조건에 맞는 프로젝트가 없습니다.</div>
          ) : (
            <div className="project-list">
              {filteredProjects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  className={`project-list-item${selectedId === project.id ? ' active' : ''}`}
                  onClick={() => {
                    setSelectedId(project.id)
                    setActiveTab('basic')
                    setMemberAddOpen(false)
                  }}
                >
                  <span className="project-list-dot" style={{ background: project.color }} />
                  <span className="project-list-text">
                    <strong>
                      <span>{project.title}</span>
                      {project.members.some((member) => member.id === user?.id) && (
                        <em className="project-list-member-badge">참여자</em>
                      )}
                    </strong>
                    <small>{project.task_number || project.research_institution || '기본 정보 미입력'}</small>
                  </span>
                </button>
              ))}
            </div>
          )}
        </aside>

        <section className="card project-detail-card" aria-label="프로젝트 상세">
          {selectedProject ? (
            <>
              <div className="project-detail-top">
                <div className="project-detail-title">
                  <span className="project-detail-dot" style={{ background: selectedProject.color }} />
                  <div>
                    <h2>{selectedProject.title}</h2>
                    <div className="project-detail-meta">
                      <span className="project-detail-meta-text">{selectedProject.task_number || '과제번호 없음'}</span>
                      <span className="project-detail-meta-tags">{renderTagChips(selectedProject.tags)}</span>
                      {canManageProject(selectedProject) && (
                        <button
                          type="button"
                          className="btn btn-ghost project-header-tag-btn"
                          onClick={() => openTagEditor(selectedProject)}
                        >
                          태그 설정
                        </button>
                      )}
                    </div>
                  </div>
                </div>
                {canManageProject(selectedProject) && (
                  <div className="project-detail-actions">
                    <button type="button" className="btn btn-ghost" onClick={() => openEdit(selectedProject)}>
                      <EditIcon />
                      수정
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger"
                      onClick={() => void deleteProject(selectedProject)}
                    >
                      <TrashIcon />
                      삭제
                    </button>
                  </div>
                )}
              </div>

              <nav className="project-detail-tabs" aria-label="프로젝트 상세 탭">
                {DETAIL_TABS.map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    className={activeTab === tab.key ? 'active' : ''}
                    onClick={() => setActiveTab(tab.key)}
                  >
                    {tab.label}
                  </button>
                ))}
              </nav>

              <div className="project-detail-section">
                {activeTab === 'basic' ? renderBasicInfo(selectedProject) : renderMembers(selectedProject)}
              </div>
            </>
          ) : (
            <div className="project-detail-empty">
              <FolderIcon />
              <strong>선택된 프로젝트가 없습니다.</strong>
              <span>프로젝트를 추가하면 상세 정보가 표시됩니다.</span>
            </div>
          )}
        </section>
      </div>

      <Modal
        open={modalOpen}
        title={editing ? '프로젝트 수정' : '프로젝트 추가'}
        width={780}
        onClose={closeModal}
      >
        <form className="project-form" onSubmit={saveProject}>
          <div className="project-form-grid">
            <label className="project-form-field">
              <span>프로젝트 이름 *</span>
              <input
                className="input"
                value={draft.title}
                onChange={(event) => setField('title', event.target.value)}
                placeholder="프로젝트 이름을 작성해주세요"
                required
              />
            </label>
            <label className="project-form-field">
              <span>과제번호</span>
              <input
                className="input"
                value={draft.task_number}
                onChange={(event) => setField('task_number', event.target.value)}
                placeholder="과제번호를 작성해주세요"
              />
            </label>
            <label className="project-form-field project-form-field-wide">
              <span>과제명</span>
              <input
                className="input"
                value={draft.task_title}
                onChange={(event) => setField('task_title', event.target.value)}
                placeholder="연구 과제명을 작성해주세요"
              />
            </label>
            <label className="project-form-field">
              <span>연구책임자</span>
              <input
                className="input"
                value={draft.principal_investigator}
                onChange={(event) => setField('principal_investigator', event.target.value)}
                placeholder="연구책임자를 작성해주세요"
              />
            </label>
            <label className="project-form-field">
              <span>연구기관</span>
              <input
                className="input"
                value={draft.research_institution}
                onChange={(event) => setField('research_institution', event.target.value)}
                placeholder="연구기관을 작성해주세요"
              />
            </label>
            <div className="project-form-field project-form-field-wide">
              <span>연구기간</span>
              <div className="project-period-fields">
                <input
                  className="input"
                  type="date"
                  value={draft.period_start}
                  onChange={(event) => setField('period_start', event.target.value)}
                />
                <span>~</span>
                <input
                  className="input"
                  type="date"
                  value={draft.period_end}
                  onChange={(event) => setField('period_end', event.target.value)}
                />
              </div>
            </div>
          </div>

          <div className="project-form-actions">
            <button type="button" className="btn btn-ghost" onClick={closeModal} disabled={saving}>
              취소
            </button>
            <button type="submit" className="btn btn-primary" disabled={!draft.title.trim() || saving}>
              {saving ? '저장 중...' : '저장'}
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        open={Boolean(tagEditorProject)}
        title="태그 설정"
        width={820}
        onClose={closeTagEditor}
      >
        {tagEditorProject && (
          <div className="project-tag-editor">
            <div className="project-tag-editor-simple-row">
              <span className="project-tag-editor-dot" style={{ background: tagEditorColor }} />
              <input
                className="project-tag-editor-input"
                value={tagEditorName}
                onChange={(event) => setTagEditorName(event.target.value)}
                placeholder="태그 이름을 작성해주세요"
                autoFocus
              />
              <div className="project-color-palette" role="group" aria-label="태그 색상 선택">
                {PROJECT_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={`project-color-swatch${tagEditorColor === color ? ' selected' : ''}`}
                    style={{ background: color }}
                    aria-label={`색상 ${color}`}
                    aria-pressed={tagEditorColor === color}
                    onClick={() => setTagEditorColor(color)}
                  />
                ))}
                <label
                  className={`project-color-swatch project-color-custom${
                    PROJECT_COLORS.includes(tagEditorColor) ? '' : ' selected'
                  }`}
                  style={PROJECT_COLORS.includes(tagEditorColor) ? undefined : { background: tagEditorColor }}
                  title="직접 색상 선택"
                >
                  <input
                    type="color"
                    value={tagEditorColor}
                    onChange={(event) => setTagEditorColor(event.target.value)}
                    aria-label="직접 색상 선택"
                  />
                </label>
              </div>
              <button
                type="button"
                className="btn btn-primary project-tag-save-btn"
                disabled={!tagEditorName.trim() || tagSaving}
                onClick={() => void saveProjectTags()}
              >
                {tagSaving ? '저장 중...' : '저장'}
              </button>
              <button
                type="button"
                className="btn btn-ghost project-tag-cancel-btn"
                onClick={closeTagEditor}
                disabled={tagSaving}
              >
                취소
              </button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={Boolean(memberEditTarget && memberEditDraft)}
        title="프로젝트 참여자 수정"
        width={720}
        onClose={closeProjectMemberEdit}
      >
        {memberEditTarget && memberEditDraft && (
          <form className="project-form" onSubmit={saveProjectMemberEdit}>
            <div className="project-form-grid">
              <label className="project-form-field">
                <span>이름 *</span>
                <input
                  className="input"
                  value={memberEditDraft.name}
                  onChange={(event) => setMemberEditField('name', event.target.value)}
                  placeholder="이름"
                  required
                />
              </label>
              <label className="project-form-field">
                <span>소속</span>
                <input
                  className="input"
                  value={memberEditDraft.organization}
                  onChange={(event) => setMemberEditField('organization', event.target.value)}
                  placeholder="소속"
                />
              </label>
              <label className="project-form-field">
                <span>부서</span>
                <input
                  className="input"
                  value={memberEditDraft.department}
                  onChange={(event) => setMemberEditField('department', event.target.value)}
                  placeholder="부서"
                />
              </label>
              <label className="project-form-field">
                <span>직책</span>
                <input
                  className="input"
                  value={memberEditDraft.position}
                  onChange={(event) => setMemberEditField('position', event.target.value)}
                  placeholder="직책"
                />
              </label>
              <label className="project-form-field project-form-field-wide">
                <span>이메일</span>
                <input
                  className="input"
                  type="email"
                  value={memberEditDraft.email}
                  onChange={(event) => setMemberEditField('email', event.target.value)}
                  placeholder="name@example.com"
                />
              </label>
            </div>

            <div className="project-form-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={closeProjectMemberEdit}
                disabled={memberEditSaving}
              >
                취소
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={!memberEditDraft.name.trim() || memberEditSaving}
              >
                {memberEditSaving ? '저장 중...' : '저장'}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  )
}
