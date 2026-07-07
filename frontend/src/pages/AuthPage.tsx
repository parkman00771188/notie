import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../App'
import './AuthPage.css'

type Mode = 'login' | 'signup'

/** 녹음 카드 가짜 파형 막대 높이(px) */
const WAVE_HEIGHTS = [
  10, 18, 26, 14, 32, 22, 36, 16, 28, 12, 24, 34, 18, 26, 10, 20, 30, 14, 22, 28, 12, 18, 24, 16,
]

const KEY_POINT_LINES = ['온보딩 개선 방향 합의', '베타 출시 일정 2주 단축', '주간 지표 대시보드 공유']
const DECISION_LINES = ['디자인 시안 A안 채택', '다음 회의 금요일 10시', 'QA 체크리스트 확정']
const FLOW_CHIPS: { icon: string; label: string }[] = [
  { icon: '✅', label: '요약 완료' },
  { icon: '📝', label: '회의록 생성' },
  { icon: '📌', label: '할 일 추출' },
]

export default function AuthPage() {
  const { setUser } = useAuth()
  const navigate = useNavigate()

  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [team, setTeam] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [remember, setRemember] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const notSupported = () => {
    alert('로컬 버전에서는 지원되지 않아요')
  }

  const switchMode = (next: Mode) => {
    if (next === mode) return
    setMode(next)
    setError(null)
  }

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (loading) return
    setError(null)
    setLoading(true)
    try {
      const res =
        mode === 'login'
          ? await api.login({ email: email.trim(), password })
          : await api.signup({
              email: email.trim(),
              password,
              name: name.trim(),
              team: team.trim() || undefined,
            })
      setUser(res.user)
      navigate('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : '요청에 실패했어요. 잠시 후 다시 시도해주세요.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-page">
      <header className="auth-topbar">
        <div className="auth-logo">
          <img src="/logo.png" alt="Notie 로고" />
        </div>
      </header>

      <div className="auth-container">
        {/* ---------- 좌측 히어로 ---------- */}
        <section className="auth-hero">
          <span className="hero-badge">✦ AI 회의록 도우미</span>
          <h1 className="hero-title">{'녹음하면,\n요약과 회의록이\n자동으로 완성됩니다'}</h1>
          <p className="hero-sub">{'회의의 모든 순간을 놓치지 않고,\nNotie가 깔끔하게 정리해드려요.'}</p>

          <div className="hero-illust" aria-hidden="true">
            {/* 녹음 중 카드 */}
            <div className="illust-card illust-recording">
              <div className="rec-head">
                <span className="rec-dot" />
                <span>회의 녹음 중…</span>
                <span className="rec-time">00:14:32</span>
              </div>
              <div className="rec-wave">
                {WAVE_HEIGHTS.map((h, i) => (
                  <span key={i} style={{ height: `${h}px` }} />
                ))}
              </div>
              <div className="rec-controls">
                <span className="rec-btn rec-btn-pause">
                  <span />
                  <span />
                </span>
                <span className="rec-btn rec-btn-stop">
                  <span />
                </span>
              </div>
            </div>

            {/* 회의 요약 카드 */}
            <div className="illust-card illust-summary">
              <div className="sum-title">📄 회의 요약</div>
              <div className="sum-section">핵심 요약</div>
              {KEY_POINT_LINES.map((line) => (
                <div className="sum-line" key={line}>
                  <span className="sum-bullet" />
                  <span>{line}</span>
                </div>
              ))}
              <div className="sum-section">결정 사항</div>
              {DECISION_LINES.map((line) => (
                <div className="sum-line" key={line}>
                  <span className="sum-check">✓</span>
                  <span>{line}</span>
                </div>
              ))}
            </div>

            {/* 점선 연결 장식 */}
            <span className="illust-dash illust-dash-1" />
            <span className="illust-dash illust-dash-2" />

            {/* 상태 칩 카드 */}
            <div className="illust-chips">
              {FLOW_CHIPS.map((chip) => (
                <div className="illust-chip" key={chip.label}>
                  <span className="illust-chip-icon">{chip.icon}</span>
                  <span>{chip.label}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ---------- 우측 로그인 카드 ---------- */}
        <section className="auth-card-col">
          <div className="auth-card card">
            <div className="auth-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'login'}
                className={`auth-tab${mode === 'login' ? ' active' : ''}`}
                onClick={() => switchMode('login')}
              >
                로그인
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'signup'}
                className={`auth-tab${mode === 'signup' ? ' active' : ''}`}
                onClick={() => switchMode('signup')}
              >
                회원가입
              </button>
            </div>

            {error && (
              <div className="auth-error" role="alert">
                <span>⚠️</span>
                <span>{error}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} noValidate={false}>
              {mode === 'signup' && (
                <div className="auth-field-row">
                  <div className="auth-field">
                    <label className="field-label" htmlFor="auth-name">
                      이름
                    </label>
                    <input
                      id="auth-name"
                      className="input"
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="홍길동"
                      autoComplete="name"
                      required
                    />
                  </div>
                  <div className="auth-field">
                    <label className="field-label" htmlFor="auth-team">
                      팀 <span className="auth-optional">(선택)</span>
                    </label>
                    <input
                      id="auth-team"
                      className="input"
                      type="text"
                      value={team}
                      onChange={(e) => setTeam(e.target.value)}
                      placeholder="프로덕트팀"
                      autoComplete="organization"
                    />
                  </div>
                </div>
              )}

              <div className="auth-field">
                <label className="field-label" htmlFor="auth-email">
                  이메일
                </label>
                <input
                  id="auth-email"
                  className="input"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  required
                />
              </div>

              <div className="auth-field">
                <label className="field-label" htmlFor="auth-password">
                  비밀번호
                </label>
                <div className="pw-wrap">
                  <input
                    id="auth-password"
                    className="input pw-input"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="비밀번호를 입력하세요"
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                    required
                  />
                  <button
                    type="button"
                    className="pw-toggle"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? '비밀번호 숨기기' : '비밀번호 표시'}
                    title={showPassword ? '비밀번호 숨기기' : '비밀번호 표시'}
                  >
                    {showPassword ? '🙈' : '👁'}
                  </button>
                </div>
              </div>

              <div className="auth-row">
                <label className="auth-remember">
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={(e) => setRemember(e.target.checked)}
                  />
                  로그인 상태 유지
                </label>
                <button type="button" className="auth-link" onClick={notSupported}>
                  비밀번호를 잊으셨나요?
                </button>
              </div>

              <button type="submit" className="btn btn-primary btn-lg auth-submit" disabled={loading}>
                {loading ? <span className="spinner" /> : mode === 'login' ? '로그인' : '회원가입'}
              </button>
            </form>

            <div className="auth-divider">또는</div>

            <div className="auth-social">
              <button type="button" className="auth-social-btn" onClick={notSupported}>
                <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true">
                  <path
                    fill="#EA4335"
                    d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                  />
                  <path
                    fill="#4285F4"
                    d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                  />
                  <path
                    fill="#34A853"
                    d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                  />
                </svg>
                Google로 계속하기
              </button>
              <button type="button" className="auth-social-btn" onClick={notSupported}>
                <svg width="16" height="16" viewBox="0 0 384 512" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z"
                  />
                </svg>
                Apple로 계속하기
              </button>
            </div>

            <p className="auth-terms">
              계속 진행하면 Notie의{' '}
              <button type="button" className="auth-terms-link" onClick={notSupported}>
                이용약관
              </button>{' '}
              및{' '}
              <button type="button" className="auth-terms-link" onClick={notSupported}>
                개인정보 처리방침
              </button>
              에 동의하는 것으로 간주됩니다.
            </p>
          </div>
        </section>
      </div>
    </div>
  )
}
