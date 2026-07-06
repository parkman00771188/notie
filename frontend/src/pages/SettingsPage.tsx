import { useEffect, useState } from 'react'
import type { FormEvent, KeyboardEvent, MouseEvent } from 'react'
import { api } from '../api'
import AiEngineSettings from '../components/AiEngineSettings'
import { Avatar } from '../components/Avatar'
import type { OrgOption, Participant, Tag } from '../types'
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
  { id: 'sp-ai', label: 'AI 요약 엔진', icon: '✨' },
  { id: 'sp-tags', label: '태그 · 프로젝트', icon: '🏷️' },
  { id: 'sp-org', label: '소속 · 직책', icon: '🏢' },
  { id: 'sp-people', label: '참석자', icon: '👥' },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

const errMsg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback)

const sortTags = (list: Tag[]) => [...list].sort((a, b) => a.name.localeCompare(b.name, 'ko'))

const sortOrgOptions = (list: OrgOption[]) =>
  [...list].sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name, 'ko') : a.kind.localeCompare(b.kind),
  )

/* ---------- 소속/직책 컬럼 ---------- */

interface OrgColumnProps {
  kind: OrgOption['kind']
  title: string
  placeholder: string
  options: OrgOption[]
  loading: boolean
  onCreate: (kind: OrgOption['kind'], name: string) => Promise<boolean>
  onDelete: (option: OrgOption) => void
}

