import { Outlet } from 'react-router-dom'
import { ConfirmProvider } from './confirm'
import Sidebar from './Sidebar'
import './components.css'

export function Layout() {
  return (
    <ConfirmProvider>
      <div className="layout">
        <Sidebar />
        <main className="layout-main">
          <Outlet />
        </main>
      </div>
    </ConfirmProvider>
  )
}

export default Layout
