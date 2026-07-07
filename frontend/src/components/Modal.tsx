import { useEffect } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import './components.css'

export interface ModalProps {
  open: boolean
  title?: ReactNode
  width?: number
  onClose: () => void
  children: ReactNode
}

export function Modal({ open, title, width, onClose, children }: ModalProps) {
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = prevOverflow
    }
  }, [open, onClose])

  if (!open) return null
  const dialogLabel = typeof title === 'string' ? title : undefined

  const handleOverlayMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose()
  }

  return createPortal(
    <div className="modal-overlay" onMouseDown={handleOverlayMouseDown}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-label={dialogLabel}
        style={width ? { width } : undefined}
      >
        <div className="modal-header">
          <h3 className="modal-title">{title ?? ''}</h3>
          <button
            type="button"
            className="btn-icon modal-close"
            onClick={onClose}
            aria-label="닫기"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  )
}

export default Modal
