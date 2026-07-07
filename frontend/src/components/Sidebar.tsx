import { useEffect, useRef, useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../App'
import { Avatar } from './Avatar'
import './components.css'

function HomeIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 10.8 12 3.5l9 7.3" />
      <path d="M5.2 9.5V20a1 1 0 0 0 1 1h4v-6h3.6v6h4a1 1 0 0 0 1-1V9.5" />
    </svg>
  )
}

function ListIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8.5 6.5h12M8.5 12h12M8.5 17.5h12" />
      <circle cx="4" cy="6.5" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="4" cy="12" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="4" cy="17.5" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  )
}

function MicIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="2.5" width="6" height="11.5" rx="3" />
      <path d="M5 11.5a7 7 0 0 0 14 0" />
      <path d="M12 18.5v3" />
    </svg>
  )
}

function CalendarIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3.5" y="4.5" width="17" height="16" rx="2.5" />
      <path d="M8 2.8v4M16 2.8v4M3.5 9h17" />
      <path d="M8 13h.01M12 13h.01M16 13h.01M8 17h.01M12 17h.01" />
    </svg>
  )
}

function GearIcon() {
  return (
    <span aria-hidden="true" style={{ fontSize: 15, lineHeight: 1 }}>
      ⚙️
    </span>
  )
}

const NAV_ITEMS = [
  { to: '/', label: '홈', icon: <HomeIcon />, end: true },
  { to: '/meetings', label: '회의 목록', icon: <ListIcon />, end: false },
  { to: '/record', label: '회의 기록', icon: <MicIcon />, end: false },
  { to: '/calendar', label: '캘린더', icon: <CalendarIcon />, end: false },
  { to: '/settings', label: '설정', icon: <GearIcon />, end: false },
]

const MOBILE_NAV_ITEMS = [
  { to: '/', label: '홈', icon: <HomeIcon />, end: true },
  { to: '/meetings', label: '회의 목록', icon: <ListIcon />, end: false },
  { to: '/record', label: '회의 기록', icon: <MicIcon />, end: false, center: true },
  { to: '/calendar', label: '캘린더', icon: <CalendarIcon />, end: false },
  { to: '/settings', label: '설정', icon: <GearIcon />, end: false },
]

export function Sidebar() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const userAreaRef = useRef<HTMLDivElement>(null)
  const mobileUserAreaRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onMouseDown = (e: globalThis.MouseEvent) => {
      const target = e.target as Node
      const insideDesktop = userAreaRef.current?.contains(target)
      const insideMobile = mobileUserAreaRef.current?.contains(target)
      if (!insideDesktop && !insideMobile) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [menuOpen])

  const handleLogout = async () => {
    setMenuOpen(false)
    try {
      await logout()
    } catch {
      /* 토큰은 이미 정리됨 — 무시 */
    }
  }

  return (
    <>
      <aside className="sidebar">
        <div className="sidebar-logo">
          {/* 로고에 워드마크(notie)가 포함돼 있어 텍스트는 따로 두지 않는다 */}
          <img src="/logo.png" alt="Notie 로고" />
        </div>

        <div className="sidebar-new">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => navigate('/record')}
          >
            + 새 회의 기록
          </button>
        </div>

        <nav className="side-nav">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `side-nav-link${isActive ? ' active' : ''}`}
            >
              <span className="side-nav-icon">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-spacer" />

        <div className="sidebar-user" ref={userAreaRef}>
          {menuOpen && (
            <div className="sidebar-user-menu">
              <button
                type="button"
                className="sidebar-user-menu-item danger"
                onClick={handleLogout}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <path d="M16 17l5-5-5-5" />
                  <path d="M21 12H9" />
                </svg>
                로그아웃
              </button>
            </div>
          )}
          <button
            type="button"
            className="sidebar-user-btn"
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <Avatar name={user?.name ?? '?'} size={34} />
            <span className="sidebar-user-info">
              <span className="sidebar-user-name">{user?.name ?? ''}</span>
              <span className="sidebar-user-team">{user?.team || '팀 미설정'}</span>
            </span>
            <span className={`sidebar-user-caret${menuOpen ? ' open' : ''}`}>▾</span>
          </button>
        </div>
      </aside>

      <header className="mobile-topbar">
        <button
          type="button"
          className="mobile-logo-btn"
          onClick={() => navigate('/')}
          aria-label="홈으로 이동"
        >
          <img src="/logo.png" alt="Notie 로고" />
        </button>

        <div className="mobile-profile-wrap" ref={mobileUserAreaRef}>
          <button
            type="button"
            className="mobile-profile-btn"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="프로필 메뉴 열기"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title="프로필"
          >
            <Avatar name={user?.name ?? '?'} size={34} />
          </button>
          {menuOpen && (
            <div className="mobile-user-menu mobile-menu-panel">
              <div className="mobile-user-summary mobile-user-summary-profile">
                <Avatar name={user?.name ?? '?'} size={44} />
                <span>
                  <small>프로필</small>
                  <strong>{user?.name ?? ''}</strong>
                </span>
              </div>
              <dl className="mobile-profile-list">
                <div>
                  <dt>이메일</dt>
                  <dd>{user?.email ?? '-'}</dd>
                </div>
                <div>
                  <dt>팀</dt>
                  <dd>{user?.team || '팀 미설정'}</dd>
                </div>
              </dl>
              <button
                type="button"
                className="mobile-user-menu-item danger"
                onClick={handleLogout}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <path d="M16 17l5-5-5-5" />
                  <path d="M21 12H9" />
                </svg>
                로그아웃
              </button>
            </div>
          )}
        </div>
      </header>

      <nav className="mobile-bottom-nav" aria-label="주요 화면">
        {MOBILE_NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `mobile-nav-link${isActive ? ' active' : ''}${item.center ? ' primary' : ''}`
            }
            onClick={() => setMenuOpen(false)}
          >
            <span className="mobile-nav-icon">{item.icon}</span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </>
  )
}

export default Sidebar
