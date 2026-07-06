import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { api } from '../api'
import type { AppSettings } from '../api'
import Modal from './Modal'
import './SettingsModal.css'

export interface SettingsModalProps {
  open: boolean
  onClose: () => void
}

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [keyInput, setKeyInput] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const savedTimerRef = useRef<number | null>(null)

  // 모달이 열릴 때 설정을 불러오고 폼 상태 초기화
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setSettings(null)
    setLoading(true)
    setError('')
    setKeyInput('')
    setShowKey(false)
    setSaved(false)
    setTestResult(null)
    api
      .getSettings()
      .then((s) => {
        if (!cancelled) setSettings(s)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : '설정을 불러오지 못했어요')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  // "저장됨 ✓" 타이머 정리
  useEffect(() => {
    return () => {
      if (savedTimerRef.current) window.clearTimeout(savedTimerRef.current)
    }
  }, [])

  const handleSave = async (e: FormEvent) => {
    e.preventDefault()
    const key = keyInput.trim()
    if (!key || saving) return
    setSaving(true)
    setError('')
    setTestResult(null)
    try {
      const next = await api.updateSettings({ gemini_api_key: key })
      setSettings(next)
      setKeyInput('')
      setSaved(true)
      if (savedTimerRef.current) window.clearTimeout(savedTimerRef.current)
      savedTimerRef.current = window.setTimeout(() => setSaved(false), 2000)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '설정 저장에 실패했어요')
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    if (testing) return
    setTesting(true)
    setError('')
    setTestResult(null)
    try {
      const res = await api.testGemini()
      setTestResult(res)
    } catch (err: unknown) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : '연결 테스트에 실패했어요',
      })
    } finally {
      setTesting(false)
    }
  }

  const handleDeleteKey = async () => {
    if (deleting) return
    if (!window.confirm('저장된 Gemini API 키를 삭제할까요?\n삭제하면 Ollama 또는 내장 추출 요약으로 동작해요.')) {
      return
    }
    setDeleting(true)
    setError('')
    setTestResult(null)
    try {
      const next = await api.updateSettings({ gemini_api_key: '' })
      setSettings(next)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '키 삭제에 실패했어요')
    } finally {
      setDeleting(false)
    }
  }

  const renderEngineBadge = (s: AppSettings) => {
    if (s.gemini_api_key_set) {
      return (
        <span className="badge badge-green">
          Gemini 연결됨{s.gemini_key_preview ? ` (${s.gemini_key_preview})` : ''}
        </span>
      )
    }
    if (s.ollama_available) {
      return <span className="badge badge-blue">Ollama 사용 가능</span>
    }
    return <span className="badge badge-gray">내장 추출 요약</span>
  }

  return (
    <Modal open={open} title="설정" width={520} onClose={onClose}>
      {error && <div className="settings-error">{error}</div>}

      {loading ? (
        <div className="settings-loading">
          <span className="spinner" />
        </div>
      ) : settings ? (
        <section className="settings-section">
          <h4 className="settings-section-title">AI 요약 엔진</h4>

          <div className="settings-status-row">
            <span className="settings-status-label">현재 엔진</span>
            {renderEngineBadge(settings)}
          </div>

          <form onSubmit={handleSave}>
            <label className="field-label" htmlFor="settings-gemini-key">
              Gemini API 키
            </label>
            <div className="settings-key-wrap">
              <input
                id="settings-gemini-key"
                className="input settings-key-input"
                type={showKey ? 'text' : 'password'}
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                placeholder="AIza..."
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                className="settings-key-toggle"
                onClick={() => setShowKey((v) => !v)}
                aria-label={showKey ? 'API 키 숨기기' : 'API 키 표시'}
                title={showKey ? 'API 키 숨기기' : 'API 키 표시'}
              >
                {showKey ? '🙈' : '👁'}
              </button>
            </div>

            <div className="settings-actions">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={!keyInput.trim() || saving}
              >
                {saving ? '저장 중...' : saved ? '저장됨 ✓' : '저장'}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={handleTest}
                disabled={!settings.gemini_api_key_set || testing}
              >
                {testing ? '테스트 중...' : '연결 테스트'}
              </button>
              {settings.gemini_api_key_set && (
                <button
                  type="button"
                  className="btn btn-danger settings-delete"
                  onClick={handleDeleteKey}
                  disabled={deleting}
                >
                  {deleting ? '삭제 중...' : '키 삭제'}
                </button>
              )}
            </div>
          </form>

          {testResult && (
            <div className={`settings-test-result ${testResult.ok ? 'ok' : 'fail'}`}>
              {testResult.ok ? '✅' : '❌'} {testResult.message}
            </div>
          )}

          <p className="muted settings-note">
            키는 이 PC의 로컬 데이터베이스에만 저장됩니다.{' '}
            <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
              Google AI Studio(aistudio.google.com/apikey)
            </a>
            에서 무료로 발급받을 수 있어요.
          </p>
        </section>
      ) : null}
    </Modal>
  )
}

export default SettingsModal
