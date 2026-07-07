import { useEffect, useMemo, useState } from 'react'
import type { FormEvent, KeyboardEvent, MouseEvent } from 'react'
import { api } from '../api'
import AiEngineSettings from '../components/AiEngineSettings'
import { Avatar } from '../components/Avatar'
import ComboBox from '../components/ComboBox'
import { useConfirm } from '../components/confirm'
import type { OrgKind, OrgOption, Participant, Tag } from '../types'
import './SettingsPage.css'

/** 태그 색 팔레트 (SPEC — 백엔드 자동 배정 팔레트와 동일) */
const TAG_PALETTE = [
  '#16a34a',
  '#2563eb',
  '#e8590c',
  '#7048e8',
  '#d6336c',
  '#0ca678',
  '#f08c00',
  '#1098ad',
]

const SECTIONS = [
  { id: 'tags', label: '태그 · 프로젝트', icon: '🏷️' },
  { id: 'people', label: '참석자', icon: '👥' },
  { id: 'ai', label: 'AI 요약 엔진', icon: '✨' },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

const isSectionId = (id: string): id is SectionId => SECTIONS.some((s) => s.id === id)

const errMsg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback)

const sortTags = (list: Tag[]) => [...list].sort((a, b) => a.name.localeCompare(b.name, 'ko'))

const sortOrgOptions = (list: OrgOption[]) =>
  [...list].sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name, 'ko') : a.kind.localeCompare(b.kind),
  )

/** 소속 미지정 그룹 키 (조직 이름과 충돌하지 않는 값) */
const NO_ORG_KEY = '__no_org__'

interface ParticipantDraft {
  name: string
  organization: string
  department: string
  role: string
  email: string
  phone: string
}

const EMPTY_DRAFT: ParticipantDraft = {
  name: '',
  organization: '',
  department: '',
  role: '',
  email: '',
  phone: '',
}

/* ---------- 태그 색 선택 (8색 팔레트 + 커스텀 피커) ---------- */

interface ColorPalettePickerProps {
  value: string | null
  onChange: (color: string | null) => void
  /** true면 선택된 스와치를 다시 눌러 해제(자동 배정) 가능 */
  allowClear?: boolean
}

function ColorPalettePicker({ value, onChange, allowClear = false }: ColorPalettePickerProps) {
  const isCustom = value !== null && !TAG_PALETTE.includes(value)
  return (
    <div className="sp-palette" role="group" aria-label="태그 색 선택">
      {TAG_PALETTE.map((c) => (
        <button
          key={c}
          type="button"
          className={`sp-swatch${value === c ? ' selected' : ''}`}
          style={{ background: c }}
          aria-label={`색상 ${c}`}
          aria-pressed={value === c}
          title={allowClear && value === c ? '선택 해제 (자동 배정)' : c}
          onClick={() => onChange(allowClear && value === c ? null : c)}
        />
      ))}
      <label
        className={`sp-swatch sp-swatch-custom${isCustom ? ' selected' : ''}`}
        style={isCustom ? { background: value } : undefined}
        title="원하는 색 직접 선택"
      >
        <input
          type="color"
          className="sp-color-input"
          value={isCustom ? value : '#2563eb'}
          onChange={(e) => onChange(e.target.value)}
          aria-label="커스텀 색 선택"
        />
      </label>
    </div>
  )
}

/* ---------- 설정 페이지 ---------- */

