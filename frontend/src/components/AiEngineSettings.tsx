import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { api } from '../api'
import type { AppSettings } from '../api'
import ComboBox from './ComboBox'
import { useConfirm } from './confirm'
import './AiEngineSettings.css'

/** 모델 목록 로드 실패/키 미등록 시 보여줄 추천 모델 폴백 목록 (최신순) */
const FALLBACK_GEMINI_MODELS = [
  'gemini-flash-latest',
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
]

/**
 * AI 요약 엔진 설정 카드 섹션 (설정 페이지에서 사용).
 * 현재 엔진 상태 배지 + Gemini API 키 등록/테스트/삭제 + 모델 선택 + 요약 지시사항(프롬프트) 카드.
 */
export function AiEngineSettings() {
  const confirm = useConfirm()
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [keyInput, setKeyInput] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const savedTimerRef = useRef<number | null>(null)

  // Gemini 모델 선택
  const [modelInput, setModelInput] = useState('')
  const [modelOptions, setModelOptions] = useState<string[]>(FALLBACK_GEMINI_MODELS)
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsHint, setModelsHint] = useState('') // 목록 로드 실패 사유 (폴백 목록 사용 안내)
  const [modelError, setModelError] = useState('')
  const [modelSaving, setModelSaving] = useState(false)
  const [modelSaved, setModelSaved] = useState(false)
  const modelTimerRef = useRef<number | null>(null)

  // 요약 지시사항 (프롬프트)
  const [promptInput, setPromptInput] = useState('')
  const [promptError, setPromptError] = useState('')
  const [promptSaving, setPromptSaving] = useState(false)
  const [promptSaved, setPromptSaved] = useState(false)
  const promptTimerRef = useRef<number | null>(null)

  // 마운트 시 설정 로드
  useEffect(() => {
    let cancelled = false
    api
      .getSettings()
      .then((s) => {
        if (!cancelled) {
          setSettings(s)
          setPromptInput(s.summary_prompt)
          setModelInput(s.gemini_model)
        }
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
  }, [])

  // 키가 등록돼 있으면 사용 가능한 모델 목록 로드 (키가 바뀌면 다시 로드)
  // keyStamp: 키 미등록이면 null, 등록이면 preview 문자열 — 값이 바뀔 때만 재요청
  const keyStamp = settings?.gemini_api_key_set ? (settings.gemini_key_preview ?? '') : null
  useEffect(() => {
    if (keyStamp === null) {
      setModelOptions(FALLBACK_GEMINI_MODELS)
      setModelsHint('')
      return
    }
    let cancelled = false
    setModelsLoading(true)
    api
      .listGeminiModels()
      .then((res) => {
        if (cancelled) return
        if (res.error || res.models.length === 0) {
          setModelOptions(FALLBACK_GEMINI_MODELS)
          setModelsHint(res.error ?? '사용 가능한 모델을 찾지 못했어요')
        } else {
          setModelOptions(res.models.map((m) => m.name))
          setModelsHint('')
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setModelOptions(FALLBACK_GEMINI_MODELS)
          setModelsHint(e instanceof Error ? e.message : '모델 목록을 불러오지 못했어요')
        }
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [keyStamp])

  // "저장됨 ✓" 타이머 정리
  useEffect(() => {
    return () => {
      if (savedTimerRef.current) window.clearTimeout(savedTimerRef.current)
      if (promptTimerRef.current) window.clearTimeout(promptTimerRef.current)
      if (modelTimerRef.current) window.clearTimeout(modelTimerRef.current)
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

  const modelUnchanged = settings !== null && modelInput.trim() === settings.gemini_model

  const handleModelSave = async (e: FormEvent) => {
    e.preventDefault()
    if (modelSaving || !settings || modelUnchanged) return
    setModelSaving(true)
    setModelError('')
    try {
      // 빈 문자열로 저장하면 모델 설정 삭제(기본 모델로 복귀)
      const next = await api.updateSettings({ gemini_model: modelInput.trim() })
      setSettings(next)
      setModelInput(next.gemini_model)
      setModelSaved(true)
      if (modelTimerRef.current) window.clearTimeout(modelTimerRef.current)
      modelTimerRef.current = window.setTimeout(() => setModelSaved(false), 2000)
    } catch (err: unknown) {
      setModelError(err instanceof Error ? err.message : '모델 저장에 실패했어요')
    } finally {
      setModelSaving(false)
    }
  }

  const promptUnchanged = settings !== null && promptInput.trim() === settings.summary_prompt

  const handlePromptSave = async (e: FormEvent) => {
    e.preventDefault()
    if (promptSaving || !settings || promptUnchanged) return
    setPromptSaving(true)
    setPromptError('')
    try {
      // 빈 문자열로 저장하면 프롬프트 삭제(기본 프롬프트만 사용)
      const next = await api.updateSettings({ summary_prompt: promptInput.trim() })
      setSettings(next)
      setPromptInput(next.summary_prompt)
      setPromptSaved(true)
      if (promptTimerRef.current) window.clearTimeout(promptTimerRef.current)
      promptTimerRef.current = window.setTimeout(() => setPromptSaved(false), 2000)
    } catch (err: unknown) {
      setPromptError(err instanceof Error ? err.message : '지시사항 저장에 실패했어요')
    } finally {
      setPromptSaving(false)
    }
  }

  const handleDeleteKey = async () => {
    if (deleting) return
    const ok = await confirm({
      title: '저장된 Gemini API 키를 삭제할까요?',
      message: '삭제하면 Ollama 또는 내장 추출 요약으로 동작해요.',
      confirmLabel: '삭제',
      danger: true,
    })
    if (!ok) return
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
    <>
      <section className="card settings-card ai-engine-settings">
        <div className="settings-card-head">
          <h2 className="settings-card-title">
            <span aria-hidden="true">✨</span> AI 요약 엔진
          </h2>
          <p className="settings-card-desc">
            회의 요약에 사용할 엔진을 관리합니다. Gemini API 키를 등록하면 더 정확한 AI 요약을 받을 수
            있어요.
          </p>
        </div>

        {error && <div className="settings-error">{error}</div>}

        {loading ? (
          <div className="settings-loading">
            <span className="spinner" />
          </div>
        ) : settings ? (
          <>
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

            {/* Gemini 모델 선택 */}
            <form className="settings-model-form" onSubmit={handleModelSave}>
              <div className="field-label">
                모델
                {modelsLoading && (
                  <span className="settings-model-loading">목록 불러오는 중...</span>
                )}
              </div>

              {modelError && <div className="settings-error">{modelError}</div>}

              <div className="settings-model-row">
                <ComboBox
                  value={modelInput}
                  onChange={setModelInput}
                  options={modelOptions}
                  placeholder="gemini-2.5-flash"
                />
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={modelUnchanged || modelSaving}
                >
                  {modelSaving ? '저장 중...' : modelSaved ? '저장됨 ✓' : '저장'}
                </button>
              </div>

              <p className="settings-model-current">
                현재 사용 모델:{' '}
                <code className="settings-model-code">{settings.gemini_model}</code>
              </p>
              <p className="muted settings-model-hint">
                {!settings.gemini_api_key_set
                  ? 'API 키를 등록하면 사용 가능한 모델 목록을 자동으로 불러와요. 지금은 추천 목록에서 고르거나 직접 입력할 수 있어요.'
                  : modelsHint
                    ? `모델 목록을 불러오지 못해 추천 목록을 표시해요 (${modelsHint}). 직접 입력할 수도 있어요.`
                    : '목록에서 고르거나 직접 입력할 수 있어요.'}{' '}
                비워두고 저장하면 기본 모델로 돌아가요.
              </p>
            </form>

            <p className="muted settings-note">
              키는 이 PC의 로컬 데이터베이스에만 저장됩니다.{' '}
              <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
                Google AI Studio(aistudio.google.com/apikey)
              </a>
              에서 무료로 발급받을 수 있어요.
            </p>
          </>
        ) : null}
      </section>

      {/* 요약 지시사항 (프롬프트) 카드 */}
      <section className="card settings-card ai-prompt-settings">
        <div className="settings-card-head">
          <h2 className="settings-card-title">
            <span aria-hidden="true">📝</span> 요약 지시사항 (프롬프트)
          </h2>
          <p className="settings-card-desc">
            AI가 요약과 회의록을 만들 때 따라야 할 추가 지시사항을 적어두세요.
          </p>
        </div>

        {promptError && <div className="settings-error">{promptError}</div>}

        {loading ? (
          <div className="settings-loading">
            <span className="spinner" />
          </div>
        ) : settings ? (
          <>
            <form onSubmit={handlePromptSave}>
              <label className="field-label" htmlFor="settings-summary-prompt">
                요약 지시사항
              </label>
              <textarea
                id="settings-summary-prompt"
                className="input settings-prompt-textarea"
                value={promptInput}
                onChange={(e) => setPromptInput(e.target.value)}
                placeholder={
                  '결정 사항은 담당자와 기한을 반드시 표기해줘.\n회의록은 격식체로 작성해줘.'
                }
                rows={4}
                spellCheck={false}
              />
              <div className="settings-actions">
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={promptUnchanged || promptSaving}
                >
                  {promptSaving ? '저장 중...' : promptSaved ? '저장됨 ✓' : '저장'}
                </button>
              </div>
            </form>

            <p className="muted settings-note">
              요약 생성 시 기본 규칙과 함께 AI에게 전달돼요. 기본 규칙과 충돌하면 이 지시사항이
              우선됩니다. 비워두고 저장하면 기본 프롬프트만 사용해요.
            </p>
          </>
        ) : null}
      </section>
    </>
  )
}

export default AiEngineSettings
