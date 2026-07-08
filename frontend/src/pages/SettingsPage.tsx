import { useEffect, useState } from 'react'
import { useAuth } from '../App'
import AiEngineSettings from '../components/AiEngineSettings'
import './SettingsPage.css'

const SECTIONS = [
  { id: 'font', label: '글꼴 설정', icon: 'Aa' },
  { id: 'ai', label: 'AI 요약 엔진', icon: '✨' },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

const isSectionId = (id: string): id is SectionId => SECTIONS.some((s) => s.id === id)

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

/* ---------- 설정 페이지 ---------- */

export default function SettingsPage() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const visibleSections = isAdmin ? SECTIONS : SECTIONS.filter((s) => s.id !== 'ai')
  const settingsSubtitle = isAdmin
    ? '글꼴 설정과 모든 사용자에게 적용되는 AI 요약 엔진을 관리합니다.'
    : '글꼴 설정을 관리합니다.'

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
    if (!isAdmin && activeSection === 'ai') {
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
    window.history.replaceState(null, '', `#${id}`)
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

  return (
    <div className="page settings-page">
      <h1 className="page-title">설정</h1>
      <p className="sp-subtitle">{settingsSubtitle}</p>

      <div className="sp-layout">
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
                {s.id === 'ai' && <span className="sp-nav-admin-badge">관리자</span>}
              </span>
            </button>
          ))}
        </nav>

        {/* 우측 — 선택된 섹션만 렌더 */}
        <div className="sp-sections">
          {activeSection === 'font' && renderFontSection()}
          {activeSection === 'ai' && isAdmin && <AiEngineSettings />}
        </div>
      </div>
    </div>
  )
}
