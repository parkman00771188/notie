import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import './confirm.css'

export interface PromptOptions {
  /** 제목 (굵게) */
  title: string
  /** 부가 설명 (muted) */
  message?: string
  /** 인풋 초기값 */
  initialValue?: string
  placeholder?: string
  /** 확인 버튼 라벨 (기본 "저장") */
  confirmLabel?: string
}

type PromptFn = (options: PromptOptions) => Promise<string | null>

const PromptContext = createContext<PromptFn | null>(null)

/**
 * window.prompt 대체 — Promise<string | null>을 반환하는 입력 팝업 (취소 시 null).
 * ConfirmProvider와 같은 방식으로 Layout에서 children을 감싸 사용한다.
 *
 *   const prompt = usePrompt()
 *   const text = await prompt({ title: '메모 수정', initialValue: b.title })
 */
export function PromptProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<PromptOptions | null>(null)
  const resolveRef = useRef<((value: string | null) => void) | null>(null)

  const prompt = useCallback<PromptFn>((opts) => {
    return new Promise<string | null>((resolve) => {
      resolveRef.current?.(null) // 이미 열려 있던 팝업은 취소로 정리
      resolveRef.current = resolve
      setOptions(opts)
    })
  }, [])

  const resolve = useCallback((result: string | null) => {
    resolveRef.current?.(result)
    resolveRef.current = null
    setOptions(null)
  }, [])

  return (
    <PromptContext.Provider value={prompt}>
      {children}
      {options && <PromptDialog options={options} onResolve={resolve} />}
    </PromptContext.Provider>
  )
}

export function usePrompt(): PromptFn {
  const ctx = useContext(PromptContext)
  if (!ctx) throw new Error('usePrompt는 PromptProvider 안에서만 사용할 수 있어요.')
  return ctx
}

function PromptDialog({
  options,
  onResolve,
}: {
  options: PromptOptions
  onResolve: (value: string | null) => void
}) {
  const { title, message, initialValue, placeholder, confirmLabel } = options
  const [value, setValue] = useState(initialValue ?? '')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    // ESC = 취소. 캡처 단계에서 전파를 막아 하위 모달이 함께 닫히지 않게 한다.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onResolve(null)
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    inputRef.current?.focus()
    inputRef.current?.select()
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.body.style.overflow = prevOverflow
    }
  }, [onResolve])

  const submit = () => onResolve(value)

  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  const handleOverlayMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onResolve(null)
  }

  return createPortal(
    <div className="confirm-overlay" onMouseDown={handleOverlayMouseDown}>
      <div className="confirm-card" role="dialog" aria-modal="true" aria-label={title}>
        <h3 className="confirm-title">{title}</h3>
        {message && <p className="confirm-message">{message}</p>}
        <textarea
          ref={inputRef}
          className="input prompt-input"
          rows={2}
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onInputKeyDown}
        />
        <div className="confirm-actions">
          <button type="button" className="btn btn-ghost" onClick={() => onResolve(null)}>
            취소
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!value.trim()}
            onClick={submit}
          >
            {confirmLabel ?? '저장'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export default PromptProvider
