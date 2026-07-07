import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import './confirm.css'

export interface ConfirmOptions {
  /** 제목 (굵게) */
  title: string
  /** 부가 설명 (muted, 줄바꿈 \n 지원) */
  message?: string
  /** 확인 버튼 라벨 (기본 "확인") */
  confirmLabel?: string
  /** 취소 버튼 라벨 (기본 "취소") */
  cancelLabel?: string
  /** true면 확인 버튼을 빨강(btn-danger)으로 */
  danger?: boolean
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<ConfirmFn | null>(null)

/**
 * window.confirm 대체 — Promise<boolean>을 반환하는 확인 팝업.
 * Layout에서 children을 <ConfirmProvider>로 감싸 사용한다.
 *
 *   const confirm = useConfirm()
 *   const ok = await confirm({ title: '삭제할까요?', danger: true, confirmLabel: '삭제' })
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null)
  const resolveRef = useRef<((value: boolean) => void) | null>(null)

  const confirm = useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => {
      // 이미 열려 있던 팝업이 있으면 취소로 정리
      resolveRef.current?.(false)
      resolveRef.current = resolve
      setOptions(opts)
    })
  }, [])

  const resolve = useCallback((result: boolean) => {
    resolveRef.current?.(result)
    resolveRef.current = null
    setOptions(null)
  }, [])

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {options && <ConfirmDialog options={options} onResolve={resolve} />}
    </ConfirmContext.Provider>
  )
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext)
  if (!ctx) throw new Error('useConfirm은 ConfirmProvider 안에서만 사용할 수 있어요.')
  return ctx
}

function ConfirmDialog({
  options,
  onResolve,
}: {
  options: ConfirmOptions
  onResolve: (value: boolean) => void
}) {
  const { title, message, confirmLabel, cancelLabel, danger } = options
  const confirmBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    // ESC = 취소. 캡처 단계에서 전파를 막아 하위 모달/콤보박스가 함께 닫히지 않게 한다.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onResolve(false)
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    confirmBtnRef.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.body.style.overflow = prevOverflow
    }
  }, [onResolve])

  const handleOverlayMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onResolve(false)
  }

  return createPortal(
    <div className="confirm-overlay" onMouseDown={handleOverlayMouseDown}>
      <div className="confirm-card" role="alertdialog" aria-modal="true" aria-label={title}>
        <h3 className="confirm-title">{title}</h3>
        {message && <p className="confirm-message">{message}</p>}
        <div className="confirm-actions">
          <button type="button" className="btn btn-ghost" onClick={() => onResolve(false)}>
            {cancelLabel ?? '취소'}
          </button>
          <button
            ref={confirmBtnRef}
            type="button"
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            onClick={() => onResolve(true)}
          >
            {confirmLabel ?? '확인'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export default ConfirmProvider
