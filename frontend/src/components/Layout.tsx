import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'
import './components.css'

export function Layout() {
  return (
    <div className="layout">
      <Sidebar />
      <main className="layout-main">
        <Outlet />
      </main>
    </div>
  )
}

export default Layout