function OrgColumn({ kind, title, placeholder, options, loading, onCreate, onDelete }: OrgColumnProps) {
  const [value, setValue] = useState('')
  const [adding, setAdding] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const name = value.trim()
    if (!name || adding) return
    setAdding(true)
    try {
      const ok = await onCreate(kind, name)
      if (ok) setValue('')
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="sp-org-col">
      <h3 className="sp-org-title">{title}</h3>
      <form className="sp-org-add" onSubmit={handleSubmit}>
        <input
          className="input"
          placeholder={placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="submit" className="btn btn-soft" disabled={!value.trim() || adding}>
          {adding ? '추가 중...' : '추가'}
        </button>
      </form>
      {loading ? (
        <div className="sp-loading">
          <span className="spinner" />
        </div>
      ) : options.length === 0 ? (
        <p className="sp-empty">아직 등록된 항목이 없어요.</p>
      ) : (
        <ul className="sp-org-list">
          {options.map((o) => (
            <li key={o.id} className="sp-org-item">
              <span className="sp-org-name">{o.name}</span>
              <button
                type="button"
                className="sp-org-x"
                aria-label={`${o.name} 삭제`}
                title="삭제"
                onClick={() => onDelete(o)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* ---------- 설정 페이지 ---------- */

export default function SettingsPage() {
  const [activeSection, setActiveSection] = useState<SectionId>('sp-ai')

  // 태그 · 프로젝트
  const [tags, setTags] = useState<Tag[] | null>(null)
  const [tagError, setTagError] = useState('')
  const [tagName, setTagName] = useState('')
  const [tagColor, setTagColor] = useState<string | null>(null)
  const [tagAdding, setTagAdding] = useState(false)
  const [editingTagId, setEditingTagId] = useState<number | null>(null)
  const [editTagName, setEditTagName] = useState('')
  const [tagSaving, setTagSaving] = useState(false)

  // 소속 · 직책
  const [orgOptions, setOrgOptions] = useState<OrgOption[] | null>(null)
  const [orgError, setOrgError] = useState('')

  // 참석자 디렉터리
  const [participants, setParticipants] = useState<Participant[] | null>(null)
  const [peopleError, setPeopleError] = useState('')
  const [pName, setPName] = useState('')
  const [pDept, setPDept] = useState('')
  const [pRole, setPRole] = useState('')
  const [pAdding, setPAdding] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [editDept, setEditDept] = useState('')
  const [editRole, setEditRole] = useState('')
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
      .catch((e: unknown) => {
        if (alive) {
          setOrgOptions([])
          setOrgError(errMsg(e, '소속/직책 목록을 불러오지 못했어요'))
        }
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

  // 스크롤 스파이 — 현재 보이는 섹션을 좌측 네비에 표시
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((en) => en.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible.length > 0) setActiveSection(visible[0].target.id as SectionId)
      },
      { rootMargin: '-15% 0px -65% 0px' },
    )
    for (const s of SECTIONS) {
      const el = document.getElementById(s.id)
      if (el) observer.observe(el)
    }
    return () => observer.disconnect()
  }, [])

  const goToSection = (id: SectionId) => {
    setActiveSection(id)
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
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
  }

  const handleTagEditSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (editingTagId === null || tagSaving) return
    const name = editTagName.trim()
    if (!name) return
    const current = (tags ?? []).find((t) => t.id === editingTagId)
    if (current && current.name === name) {
      setEditingTagId(null)
      return
    }
    setTagSaving(true)
    setTagError('')
    try {
      const updated = await api.updateTag(editingTagId, { name })
      setTags((prev) => sortTags((prev ?? []).map((t) => (t.id === updated.id ? updated : t))))
      setEditingTagId(null)
    } catch (err: unknown) {
      setTagError(errMsg(err, '태그 이름을 변경하지 못했어요'))
    } finally {
      setTagSaving(false)
    }
  }

  const handleDeleteTag = async (t: Tag, e: MouseEvent) => {
    e.stopPropagation()
    if (!window.confirm(`'${t.name}' 태그를 삭제할까요?\n기존 회의에 표시된 태그는 그대로 남아요.`)) {
      return
    }
    setTagError('')
    try {
      await api.deleteTag(t.id)
      setTags((prev) => (prev ?? []).filter((x) => x.id !== t.id))
      if (editingTagId === t.id) setEditingTagId(null)
    } catch (err: unknown) {
      setTagError(errMsg(err, '태그를 삭제하지 못했어요'))
    }
  }

  /* ----- 소속/직책 CRUD ----- */

  const handleCreateOrgOption = async (kind: OrgOption['kind'], name: string) => {
    setOrgError('')
    try {
      const created = await api.createOrgOption({ kind, name })
      setOrgOptions((prev) => sortOrgOptions([...(prev ?? []), created]))
      return true
    } catch (err: unknown) {
      setOrgError(errMsg(err, '항목을 추가하지 못했어요'))
      return false
    }
  }

  const handleDeleteOrgOption = async (option: OrgOption) => {
    setOrgError('')
    try {
      await api.deleteOrgOption(option.id)
      setOrgOptions((prev) => (prev ?? []).filter((o) => o.id !== option.id))
    } catch (err: unknown) {
      setOrgError(errMsg(err, '항목을 삭제하지 못했어요'))
    }
  }

  const departmentOptions = (orgOptions ?? []).filter((o) => o.kind === 'department')
  const roleOptions = (orgOptions ?? []).filter((o) => o.kind === 'role')

  /* ----- 참석자 CRUD ----- */

  const handleAddParticipant = async (e: FormEvent) => {
    e.preventDefault()
    const name = pName.trim()
    if (!name || pAdding) return
    setPAdding(true)
    setPeopleError('')
    try {
      const data: { name: string; department?: string; role?: string } = { name }
      const dept = pDept.trim()
      const role = pRole.trim()
      if (dept) data.department = dept
      if (role) data.role = role
      const created = await api.createParticipant(data)
      setParticipants((prev) => [...(prev ?? []), created])
      setPName('')
      setPDept('')
      setPRole('')
    } catch (err: unknown) {
      setPeopleError(errMsg(err, '참석자를 추가하지 못했어요'))
    } finally {
      setPAdding(false)
    }
  }

  const startEdit = (p: Participant) => {
    setEditingId(p.id)
    setEditName(p.name)
    setEditDept(p.department ?? '')
    setEditRole(p.role ?? '')
  }

  const cancelEdit = () => {
    setEditingId(null)
  }

  const saveEdit = async () => {
    if (editingId === null || savingEdit) return
    const name = editName.trim()
    if (!name) return
    setSavingEdit(true)
    setPeopleError('')
    try {
      // 빈 문자열은 백엔드에서 NULL 처리됨 (소속/직책 비우기)
      const updated = await api.updateParticipant(editingId, {
        name,
        department: editDept.trim(),
        role: editRole.trim(),
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
    if (!window.confirm(`'${p.name}' 참석자를 디렉터리에서 삭제할까요?`)) return
    setPeopleError('')
    try {
      await api.deleteParticipant(p.id)
      setParticipants((prev) => (prev ?? []).filter((x) => x.id !== p.id))
      if (editingId === p.id) setEditingId(null)
    } catch (err: unknown) {
      setPeopleError(errMsg(err, '참석자를 삭제하지 못했어요'))
    }
  }

  return (
    <div className="page settings-page">
      <h1 className="page-title">설정</h1>
      <p className="sp-subtitle">AI 요약 엔진과 태그, 소속·직책, 참석자 디렉터리를 관리합니다.</p>

      <div className="sp-layout">
        {/* 좌측 앵커 네비 */}
        <nav className="sp-nav" aria-label="설정 섹션">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`sp-nav-link${activeSection === s.id ? ' active' : ''}`}
              onClick={() => goToSection(s.id)}
            >
              <span className="sp-nav-icon" aria-hidden="true">
                {s.icon}
              </span>
              {s.label}
            </button>
          ))}
        </nav>

        {/* 우측 섹션 카드 스택 */}
        <div className="sp-sections">
          {/* 1. AI 요약 엔진 */}
          <div id="sp-ai" className="sp-block">
            <AiEngineSettings />
          </div>

          {/* 2. 태그 · 프로젝트 */}
          <section id="sp-tags" className="card settings-card sp-block">
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
              <div className="sp-palette" role="group" aria-label="태그 색 선택">
                {TAG_PALETTE.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`sp-swatch${tagColor === c ? ' selected' : ''}`}
                    style={{ background: c }}
                    aria-label={`색상 ${c}`}
                    aria-pressed={tagColor === c}
                    title={tagColor === c ? '선택 해제 (자동 배정)' : c}
                    onClick={() => setTagColor((prev) => (prev === c ? null : c))}
                  />
                ))}
              </div>
              <button type="submit" className="btn btn-primary" disabled={!tagName.trim() || tagAdding}>
                {tagAdding ? '추가 중...' : '추가'}
              </button>
            </form>
            <p className="sp-hint">색을 고르지 않으면 팔레트에서 자동으로 배정돼요.</p>

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
                    <span className="sp-dot" style={{ background: t.color }} />
                    {editingTagId === t.id ? (
                      <form className="sp-inline-form" onSubmit={handleTagEditSubmit}>
                        <input
                          autoFocus
                          className="input sp-inline-input"
                          value={editTagName}
                          onChange={(e) => setEditTagName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') setEditingTagId(null)
                          }}
                        />
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
                            title="이름 수정"
                            aria-label={`${t.name} 이름 수정`}
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

          {/* 3. 소속 · 직책 */}
          <section id="sp-org" className="card settings-card sp-block">
            <div className="settings-card-head">
              <h2 className="settings-card-title">
                <span aria-hidden="true">🏢</span> 소속 · 직책
              </h2>
              <p className="settings-card-desc">
                참석자에게 지정할 소속(부서)과 직책 목록을 관리합니다. 참석자 입력 시 제안 목록으로
                사용돼요.
              </p>
            </div>

            {orgError && <div className="sp-error">{orgError}</div>}

            <div className="sp-org-grid">
              <OrgColumn
                kind="department"
                title="소속 · 부서"
                placeholder="예: AI사업부"
                options={departmentOptions}
                loading={orgOptions === null}
                onCreate={handleCreateOrgOption}
                onDelete={handleDeleteOrgOption}
              />
              <OrgColumn
                kind="role"
                title="직책"
                placeholder="예: 팀장"
                options={roleOptions}
                loading={orgOptions === null}
                onCreate={handleCreateOrgOption}
                onDelete={handleDeleteOrgOption}
              />
            </div>
          </section>

          {/* 4. 참석자 디렉터리 */}
          <section id="sp-people" className="card settings-card sp-block">
            <div className="settings-card-head">
              <h2 className="settings-card-title">
                <span aria-hidden="true">👥</span> 참석자
              </h2>
              <p className="settings-card-desc">
                회의에 참석하는 사람들의 디렉터리입니다. 행을 클릭하면 바로 수정할 수 있어요.
              </p>
            </div>

            {peopleError && <div className="sp-error">{peopleError}</div>}

            <datalist id="sp-dept-options">
              {departmentOptions.map((o) => (
                <option key={o.id} value={o.name} />
              ))}
            </datalist>
            <datalist id="sp-role-options">
              {roleOptions.map((o) => (
                <option key={o.id} value={o.name} />
              ))}
            </datalist>

            <form className="sp-people-add" onSubmit={handleAddParticipant}>
              <input
                className="input"
                placeholder="이름"
                value={pName}
                onChange={(e) => setPName(e.target.value)}
              />
              <input
                className="input"
                placeholder="소속 (선택)"
                list="sp-dept-options"
                value={pDept}
                onChange={(e) => setPDept(e.target.value)}
              />
              <input
                className="input"
                placeholder="직책 (선택)"
                list="sp-role-options"
                value={pRole}
                onChange={(e) => setPRole(e.target.value)}
              />
              <button type="submit" className="btn btn-primary" disabled={!pName.trim() || pAdding}>
                {pAdding ? '추가 중...' : '+ 추가'}
              </button>
            </form>

            {participants === null ? (
              <div className="sp-loading">
                <span className="spinner" />
              </div>
            ) : participants.length === 0 ? (
              <p className="sp-empty">등록된 참석자가 없어요. 위에서 새 참석자를 추가해보세요.</p>
            ) : (
              <div className="sp-table-wrap">
                <table className="sp-table">
                  <thead>
                    <tr>
                      <th>이름</th>
                      <th>소속</th>
                      <th>직책</th>
                      <th className="sp-th-actions">
                        <span className="sr-only">관리</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {participants.map((p) =>
                      editingId === p.id ? (
                        <tr key={p.id} className="sp-row-editing">
                          <td>
                            <div className="sp-cell-name">
                              <Avatar name={editName || p.name} color={p.color} size={28} />
                              <input
                                autoFocus
                                className="input sp-inline-input"
                                value={editName}
                                onChange={(e) => setEditName(e.target.value)}
                                onKeyDown={handleEditKeyDown}
                                placeholder="이름"
                              />
                            </div>
                          </td>
                          <td>
                            <input
                              className="input sp-inline-input"
                              list="sp-dept-options"
                              value={editDept}
                              onChange={(e) => setEditDept(e.target.value)}
                              onKeyDown={handleEditKeyDown}
                              placeholder="소속"
                            />
                          </td>
                          <td>
                            <input
                              className="input sp-inline-input"
                              list="sp-role-options"
                              value={editRole}
                              onChange={(e) => setEditRole(e.target.value)}
                              onKeyDown={handleEditKeyDown}
                              placeholder="직책"
                            />
                          </td>
                          <td className="sp-td-actions">
                            <button
                              type="button"
                              className="btn btn-primary"
                              onClick={() => void saveEdit()}
                              disabled={!editName.trim() || savingEdit}
                            >
                              {savingEdit ? '저장 중...' : '저장'}
                            </button>
                            <button type="button" className="btn btn-ghost" onClick={cancelEdit}>
                              취소
                            </button>
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
                      ),
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
