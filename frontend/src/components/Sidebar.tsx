import { useEffect, useRef, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
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
      <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
      <path d="M19.4 15a1.8 1.8 0 0 0 .36 2l.06.06a2.1 2.1 0 1 1-2.97 2.97l-.06-.06a1.8 1.8 0 0 0-2-.36 1.8 1.8 0 0 0-1.1 1.65V21.4a2.1 2.1 0 1 1-4.2 0v-.09a1.8 1.8 0 0 0-1.1-1.65 1.8 1.8 0 0 0-2 .36l-.06.06a2.1 2.1 0 1 1-2.97-2.97l.06-.06a1.8 1.8 0 0 0 .36-2 1.8 1.8 0 0 0-1.65-1.1H2.6a2.1 2.1 0 1 1 0-4.2h.09a1.8 1.8 0 0 0 1.65-1.1 1.8 1.8 0 0 0-.36-2l-.06-.06a2.1 2.1 0 1 1 2.97-2.97l.06.06a1.8 1.8 0 0 0 2 .36 1.8 1.8 0 0 0 1.1-1.65V2.6a2.1 2.1 0 1 1 4.2 0v.09a1.8 1.8 0 0 0 1.1 1.65 1.8 1.8 0 0 0 2-.36l.06-.06a2.1 2.1 0 1 1 2.97 2.97l-.06.06a1.8 1.8 0 0 0-.36 2 1.8 1.8 0 0 0 1.65 1.1h.09a2.1 2.1 0 1 1 0 4.2h-.09A1.8 1.8 0 0 0 19.4 15Z" />
    </svg>
  )
}

function UsersIcon() {
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
      <path d="M16 20v-1.6c0-1.8-1.5-3.3-3.3-3.3H7.3C5.5 15.1 4 16.6 4 18.4V20" />
      <circle cx="10" cy="7.5" r="3.3" />
      <path d="M20 20v-1.3c0-1.5-.9-2.8-2.2-3.3" />
      <path d="M16.3 4.4a3.3 3.3 0 0 1 0 6.2" />
    </svg>
  )
}

function ProjectIcon() {
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
      <path d="M3.8 6.5a2 2 0 0 1 2-2h4.4l2 2h6a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5.8a2 2 0 0 1-2-2v-11Z" />
      <path d="M3.8 9h16.4" />
    </svg>
  )
}

function MoreIcon() {
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
      <circle cx="5" cy="12" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="19" cy="12" r="1.4" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

interface NavItem {
  to: string
  label: string
  icon: JSX.Element
  end: boolean
  center?: boolean
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', label: '홈', icon: <HomeIcon />, end: true },
  { to: '/meetings', label: '회의 목록', icon: <ListIcon />, end: false },
  { to: '/record', label: '회의 기록', icon: <MicIcon />, end: false },
  { to: '/calendar', label: '캘린더', icon: <CalendarIcon />, end: false },
  { to: '/settings', label: '설정', icon: <GearIcon />, end: false },
]

const MOBILE_NAV_ITEMS: NavItem[] = [
  { to: '/', label: '홈', icon: <HomeIcon />, end: true },
  { to: '/meetings', label: '회의 목록', icon: <ListIcon />, end: false },
  { to: '/record', label: '회의 기록', icon: <MicIcon />, end: false, center: true },
  { to: '/calendar', label: '캘린더', icon: <CalendarIcon />, end: false },
  { to: '/settings', label: '설정', icon: <GearIcon />, end: false },
]

export function Sidebar() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [menuOpen, setMenuOpen] = useState(false)
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false)
  const userAreaRef = useRef<HTMLDivElement>(null)
  const mobileUserAreaRef = useRef<HTMLDivElement>(null)
  const adminNavItem: NavItem = { to: '/users', label: '사용자 관리', icon: <UsersIcon />, end: false }
  const projectNavItem: NavItem = { to: '/projects', label: '프로젝트 관리', icon: <ProjectIcon />, end: false }
  const participantNavItem: NavItem = { to: '/participants', label: '참석자 관리', icon: <UsersIcon />, end: false }
  const isAdmin = user?.role === 'admin'
  const navItems: NavItem[] = isAdmin
    ? [...NAV_ITEMS.slice(0, 4), adminNavItem, projectNavItem, participantNavItem, NAV_ITEMS[4]]
    : [...NAV_ITEMS.slice(0, 4), projectNavItem, participantNavItem, NAV_ITEMS[4]]
  const mobileNavItems: NavItem[] = MOBILE_NAV_ITEMS.slice(0, 4)
  const mobileMoreItems: NavItem[] = navItems
  const hasMobileMore = mobileMoreItems.length > mobileNavItems.length
  const mobileMoreActive =
    mobileMoreOpen ||
    ['/users', '/projects', '/participants', '/settings'].some((path) => location.pathname.startsWith(path))

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

  useEffect(() => {
    if (!mobileMoreOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMobileMoreOpen(false)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [mobileMoreOpen])

  const handleLogout = async () => {
    setMenuOpen(false)
    setMobileMoreOpen(false)
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
          {navItems.map((item) => (
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
        {mobileNavItems.map((item) => (
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
        {hasMobileMore && (
          <button
            type="button"
            className={`mobile-nav-link mobile-nav-more${mobileMoreActive ? ' active' : ''}`}
            onClick={() => {
              setMenuOpen(false)
              setMobileMoreOpen(true)
            }}
            aria-haspopup="dialog"
            aria-expanded={mobileMoreOpen}
          >
            <span className="mobile-nav-icon">
              <MoreIcon />
            </span>
            <span>더보기</span>
          </button>
        )}
      </nav>

      {hasMobileMore && mobileMoreOpen && (
        <div
          className="mobile-more-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              setMobileMoreOpen(false)
            }
          }}
        >
          <aside className="mobile-more-drawer" role="dialog" aria-label="더보기 메뉴">
            <div className="mobile-more-head">
              <button
                type="button"
                className="mobile-more-logo"
                onClick={() => {
                  setMobileMoreOpen(false)
                  navigate('/')
                }}
                aria-label="홈으로 이동"
              >
                <img src="/logo.png" alt="Notie 로고" />
              </button>
              <button
                type="button"
                className="btn-icon mobile-more-close"
                onClick={() => setMobileMoreOpen(false)}
                aria-label="더보기 메뉴 닫기"
              >
                <CloseIcon />
              </button>
            </div>

            <nav className="mobile-more-list" aria-label="전체 메뉴">
              {mobileMoreItems.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) => `mobile-more-item${isActive ? ' active' : ''}`}
                  onClick={() => setMobileMoreOpen(false)}
                >
                  <span className="mobile-more-item-icon">{item.icon}</span>
                  <span>{item.label}</span>
                </NavLink>
              ))}
            </nav>
          </aside>
        </div>
      )}
    </>
  )
}

export default Sidebar