export default function SettingsPage() {
  const confirm = useConfirm()

  // 탭 — URL 해시(#tags/#people/#ai)와 동기화
  const [activeSection, setActiveSection] = useState<SectionId>(() => {
    const id = window.location.hash.slice(1)
    return isSectionId(id) ? id : 'tags'
  })

  // 태그 · 프로젝트
  const [tags, setTags] = useState<Tag[] | null>(null)
  const [tagError, setTagError] = useState('')
  const [tagName, setTagName] = useState('')
  const [tagColor, setTagColor] = useState<string | null>(null)
  const [tagAdding, setTagAdding] = useState(false)
  const [editingTagId, setEditingTagId] = useState<number | null>(null)
  const [editTagName, setEditTagName] = useState('')
  const [editTagColor, setEditTagColor] = useState<string | null>(null)
  const [tagSaving, setTagSaving] = useState(false)

  // 소속/부서/직책 사전 (참석자 콤보박스 제안 목록)
  const [orgOptions, setOrgOptions] = useState<OrgOption[] | null>(null)

  // 참석자 디렉터리
  const [participants, setParticipants] = useState<Participant[] | null>(null)
  const [peopleError, setPeopleError] = useState('')
  const [draft, setDraft] = useState<ParticipantDraft>(EMPTY_DRAFT)
  const [pAdding, setPAdding] = useState(false)
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})
  const [editingId, setEditingId] = useState<number | null>(null)
  const [edit, setEdit] = useState<ParticipantDraft>(EMPTY_DRAFT)
  const [savingEdit, setSavingEdit] = useState(false)

  // 초기 데이터 로드
  useEffect(() => {
    let alive = true
    api
      .listTags()
      .then((list) => {
        if (alive) setTags(sortTags(list))
      })
      .catch((e: unknown) => {
        if (alive) {
          setTags([])
          setTagError(errMsg(e, '태그 목록을 불러오지 못했어요'))
        }
      })
    api
      .listOrgOptions()
      .then((list) => {
        if (alive) setOrgOptions(sortOrgOptions(list))
      })
      .catch(() => {
        // 제안 목록을 못 불러와도 자유 입력은 계속 가능하므로 조용히 무시
        if (alive) setOrgOptions([])
      })
    api
      .listParticipants()
      .then((list) => {
        if (alive) setParticipants(list)
      })
      .catch((e: unknown) => {
        if (alive) {
          setParticipants([])
          setPeopleError(errMsg(e, '참석자 목록을 불러오지 못했어요'))
        }
      })
    return () => {
      alive = false
    }
  }, [])

  // 주소창에서 해시를 직접 바꾼 경우 탭 동기화
  useEffect(() => {
    const onHashChange = () => {
      const id = window.location.hash.slice(1)
      if (isSectionId(id)) setActiveSection(id)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const goToSection = (id: SectionId) => {
    setActiveSection(id)
    window.history.replaceState(null, '', `#${id}`)
  }

  /* ----- 태그 CRUD ----- */

  const handleAddTag = async (e: FormEvent) => {
    e.preventDefault()
    const name = tagName.trim()
    if (!name || tagAdding) return
    setTagAdding(true)
    setTagError('')
    try {
      const created = await api.createTag(tagColor ? { name, color: tagColor } : { name })
      setTags((prev) => sortTags([...(prev ?? []), created]))
      setTagName('')
      setTagColor(null)
    } catch (err: unknown) {
      setTagError(errMsg(err, '태그를 추가하지 못했어요'))
    } finally {
      setTagAdding(false)
    }
  }

  const startTagEdit = (t: Tag) => {
    setEditingTagId(t.id)
    setEditTagName(t.name)
    setEditTagColor(t.color)
  }

  const handleTagEditSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (editingTagId === null || tagSaving) return
    const name = editTagName.trim()
    if (!name) return
    const current = (tags ?? []).find((t) => t.id === editingTagId)
    const data: { name?: string; color?: string } = {}
    if (!current || current.name !== name) data.name = name
    if (editTagColor && (!current || current.color !== editTagColor)) data.color = editTagColor
    if (Object.keys(data).length === 0) {
      setEditingTagId(null)
      return
    }
    setTagSaving(true)
    setTagError('')
    try {
      const updated = await api.updateTag(editingTagId, data)
      setTags((prev) => sortTags((prev ?? []).map((t) => (t.id === updated.id ? updated : t))))
      setEditingTagId(null)
    } catch (err: unknown) {
      setTagError(errMsg(err, '태그를 수정하지 못했어요'))
    } finally {
      setTagSaving(false)
    }
  }

  const handleDeleteTag = async (t: Tag, e: MouseEvent) => {
    e.stopPropagation()
    const ok = await confirm({
      title: `'${t.name}' 태그를 삭제할까요?`,
      message: '기존 회의에 표시된 태그는 그대로 남아요.',
      confirmLabel: '삭제',
      danger: true,
    })
    if (!ok) return
    setTagError('')
    try {
      await api.deleteTag(t.id)
      setTags((prev) => (prev ?? []).filter((x) => x.id !== t.id))
      if (editingTagId === t.id) setEditingTagId(null)
    } catch (err: unknown) {
      setTagError(errMsg(err, '태그를 삭제하지 못했어요'))
    }
  }

  /* ----- 소속/부서/직책 사전 (ComboBox 연동) ----- */

  /** ComboBox "+ 추가" — org-options 사전에 등록. 중복(400) 등 실패는 조용히 무시 */
  const registerOrgOption = (kind: OrgKind) => (rawName: string) => {
    const name = rawName.trim()
    if (!name) return
    if ((orgOptions ?? []).some((o) => o.kind === kind && o.name === name)) return
    api
      .createOrgOption({ kind, name })
      .then((created) => {
        setOrgOptions((prev) => {
          if ((prev ?? []).some((o) => o.kind === kind && o.name === name)) return prev
          return sortOrgOptions([...(prev ?? []), created])
        })
      })
      .catch(() => {
        /* 이미 등록돼 있어요(400) 등은 조용히 무시 */
      })
  }

  /** ComboBox 옵션 × — 이름→id 매핑해 org-options에서 삭제, 목록 로컬 갱신 */
  const removeOrgOption = (kind: OrgKind) => (name: string) => {
    const target = (orgOptions ?? []).find((o) => o.kind === kind && o.name === name)
    if (!target) return
    setPeopleError('')
    api
      .deleteOrgOption(target.id)
      .then(() => {
        setOrgOptions((prev) => (prev ?? []).filter((o) => o.id !== target.id))
      })
      .catch((err: unknown) => {
        setPeopleError(errMsg(err, '항목을 삭제하지 못했어요'))
      })
  }

  const organizationNames = (orgOptions ?? [])
    .filter((o) => o.kind === 'organization')
    .map((o) => o.name)
  const departmentNames = (orgOptions ?? [])
    .filter((o) => o.kind === 'department')
    .map((o) => o.name)
  const roleNames = (orgOptions ?? []).filter((o) => o.kind === 'role').map((o) => o.name)

  /* ----- 참석자 CRUD ----- */

  // 소속(organization)별 그룹 — 이름 가나다순, '소속 미지정'은 마지막
  const participantGroups = useMemo(() => {
    if (!participants) return []
    const map = new Map<string, Participant[]>()
    for (const p of participants) {
      const key = (p.organization ?? '').trim()
      const list = map.get(key)
      if (list) list.push(p)
      else map.set(key, [p])
    }
    const groups = [...map.entries()]
      .filter(([org]) => org !== '')
      .sort((a, b) => a[0].localeCompare(b[0], 'ko'))
      .map(([org, list]) => ({ key: org, name: org, list }))
    const noOrg = map.get('')
    if (noOrg) groups.push({ key: NO_ORG_KEY, name: '', list: noOrg })
    for (const g of groups) g.list.sort((a, b) => a.name.localeCompare(b.name, 'ko'))
    return groups
  }, [participants])

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const setDraftField = (key: keyof ParticipantDraft, value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  const setEditField = (key: keyof ParticipantDraft, value: string) => {
    setEdit((prev) => ({ ...prev, [key]: value }))
  }

  const handleAddParticipant = async (e: FormEvent) => {
    e.preventDefault()
    const name = draft.name.trim()
    if (!name || pAdding) return
    setPAdding(true)
    setPeopleError('')
    try {
      const data: {
        name: string
        organization?: string
        department?: string
        role?: string
        email?: string
        phone?: string
      } = { name }
      if (draft.organization.trim()) data.organization = draft.organization.trim()
      if (draft.department.trim()) data.department = draft.department.trim()
      if (draft.role.trim()) data.role = draft.role.trim()
      if (draft.email.trim()) data.email = draft.email.trim()
      if (draft.phone.trim()) data.phone = draft.phone.trim()
      const created = await api.createParticipant(data)
      setParticipants((prev) => [...(prev ?? []), created])
      setDraft(EMPTY_DRAFT)
    } catch (err: unknown) {
      setPeopleError(errMsg(err, '참석자를 추가하지 못했어요'))
    } finally {
      setPAdding(false)
    }
  }

  const startEdit = (p: Participant) => {
    setEditingId(p.id)
    setEdit({
      name: p.name,
      organization: p.organization ?? '',
      department: p.department ?? '',
      role: p.role ?? '',
      email: p.email ?? '',
      phone: p.phone ?? '',
    })
  }

  const cancelEdit = () => {
    setEditingId(null)
  }

  const saveEdit = async () => {
    if (editingId === null || savingEdit) return
    const name = edit.name.trim()
    if (!name) return
    setSavingEdit(true)
    setPeopleError('')
    try {
      // 빈 문자열은 백엔드에서 NULL 처리됨 (값 비우기)
      const updated = await api.updateParticipant(editingId, {
        name,
        organization: edit.organization.trim(),
        department: edit.department.trim(),
        role: edit.role.trim(),
        email: edit.email.trim(),
        phone: edit.phone.trim(),
      })
      setParticipants((prev) => (prev ?? []).map((x) => (x.id === updated.id ? updated : x)))
      setEditingId(null)
    } catch (err: unknown) {
      setPeopleError(errMsg(err, '참석자 정보를 수정하지 못했어요'))
    } finally {
      setSavingEdit(false)
    }
  }

  const handleEditKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void saveEdit()
    } else if (e.key === 'Escape') {
      cancelEdit()
    }
  }

  const handleDeleteParticipant = async (p: Participant, e: MouseEvent) => {
    e.stopPropagation()
    const ok = await confirm({
      title: `'${p.name}' 참석자를 삭제할까요?`,
      message: '참석자 디렉터리에서 제거돼요. 기존 회의 기록에는 영향을 주지 않아요.',
      confirmLabel: '삭제',
      danger: true,
    })
    if (!ok) return
    setPeopleError('')
    try {
      await api.deleteParticipant(p.id)
      setParticipants((prev) => (prev ?? []).filter((x) => x.id !== p.id))
      if (editingId === p.id) setEditingId(null)
    } catch (err: unknown) {
      setPeopleError(errMsg(err, '참석자를 삭제하지 못했어요'))
    }
  }

  /* ----- 렌더 ----- */

  const renderTagsSection = () => (
    <section className="card settings-card">
      <div className="settings-card-head">
        <h2 className="settings-card-title">
          <span aria-hidden="true">🏷️</span> 태그 · 프로젝트
        </h2>
        <p className="settings-card-desc">
          회의를 프로젝트/과제별로 분류합니다 (예: Consurt, Panicare, AX Sprint).
        </p>
      </div>

      {tagError && <div className="sp-error">{tagError}</div>}

      <form className="sp-tag-add" onSubmit={handleAddTag}>
        <input
          className="input sp-tag-name-input"
          placeholder="새 태그 이름"
          value={tagName}
          onChange={(e) => setTagName(e.target.value)}
        />
        <ColorPalettePicker value={tagColor} onChange={setTagColor} allowClear />
        <button type="submit" className="btn btn-primary" disabled={!tagName.trim() || tagAdding}>
          {tagAdding ? '추가 중...' : '추가'}
        </button>
      </form>
      <p className="sp-hint">
        색을 고르지 않으면 팔레트에서 자동으로 배정돼요. 맨 끝 무지개 스와치로 원하는 색을 직접 고를
        수도 있어요.
      </p>

      {tags === null ? (
        <div className="sp-loading">
          <span className="spinner" />
        </div>
      ) : tags.length === 0 ? (
        <p className="sp-empty">등록된 태그가 없어요. 위에서 첫 태그를 만들어보세요.</p>
      ) : (
        <ul className="sp-tag-list">
          {tags.map((t) => (
            <li key={t.id} className="sp-tag-row">
              <span
                className="sp-dot"
                style={{ background: editingTagId === t.id ? (editTagColor ?? t.color) : t.color }}
              />
              {editingTagId === t.id ? (
                <form className="sp-inline-form sp-tag-edit-form" onSubmit={handleTagEditSubmit}>
                  <input
                    autoFocus
                    className="input sp-inline-input"
                    value={editTagName}
                    onChange={(e) => setEditTagName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setEditingTagId(null)
                    }}
                  />
                  <ColorPalettePicker value={editTagColor} onChange={setEditTagColor} />
                  <button
                    type="submit"
                    className="btn btn-soft"
                    disabled={!editTagName.trim() || tagSaving}
                  >
                    {tagSaving ? '저장 중...' : '저장'}
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => setEditingTagId(null)}>
                    취소
                  </button>
                </form>
              ) : (
                <>
                  <span className="sp-tag-name">{t.name}</span>
                  <div className="sp-row-actions">
                    <button
                      type="button"
                      className="btn-icon"
                      title="이름/색 수정"
                      aria-label={`${t.name} 수정`}
                      onClick={() => startTagEdit(t)}
                    >
                      ✏️
                    </button>
                    <button
                      type="button"
                      className="btn-icon sp-icon-danger"
                      title="삭제"
                      aria-label={`${t.name} 삭제`}
                      onClick={(e) => handleDeleteTag(t, e)}
                    >
                      🗑
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )

  const renderPersonRow = (p: Participant) =>
    editingId === p.id ? (
      <tr key={p.id} className="sp-row-editing">
        <td colSpan={6}>
          <div className="sp-edit-form">
            <div className="sp-edit-grid">
              <label className="sp-edit-field">
                <span className="sp-edit-label">이름 *</span>
                <div className="sp-cell-name">
                  <Avatar name={edit.name || p.name} color={p.color} size={28} />
                  <input
                    autoFocus
                    className="input sp-inline-input"
                    value={edit.name}
                    onChange={(e) => setEditField('name', e.target.value)}
                    onKeyDown={handleEditKeyDown}
                    placeholder="이름"
                  />
                </div>
              </label>
              <div className="sp-edit-field">
                <span className="sp-edit-label">소속 (회사/기관)</span>
                <ComboBox
                  value={edit.organization}
                  onChange={(v) => setEditField('organization', v)}
                  options={organizationNames}
                  placeholder="소속"
                  onCreateOption={registerOrgOption('organization')}
                  onDeleteOption={removeOrgOption('organization')}
                />
              </div>
              <div className="sp-edit-field">
                <span className="sp-edit-label">부서</span>
                <ComboBox
                  value={edit.department}
                  onChange={(v) => setEditField('department', v)}
                  options={departmentNames}
                  placeholder="부서"
                  onCreateOption={registerOrgOption('department')}
                  onDeleteOption={removeOrgOption('department')}
                />
              </div>
              <div className="sp-edit-field">
                <span className="sp-edit-label">직책</span>
                <ComboBox
                  value={edit.role}
                  onChange={(v) => setEditField('role', v)}
                  options={roleNames}
                  placeholder="직책"
                  onCreateOption={registerOrgOption('role')}
                  onDeleteOption={removeOrgOption('role')}
                />
              </div>
              <label className="sp-edit-field">
                <span className="sp-edit-label">이메일</span>
                <input
                  className="input sp-inline-input"
                  type="email"
                  value={edit.email}
                  onChange={(e) => setEditField('email', e.target.value)}
                  onKeyDown={handleEditKeyDown}
                  placeholder="name@example.com"
                />
              </label>
              <label className="sp-edit-field">
                <span className="sp-edit-label">전화</span>
                <input
                  className="input sp-inline-input"
                  value={edit.phone}
                  onChange={(e) => setEditField('phone', e.target.value)}
                  onKeyDown={handleEditKeyDown}
                  placeholder="010-0000-0000"
                />
              </label>
            </div>
            <div className="sp-edit-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void saveEdit()}
                disabled={!edit.name.trim() || savingEdit}
              >
                {savingEdit ? '저장 중...' : '저장'}
              </button>
              <button type="button" className="btn btn-ghost" onClick={cancelEdit}>
                취소
              </button>
            </div>
          </div>
        </td>
      </tr>
    ) : (
      <tr key={p.id} className="sp-row" onClick={() => startEdit(p)}>
        <td>
          <div className="sp-cell-name">
            <Avatar name={p.name} color={p.color} size={28} />
            <span>{p.name}</span>
          </div>
        </td>
        <td className="sp-cell-muted">{p.department || '—'}</td>
        <td className="sp-cell-muted">{p.role || '—'}</td>
        <td className="sp-cell-muted">{p.email || '—'}</td>
        <td className="sp-cell-muted">{p.phone || '—'}</td>
        <td className="sp-td-actions">
          <button
            type="button"
            className="btn-icon"
            title="수정"
            aria-label={`${p.name} 수정`}
            onClick={(e) => {
              e.stopPropagation()
              startEdit(p)
            }}
          >
            ✏️
          </button>
          <button
            type="button"
            className="btn-icon sp-icon-danger"
            title="삭제"
            aria-label={`${p.name} 삭제`}
            onClick={(e) => handleDeleteParticipant(p, e)}
          >
            🗑
          </button>
        </td>
      </tr>
    )

  const renderPeopleSection = () => (
    <section className="card settings-card">
      <div className="settings-card-head">
        <h2 className="settings-card-title">
          <span aria-hidden="true">👥</span> 참석자
        </h2>
        <p className="settings-card-desc">
          회의에 참석하는 사람들의 디렉터리입니다. 소속별로 묶어서 보여드려요. 행을 클릭하면 바로
          수정할 수 있어요.
        </p>
      </div>

      {peopleError && <div className="sp-error">{peopleError}</div>}

      <form className="sp-people-add" onSubmit={handleAddParticipant}>
        <input
          className="input"
          placeholder="이름 *"
          value={draft.name}
          onChange={(e) => setDraftField('name', e.target.value)}
        />
        <ComboBox
          value={draft.organization}
          onChange={(v) => setDraftField('organization', v)}
          options={organizationNames}
          placeholder="소속 (회사/기관)"
          onCreateOption={registerOrgOption('organization')}
          onDeleteOption={removeOrgOption('organization')}
        />
        <ComboBox
          value={draft.department}
          onChange={(v) => setDraftField('department', v)}
          options={departmentNames}
          placeholder="부서"
          onCreateOption={registerOrgOption('department')}
          onDeleteOption={removeOrgOption('department')}
        />
        <ComboBox
          value={draft.role}
          onChange={(v) => setDraftField('role', v)}
          options={roleNames}
          placeholder="직책"
          onCreateOption={registerOrgOption('role')}
          onDeleteOption={removeOrgOption('role')}
        />
        <input
          className="input sp-add-email"
          type="email"
          placeholder="이메일"
          value={draft.email}
          onChange={(e) => setDraftField('email', e.target.value)}
        />
        <input
          className="input"
          placeholder="전화"
          value={draft.phone}
          onChange={(e) => setDraftField('phone', e.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={!draft.name.trim() || pAdding}>
          {pAdding ? '추가 중...' : '+ 추가'}
        </button>
      </form>
      <p className="sp-hint">
        소속/부서/직책은 목록에서 고르거나 직접 입력할 수 있어요. 드롭다운의 ‘+ 추가’로 제안
        목록에 등록하고, × 로 목록에서 뺄 수 있어요.
      </p>

      {participants === null ? (
        <div className="sp-loading">
          <span className="spinner" />
        </div>
      ) : participants.length === 0 ? (
        <p className="sp-empty">등록된 참석자가 없어요. 위에서 새 참석자를 추가해보세요.</p>
      ) : (
        <div className="sp-groups">
          {participantGroups.map((g) => {
            const isCollapsed = !!collapsedGroups[g.key]
            // 인라인 수정 중에는 콤보박스 드롭다운이 잘리지 않도록 overflow 클립 해제
            const editingHere = editingId !== null && g.list.some((p) => p.id === editingId)
            return (
              <div key={g.key} className={`sp-group${editingHere ? ' sp-group-editing' : ''}`}>
                <button
                  type="button"
                  className="sp-group-head"
                  onClick={() => toggleGroup(g.key)}
                  aria-expanded={!isCollapsed}
                >
                  <span className="sp-group-chevron" aria-hidden="true">
                    {isCollapsed ? '▸' : '▾'}
                  </span>
                  <span className="sp-group-title">
                    <span aria-hidden="true">🏢</span> {g.name || '소속 미지정'}
                  </span>
                  <span className="sp-group-count">{g.list.length}명</span>
                </button>
                {!isCollapsed && (
                  <div className={`sp-table-wrap${editingHere ? ' sp-table-wrap-editing' : ''}`}>
                    <table className="sp-table">
                      <thead>
                        <tr>
                          <th>이름</th>
                          <th>부서</th>
                          <th>직책</th>
                          <th>이메일</th>
                          <th>전화</th>
                          <th className="sp-th-actions">
                            <span className="sr-only">관리</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>{g.list.map(renderPersonRow)}</tbody>
                    </table>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )

  return (
    <div className="page settings-page">
      <h1 className="page-title">설정</h1>
      <p className="sp-subtitle">태그 · 프로젝트와 참석자 디렉터리, AI 요약 엔진을 관리합니다.</p>

      <div className="sp-layout">
        {/* 좌측 탭 네비 */}
        <nav className="sp-nav" aria-label="설정 섹션">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`sp-nav-link${activeSection === s.id ? ' active' : ''}`}
              aria-current={activeSection === s.id ? 'true' : undefined}
              onClick={() => goToSection(s.id)}
            >
              <span className="sp-nav-icon" aria-hidden="true">
                {s.icon}
              </span>
              {s.label}
            </button>
          ))}
        </nav>

        {/* 우측 — 선택된 섹션만 렌더 */}
        <div className="sp-sections">
          {activeSection === 'tags' && renderTagsSection()}
          {activeSection === 'people' && renderPeopleSection()}
          {activeSection === 'ai' && <AiEngineSettings />}
        </div>
      </div>
    </div>
  )
}
