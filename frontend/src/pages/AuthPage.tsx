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

const isMobileViewport = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches

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
  const [showIntro, setShowIntro] = useState(() => isMobileViewport())

  const switchMode = (next: Mode) => {
    if (next === mode) return
    setMode(next)
    setError(null)
  }

  const enterForm = (next: Mode) => {
    setMode(next)
    setError(null)
    setShowIntro(false)
  }

  const returnToIntro = () => {
    if (!isMobileViewport()) return
    setMode('login')
    setError(null)
    setShowIntro(true)
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

  if (showIntro) {
    return (
      <div className="auth-page auth-intro-page">
        <section className="mobile-auth-intro">
          <div className="mobile-intro-top">
            <div className="mobile-intro-brand">
              <img className="mobile-auth-logo" src="/logo.png" alt="Notie 로고" />
            </div>
            <button type="button" className="mobile-intro-login" onClick={() => enterForm('login')}>
              로그인
            </button>
          </div>

          <h1 className="mobile-intro-title">
            녹음하면,
            <br />
            <span>요약과 회의록</span>이
            <br />
            자동으로 완성됩니다
          </h1>
          <p className="mobile-intro-sub">
            회의의 모든 순간을 놓치지 않고,
            <br />
            Notie가 깔끔하게 정리해드려요.
          </p>

          <div className="mobile-record-demo" aria-hidden="true">
            <div className="rec-head">
              <span className="rec-dot" />
              <span>회의 녹음 중...</span>
              <span className="rec-time">00:14:32</span>
            </div>
            <div className="rec-wave mobile-rec-wave">
              {WAVE_HEIGHTS.map((h, i) => (
                <span key={i} style={{ height: `${h + 10}px` }} />
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

          <div className="mobile-feature-grid" aria-hidden="true">
            {FLOW_CHIPS.map((chip) => (
              <div className="mobile-feature-card" key={chip.label}>
                <span>{chip.icon}</span>
                <strong>{chip.label}</strong>
                <p>
                  {chip.label === '요약 완료'
                    ? '핵심 내용을 자동으로 요약'
                    : chip.label === '회의록 생성'
                      ? '정리된 회의록을 즉시 생성'
                      : '주요 할 일을 자동으로 추출'}
                </p>
              </div>
            ))}
          </div>

        </section>
      </div>
    )
  }

  return (
    <div className="auth-page">
      <header className="auth-topbar">
        <button type="button" className="auth-logo auth-logo-button" onClick={returnToIntro}>
          <img src="/logo.png" alt="Notie 로고" />
        </button>
      </header>

      <div className="auth-container">
        {/* ---------- 좌측 히어로 ---------- */}
        <section className="auth-hero">
          <button type="button" className="auth-logo auth-logo-button auth-hero-logo" onClick={returnToIntro}>
            <img src="/logo.png" alt="Notie 로고" />
          </button>
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
            <p className="auth-mobile-subtitle">
              Notie 계정으로 로그인하세요.
            </p>
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
                  사용자 ID
                </label>
                <input
                  id="auth-email"
                  className="input"
                  type="text"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="아이디를 입력하세요"
                  autoComplete="username"
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
              </div>

              <button type="submit" className="btn btn-primary btn-lg auth-submit" disabled={loading}>
                {loading ? <span className="spinner" /> : mode === 'login' ? '로그인' : '회원가입'}
              </button>
            </form>
          </div>
        </section>
      </div>
    </div>
  )
}
