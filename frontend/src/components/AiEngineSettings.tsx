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
  const [recordingPromptInput, setRecordingPromptInput] = useState('')
  const [manualPromptInput, setManualPromptInput] = useState('')
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
          setRecordingPromptInput(s.summary_prompt)
          setManualPromptInput(s.manual_summary_prompt)
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

  const promptUnchanged =
    settings !== null &&
    recordingPromptInput.trim() === settings.summary_prompt &&
    manualPromptInput.trim() === settings.manual_summary_prompt

  const handlePromptSave = async (e: FormEvent) => {
    e.preventDefault()
    if (promptSaving || !settings || promptUnchanged) return
    setPromptSaving(true)
    setPromptError('')
    try {
      // 빈 문자열로 저장하면 프롬프트 삭제(기본 프롬프트만 사용)
      const next = await api.updateSettings({
        summary_prompt: recordingPromptInput.trim(),
        manual_summary_prompt: manualPromptInput.trim(),
      })
      setSettings(next)
      setRecordingPromptInput(next.summary_prompt)
      setManualPromptInput(next.manual_summary_prompt)
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
      message:
        '삭제하면 새 녹음의 음성 변환은 실패 후 임시저장될 수 있어요. AI 요약은 가능한 경우 Ollama 또는 내장 추출 요약으로 동작합니다.',
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
      {/* 음성 변환(STT) 엔진 카드 */}
      <section className="card settings-card stt-settings">
        <div className="settings-card-head">
          <h2 className="settings-card-title">
            <span aria-hidden="true">🎙</span> 음성 변환(STT) 엔진
          </h2>
          <p className="settings-card-desc">
            모든 사용자의 녹음·업로드 음성 변환은 Gemini로만 처리됩니다.
          </p>
        </div>

        {loading ? (
          <div className="settings-loading">
            <span className="spinner" />
          </div>
        ) : settings ? (
          <>
            <div className={`stt-fixed-card${settings.gemini_api_key_set ? '' : ' warning'}`}>
              <div className="stt-fixed-mark" aria-hidden="true">
                G
              </div>
              <div className="stt-fixed-body">
                <div className="stt-fixed-title">
                  Gemini <span className="badge badge-blue">전용</span>
                  {settings.gemini_api_key_set ? (
                    <span className="badge badge-green">키 등록됨</span>
                  ) : (
                    <span className="badge badge-gray">키 필요</span>
                  )}
                </div>
                <p className="stt-option-desc">
                  등록된 Gemini API 키로 음성을 텍스트로 변환합니다. 변환 실패 시 음성은
                  임시저장되고, 회의 상세에서 다시 시도할 수 있어요.
                </p>
              </div>
            </div>
            <p className="muted settings-note">
              {settings.gemini_api_key_set
                ? 'Gemini 변환이 실패하면 음성을 임시저장해두고, 키나 네트워크를 확인한 뒤 회의 상세에서 다시 시도할 수 있어요.'
                : 'Gemini 변환을 사용하려면 아래 카드에서 API 키를 먼저 등록해주세요.'}
            </p>
          </>
        ) : null}
      </section>

      <section className="card settings-card ai-engine-settings">
        <div className="settings-card-head">
          <h2 className="settings-card-title">
            <span aria-hidden="true">✨</span> AI 요약 엔진
          </h2>
          <p className="settings-card-desc">
            관리자 전용 전역 설정입니다. 저장한 API 키와 모델은 모든 사용자의 회의 요약에 자동 적용됩니다.
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
            녹음·업로드와 직접 작성 회의에 적용할 전역 지시사항을 각각 적어두세요.
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
              <div className="settings-prompt-grid">
                <label className="settings-prompt-field" htmlFor="settings-summary-prompt">
                  <span className="field-label">녹음·업로드 요약 지시사항</span>
                  <textarea
                    id="settings-summary-prompt"
                    className="input settings-prompt-textarea"
                    value={recordingPromptInput}
                    onChange={(e) => setRecordingPromptInput(e.target.value)}
                    placeholder={
                      '녹취록의 발언 흐름을 주제별로 정리해줘.\n결정 사항은 담당자와 기한을 반드시 표기해줘.'
                    }
                    rows={5}
                    spellCheck={false}
                  />
                </label>
                <label className="settings-prompt-field" htmlFor="settings-manual-summary-prompt">
                  <span className="field-label">직접 작성 요약 지시사항</span>
                  <textarea
                    id="settings-manual-summary-prompt"
                    className="input settings-prompt-textarea"
                    value={manualPromptInput}
                    onChange={(e) => setManualPromptInput(e.target.value)}
                    placeholder={
                      '사용자가 정리한 회의 내용을 바탕으로 회의록을 구성해줘.\n원문에 없는 내용은 추측하지 말아줘.'
                    }
                    rows={5}
                    spellCheck={false}
                  />
                </label>
              </div>
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
              요약 생성 시 기본 규칙과 함께 AI에게 전달돼요. 직접 작성 회의는 STT 없이 입력한
              본문을 기준으로 요약합니다. 비워두고 저장하면 기본 프롬프트만 사용해요.
            </p>
          </>
        ) : null}
      </section>
    </>
  )
}

export default AiEngineSettings
