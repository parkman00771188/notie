import { Outlet } from 'react-router-dom'
import { ConfirmProvider } from './confirm'
import { PromptProvider } from './prompt'
import Sidebar from './Sidebar'
import './components.css'

export function Layout() {
  return (
    <ConfirmProvider>
      <PromptProvider>
        <div className="layout">
          <Sidebar />
          <main className="layout-main">
            <Outlet />
          </main>
        </div>
      </PromptProvider>
    </ConfirmProvider>
  )
}

export default Layout
