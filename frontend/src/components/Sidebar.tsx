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

const NAV_ITEMS = [
  { to: '/', label: '홈', icon: <HomeIcon />, end: true },
  { to: '/meetings', label: '회의 목록', icon: <ListIcon />, end: false },
  { to: '/record', label: '회의 기록', icon: <MicIcon />, end: false },
]

export function Sidebar() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const userAreaRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onMouseDown = (e: globalThis.MouseEvent) => {
      if (userAreaRef.current && !userAreaRef.current.contains(e.target as Node)) {
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
    <aside className="sidebar">
      <div className="sidebar-logo">
        <img src="/logo.png" alt="Gimnote 로고" />
        <span className="sidebar-wordmark">Gimnote</span>
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
  )
}

export default Sidebar
