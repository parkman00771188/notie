import { useEffect, useState } from 'react'
import { api } from '../api'
import { useAuth } from '../App'
import AiEngineSettings from '../components/AiEngineSettings'
import UsageSummarySettings from '../components/UsageSummarySettings'
import './SettingsPage.css'

const SECTIONS = [
  { id: 'font', label: '글꼴 설정', icon: 'Aa' },
  { id: 'passwords', label: '비밀번호 변경', icon: 'PW' },
  { id: 'ai', label: 'AI 요약 엔진', icon: 'AI', adminOnly: true },
  { id: 'usage', label: '사용량 요약', icon: '📊', adminOnly: true },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

const isSectionId = (id: string): id is SectionId => SECTIONS.some((s) => s.id === id)
const isAdminOnlySection = (id: SectionId) => SECTIONS.some((s) => s.id === id && 'adminOnly' in s && s.adminOnly)

const FONT_SIZE_STORAGE_KEY = 'notie_font_size'

const FONT_SIZE_OPTIONS = [
  { id: 'very-small', label: '아주 작게', scale: '0.88', sample: '가' },
  { id: 'small', label: '작게', scale: '0.94', sample: '가' },
  { id: 'normal', label: '보통', scale: '1', sample: '가' },
  { id: 'large', label: '크게', scale: '1.08', sample: '가' },
  { id: 'very-large', label: '아주 크게', scale: '1.16', sample: '가' },
] as const

type FontSizeId = (typeof FONT_SIZE_OPTIONS)[number]['id']

const isFontSizeId = (value: string | null): value is FontSizeId =>
  FONT_SIZE_OPTIONS.some((option) => option.id === value)

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

/* ---------- 설정 페이지 ---------- */

export default function SettingsPage() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const visibleSections = isAdmin ? SECTIONS : SECTIONS.filter((s) => !('adminOnly' in s && s.adminOnly))
  const settingsSubtitle = isAdmin
    ? '글꼴 설정, 비밀번호, 모든 사용자에게 적용되는 AI 요약 엔진과 사용량 요약을 관리합니다.'
    : '글꼴 설정과 내 비밀번호를 관리합니다.'

  // 탭 — URL 해시(#font/#ai)와 동기화
  const [activeSection, setActiveSection] = useState<SectionId>(() => {
    const id = window.location.hash.slice(1)
    return isSectionId(id) ? id : 'font'
  })
  const [fontSize, setFontSize] = useState<FontSizeId>(() => {
    try {
      const saved = window.localStorage.getItem(FONT_SIZE_STORAGE_KEY)
      return isFontSizeId(saved) ? saved : 'normal'
    } catch {
      return 'normal'
    }
  })
  const [passwordError, setPasswordError] = useState('')
  const [passwordSuccess, setPasswordSuccess] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showNewPassword, setShowNewPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [passwordSaving, setPasswordSaving] = useState(false)
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false)

  // 주소창에서 해시를 직접 바꾼 경우 탭 동기화
  useEffect(() => {
    const onHashChange = () => {
      const id = window.location.hash.slice(1)
      if (isSectionId(id)) setActiveSection(id)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    if (!isAdmin && isAdminOnlySection(activeSection)) {
      setActiveSection('font')
      window.history.replaceState(null, '', '#font')
    }
  }, [activeSection, isAdmin])

  useEffect(() => {
    const selected = FONT_SIZE_OPTIONS.find((option) => option.id === fontSize) ?? FONT_SIZE_OPTIONS[2]
    document.documentElement.dataset.notieFontSize = selected.id
    document.documentElement.style.setProperty('--notie-font-scale', selected.scale)

    try {
      window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, selected.id)
    } catch {
      // 브라우저 저장소를 사용할 수 없어도 현재 화면에는 적용됩니다.
    }
  }, [fontSize])

  const goToSection = (id: SectionId) => {
    setActiveSection(id)
    setSettingsMenuOpen(false)
    window.history.replaceState(null, '', `#${id}`)
  }

  const saveOwnPassword = async () => {
    const next = newPassword.trim()
    const confirm = confirmPassword.trim()
    setPasswordError('')
    setPasswordSuccess('')

    if (!next || !confirm) {
      setPasswordError('새 비밀번호를 입력해주세요.')
      return
    }
    if (next !== confirm) {
      setPasswordError('새 비밀번호가 서로 일치하지 않습니다.')
      return
    }

    setPasswordSaving(true)
    try {
      await api.changePassword({ new_password: next })
      setNewPassword('')
      setConfirmPassword('')
      setShowNewPassword(false)
      setShowConfirmPassword(false)
      setPasswordSuccess('비밀번호가 변경되었습니다. 다음 로그인부터 새 비밀번호를 사용해주세요.')
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : '비밀번호 변경에 실패했어요')
    } finally {
      setPasswordSaving(false)
    }
  }

  /* ----- 렌더 ----- */

  const renderFontSection = () => {
    const selected = FONT_SIZE_OPTIONS.find((option) => option.id === fontSize) ?? FONT_SIZE_OPTIONS[2]

    return (
      <section className="card settings-card font-settings-card">
        <div className="settings-card-head">
          <h2 className="settings-card-title">
            <span className="font-title-icon" aria-hidden="true">
              Aa
            </span>
            글꼴 설정
          </h2>
          <p className="settings-card-desc">
            화면에 표시되는 글자 크기를 조정합니다. 보통은 현재 기본 크기입니다.
          </p>
        </div>

        <div className="font-size-options" role="radiogroup" aria-label="글자 크기 선택">
          {FONT_SIZE_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={fontSize === option.id}
              className={`font-size-option${fontSize === option.id ? ' active' : ''}`}
              onClick={() => setFontSize(option.id)}
            >
              <span className="font-option-sample" style={{ fontSize: `calc(18px * ${option.scale})` }}>
                {option.sample}
              </span>
              <span className="font-option-label">{option.label}</span>
            </button>
          ))}
        </div>

        <div className="font-preview-box">
          <div className="font-preview-meta">현재 선택: {selected.label}</div>
          <div className="font-preview-title">회의 내용을 편안한 크기로 읽을 수 있어요.</div>
          <p className="font-preview-text">
            글꼴 크기는 이 브라우저에 저장되며, 새로고침 후에도 같은 설정으로 유지됩니다.
          </p>
        </div>
      </section>
    )
  }

  const renderPasswordSection = () => (
    <section className="card settings-card password-settings-card">
      <div className="settings-card-head">
        <h2 className="settings-card-title">
          <span className="password-title-icon" aria-hidden="true">
            PW
          </span>
          비밀번호 변경
        </h2>
        <p className="settings-card-desc">
          현재 로그인한 계정의 비밀번호를 변경합니다.
        </p>
      </div>

      {passwordError && <div className="sp-error">{passwordError}</div>}
      {passwordSuccess && <div className="sp-success">{passwordSuccess}</div>}

      <form
        className="password-self-form"
        onSubmit={(event) => {
          event.preventDefault()
          void saveOwnPassword()
        }}
      >
        <div className="password-account-box">
          <span className="password-account-label">현재 계정</span>
          <strong>{user?.name ?? '-'}</strong>
          <span>{user?.username ?? '-'}</span>
        </div>

        <div className="password-field-grid">
          <label className="password-field">
            <span>새 비밀번호</span>
            <div className="password-input-wrap">
              <input
                className="input password-input"
                type={showNewPassword ? 'text' : 'password'}
                value={newPassword}
                onChange={(event) => {
                  setNewPassword(event.target.value)
                  setPasswordError('')
                  setPasswordSuccess('')
                }}
                placeholder="새 비밀번호를 입력하세요"
                autoComplete="new-password"
              />
              <button
                type="button"
                className="password-visibility-button"
                onClick={() => setShowNewPassword((value) => !value)}
                aria-label={showNewPassword ? '새 비밀번호 숨기기' : '새 비밀번호 표시'}
                title={showNewPassword ? '새 비밀번호 숨기기' : '새 비밀번호 표시'}
              >
                <EyeIcon hidden={showNewPassword} />
              </button>
            </div>
          </label>
          <label className="password-field">
            <span>새 비밀번호 확인</span>
            <div className="password-input-wrap">
              <input
                className="input password-input"
                type={showConfirmPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(event) => {
                  setConfirmPassword(event.target.value)
                  setPasswordError('')
                  setPasswordSuccess('')
                }}
                placeholder="새 비밀번호를 다시 입력하세요"
                autoComplete="new-password"
              />
              <button
                type="button"
                className="password-visibility-button"
                onClick={() => setShowConfirmPassword((value) => !value)}
                aria-label={showConfirmPassword ? '새 비밀번호 확인 숨기기' : '새 비밀번호 확인 표시'}
                title={showConfirmPassword ? '새 비밀번호 확인 숨기기' : '새 비밀번호 확인 표시'}
              >
                <EyeIcon hidden={showConfirmPassword} />
              </button>
            </div>
          </label>
        </div>

        <div className="password-form-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!newPassword.trim() || !confirmPassword.trim() || passwordSaving}
          >
            {passwordSaving ? '변경 중...' : '비밀번호 변경'}
          </button>
        </div>
      </form>
    </section>
  )

  const activeSectionMeta = visibleSections.find((section) => section.id === activeSection) ?? SECTIONS[0]

  return (
    <div className="page settings-page">
      <h1 className="page-title">설정</h1>
      <p className="sp-subtitle">{settingsSubtitle}</p>

      <div className="sp-layout">
        <div
          className="sp-mobile-section-menu"
          onBlur={(event) => {
            const nextFocus = event.relatedTarget as Node | null
            if (!nextFocus || !event.currentTarget.contains(nextFocus)) {
              setSettingsMenuOpen(false)
            }
          }}
        >
          <span className="sp-mobile-section-caption">설정 메뉴</span>
          <button
            type="button"
            className={`sp-mobile-section-trigger${settingsMenuOpen ? ' open' : ''}`}
            aria-haspopup="listbox"
            aria-expanded={settingsMenuOpen}
            onClick={() => setSettingsMenuOpen((open) => !open)}
          >
            <span className="sp-nav-icon" aria-hidden="true">
              {activeSectionMeta.icon}
            </span>
            <span className="sp-mobile-section-current">
              {activeSectionMeta.label}
              {'adminOnly' in activeSectionMeta && activeSectionMeta.adminOnly && (
                <span className="sp-nav-admin-badge">관리자</span>
              )}
            </span>
            <span className="sp-mobile-section-chevron" aria-hidden="true">
              ▾
            </span>
          </button>
          {settingsMenuOpen && (
            <div className="sp-mobile-section-popover" role="listbox" aria-label="설정 메뉴 선택">
              {visibleSections.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  role="option"
                  aria-selected={activeSection === section.id}
                  className={`sp-mobile-section-option${activeSection === section.id ? ' selected' : ''}`}
                  onClick={() => goToSection(section.id)}
                >
                  <span className="sp-nav-icon" aria-hidden="true">
                    {section.icon}
                  </span>
                  <span>
                    {section.label}
                    {'adminOnly' in section && section.adminOnly && (
                      <span className="sp-nav-admin-badge">관리자</span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        {/* 좌측 탭 네비 */}
        <nav className="sp-nav" role="tablist" aria-label="설정 섹션">
          {visibleSections.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              className={`sp-nav-link${activeSection === s.id ? ' active' : ''}`}
              aria-selected={activeSection === s.id}
              onClick={() => goToSection(s.id)}
            >
              <span className="sp-nav-icon" aria-hidden="true">
                {s.icon}
              </span>
              <span className="sp-nav-label">
                {s.label}
                {'adminOnly' in s && s.adminOnly && <span className="sp-nav-admin-badge">관리자</span>}
              </span>
            </button>
          ))}
        </nav>

        {/* 우측 — 선택된 섹션만 렌더 */}
        <div className="sp-sections">
          {activeSection === 'font' && renderFontSection()}
          {activeSection === 'passwords' && renderPasswordSection()}
          {activeSection === 'ai' && isAdmin && <AiEngineSettings />}
          {activeSection === 'usage' && isAdmin && <UsageSummarySettings />}
        </div>
      </div>
    </div>
  )
}
