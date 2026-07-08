import { createContext, useContext, useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { api, getToken, setToken } from './api'
import Layout from './components/Layout'
import AuthPage from './pages/AuthPage'
import CalendarPage from './pages/CalendarPage'
import HomePage from './pages/HomePage'
import MeetingDetailPage from './pages/MeetingDetailPage'
import MeetingsPage from './pages/MeetingsPage'
import ParticipantManagementPage from './pages/ParticipantManagementPage'
import ProjectManagementPage from './pages/ProjectManagementPage'
import RecordPage from './pages/RecordPage'
import SettingsPage from './pages/SettingsPage'
import UserManagementPage from './pages/UserManagementPage'
import type { User } from './types'

interface AuthContextValue {
  user: User | null
  setUser: (user: User | null) => void
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  setUser: () => {},
  logout: async () => {},
})

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  return useContext(AuthContext)
}

export default function App() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!getToken()) {
      setLoading(false)
      return
    }
    api
      .me()
      .then(setUser)
      .catch(() => setToken(null))
      .finally(() => setLoading(false))
  }, [])

  const logout = async () => {
    await api.logout()
    setUser(null)
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
        <span className="spinner" />
      </div>
    )
  }

  return (
    <AuthContext.Provider value={{ user, setUser, logout }}>
      <BrowserRouter>
        <Routes>
          <Route path="/auth" element={user ? <Navigate to="/" replace /> : <AuthPage />} />
          {user ? (
            <Route element={<Layout />}>
              <Route path="/" element={<HomePage />} />
              <Route path="/meetings" element={<MeetingsPage />} />
              <Route path="/meetings/:id" element={<MeetingDetailPage />} />
              <Route path="/record" element={<RecordPage />} />
              <Route path="/calendar" element={<CalendarPage />} />
              <Route path="/users" element={<UserManagementPage />} />
              <Route path="/projects" element={<ProjectManagementPage />} />
              <Route path="/participants" element={<ParticipantManagementPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>
          ) : (
            <Route path="*" element={<Navigate to="/auth" replace />} />
          )}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthContext.Provider>
  )
}
