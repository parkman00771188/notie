import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../App'
import { AvatarStack } from '../components/Avatar'
import { StatusBadge } from '../components/StatusBadge'
import type { Meeting, Tag } from '../types'
import { formatClock, formatDuration, formatRelativeDate } from '../utils'
import './HomePage.css'

export default function HomePage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [meetings, setMeetings] = useState<Meeting[] | null>(null)
  const [tags, setTags] = useState<Tag[]>([])

  useEffect(() => {
    let alive = true
    api
      .listMeetings()
      .then((list) => {
        if (alive) setMeetings(list)
      })
      .catch(() => {
        if (alive) setMeetings([])
      })
    // 태그 칩 색 매칭용 (실패해도 기본색으로 표시)
    api
      .listTags()
      .then((list) => {
        if (alive) setTags(list)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const loading = meetings === null
  const list = meetings ?? []
  const totalCount = list.length
  const doneCount = list.filter((m) => m.status === 'done').length
  const totalSec = list.reduce((acc, m) => acc + (m.duration_sec ?? 0), 0)
  const recent = list.slice(0, 6)

  return (
    <div className="page home-page">
      <div className="home-hero">
        <div>
          <h1 className="home-greeting">안녕하세요, {user?.name}님 👋</h1>
          <p className="home-sub">오늘의 회의를 기록하고, AI 요약으로 빠르게 정리해보세요.</p>
        </div>
        <button className="btn btn-primary btn-lg" onClick={() => navigate('/record')}>
          🎙️ 새 회의 기록
        </button>
      </div>

      <div className="stat-grid">
        <div className="card stat-card">
          <span className="stat-icon stat-icon-blue">📁</span>
          <div className="stat-body">
            <span className="stat-value">{totalCount}개</span>
            <span className="stat-label">전체 회의</span>
          </div>
        </div>
        <div className="card stat-card">
          <span className="stat-icon stat-icon-green">✨</span>
          <div className="stat-body">
            <span className="stat-value">{doneCount}개</span>
            <span className="stat-label">요약 완료</span>
          </div>
        </div>
        <div className="card stat-card">
          <span className="stat-icon stat-icon-gray">⏱️</span>
          <div className="stat-body">
            <span className="stat-value">{formatDuration(totalSec)}</span>
            <span className="stat-label">총 녹음 시간</span>
          </div>
        </div>
      </div>

      <div className="home-section-head">
        <h2 className="home-section-title">최근 회의</h2>
        {totalCount > 0 && (
          <button className="btn btn-ghost home-view-all" onClick={() => navigate('/meetings')}>
            전체 보기
          </button>
        )}
      </div>

      {loading ? (
        <div className="home-loading">
          <span className="spinner" />
        </div>
      ) : recent.length === 0 ? (
        <div className="card home-empty">
          <div className="empty-state">
            <div className="emoji">🎙️</div>
            <p className="empty-title">아직 기록된 회의가 없어요</p>
            <p>첫 회의를 녹음하면 AI가 요약과 회의록을 만들어드려요.</p>
            <button className="btn btn-primary empty-cta" onClick={() => navigate('/record')}>
              녹음 시작하기
            </button>
          </div>
        </div>
      ) : (
        <div className="meeting-card-grid">
          {recent.map((m) => (
            <div
              key={m.id}
              className="card meeting-card"
              role="button"
              tabIndex={0}
              onClick={() => navigate(`/meetings/${m.id}`)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') navigate(`/meetings/${m.id}`)
              }}
            >
              <div className="meeting-card-top">
                {m.tag &&
                  (() => {
                    const c = tags.find((t) => t.name === m.tag)?.color ?? '#16a34a'
                    return (
                      <span
                        className="tag-pill meeting-card-tagpill"
                        style={{
                          color: c,
                          borderColor: c,
                          background: `color-mix(in srgb, ${c} 10%, transparent)`,
                        }}
                      >
                        #{m.tag}
                      </span>
                    )
                  })()}
                <span className="meeting-card-title" title={m.title}>
                  {m.title}
                </span>
                <StatusBadge status={m.status} />
              </div>
              <div className="meeting-card-meta">
                <span>{formatRelativeDate(m.started_at)}</span>
                <span className="meta-dot">·</span>
                <span>{formatClock(m.duration_sec)}</span>
              </div>
              <div className="meeting-card-foot">
                {m.participants.length > 0 ? (
                  <AvatarStack participants={m.participants} max={4} />
                ) : (
                  <span className="muted">참석자 없음</span>
                )}
                <span className="meeting-card-open">열기 →</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
