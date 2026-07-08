import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../App'
import { AvatarStack } from '../components/Avatar'
import { MeetingDetailView } from '../components/MeetingDetailView'
import Modal from '../components/Modal'
import { StatusBadge } from '../components/StatusBadge'
import type { Meeting, Tag } from '../types'
import { formatClock, formatDuration, formatKoreanDateTime } from '../utils'
import './HomePage.css'

export default function HomePage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [meetings, setMeetings] = useState<Meeting[] | null>(null)
  const [tags, setTags] = useState<Tag[]>([])
  const [detailId, setDetailId] = useState<number | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

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
  }, [reloadKey])

  const loading = meetings === null
  const list = meetings ?? []
  const recordedList = list.filter((m) => m.status !== 'scheduled')
  const totalCount = recordedList.length
  const doneCount = recordedList.filter((m) => m.status === 'done').length
  const totalSec = recordedList.reduce((acc, m) => acc + (m.duration_sec ?? 0), 0)
  const recentShared = recordedList.filter((m) => m.is_shared).slice(0, 6)
  const recentMine = recordedList.filter((m) => m.user_id === user?.id).slice(0, 6)

  const tagColor = (name: string) => tags.find((t) => t.name === name)?.color ?? '#16a34a'

  const renderMeetingCard = (m: Meeting, options?: { showOwner?: boolean }) => (
    <div
      key={m.id}
      className="card meeting-card"
      role="button"
      tabIndex={0}
      onClick={() => setDetailId(m.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') setDetailId(m.id)
      }}
    >
      <div className="meeting-card-top">
        {m.tag &&
          (() => {
            const c = tagColor(m.tag)
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
        {m.locked && (
          <span className="lock-pill lock-pill-icon" title="잠금됨" aria-label="잠금됨">
            🔒
          </span>
        )}
        {m.is_shared && <span className="home-shared-pill">공유</span>}
        <StatusBadge status={m.status} />
      </div>
      <div className="meeting-card-meta">
        <span>{formatKoreanDateTime(m.started_at)}</span>
        <span className="meta-dot">·</span>
        <span>{formatClock(m.duration_sec)}</span>
      </div>
      <div className="meeting-card-foot">
        {m.participants.length > 0 ? (
          <AvatarStack participants={m.participants} max={4} />
        ) : (
          <span className="muted">참석자 없음</span>
        )}
        {options?.showOwner && m.owner_name && (
          <span className="home-owner-pill">{m.user_id === user?.id ? '내 회의' : m.owner_name}</span>
        )}
      </div>
    </div>
  )

  const renderRecentSection = (
    title: string,
    subtitle: string,
    items: Meeting[],
    empty: string,
    scope: 'shared' | 'mine',
    showOwner = false,
  ) => (
    <section className="home-recent-block" aria-label={title}>
      <div className="home-recent-block-head">
        <div>
          <h2 className="home-section-title">{title}</h2>
          <p>{subtitle}</p>
        </div>
        {items.length > 0 && (
          <button className="btn btn-ghost home-view-all" onClick={() => navigate(`/meetings?scope=${scope}`)}>
            전체 보기
          </button>
        )}
      </div>
      {items.length === 0 ? (
        <div className="home-recent-empty">{empty}</div>
      ) : (
        <div className="meeting-card-grid home-recent-card-grid">
          {items.map((m) => renderMeetingCard(m, { showOwner }))}
        </div>
      )}
    </section>
  )

  return (
    <div className="page home-page">
      <div className="home-hero">
        <div>
          <h1 className="home-greeting">
            <span className="home-greeting-desktop">안녕하세요, {user?.name}님 👋</span>
            <span className="home-greeting-mobile">환영합니다!, 👋</span>
          </h1>
          <p className="home-sub">
            <span className="home-sub-desktop">오늘의 회의를 기록하고, AI 요약으로 빠르게 정리해보세요.</span>
            <span className="home-sub-mobile">오늘도 생산적인 회의를 만들어보세요.</span>
          </p>
        </div>
        <button className="btn btn-primary btn-lg home-hero-button" onClick={() => navigate('/record')}>
          🎙️ 새 회의 기록
        </button>
      </div>

      <button type="button" className="mobile-record-cta" onClick={() => navigate('/record')}>
        <span className="mobile-record-icon">🎙️</span>
        <span className="mobile-record-copy">
          <strong>새 회의 시작</strong>
          <span>회의를 녹음하고 자동 요약과 회의록을 생성하세요.</span>
        </span>
        <span className="mobile-record-arrow">→</span>
        <span className="mobile-record-wave" aria-hidden="true">
          {Array.from({ length: 18 }, (_, i) => (
            <span key={i} />
          ))}
        </span>
      </button>

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

      {loading ? (
        <div className="home-loading">
          <span className="spinner" />
        </div>
      ) : recordedList.length === 0 ? (
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
        <div className="home-recent-layout">
          {renderRecentSection(
            '최근 공유된 회의',
            '공유된 회의 중 최근 기록을 빠르게 확인하세요.',
            recentShared,
            '아직 공유된 회의가 없어요.',
            'shared',
            true,
          )}
          {renderRecentSection(
            '최근 내 회의',
            '내가 만든 회의 기록만 따로 모아봤어요.',
            recentMine,
            '아직 내 회의 기록이 없어요.',
            'mine',
          )}
        </div>
      )}

      <Modal open={detailId !== null} title="회의 내용" width={960} onClose={() => setDetailId(null)}>
        {detailId !== null && (
          <MeetingDetailView
            meetingId={detailId}
            onBack={() => setDetailId(null)}
            onDeleted={() => {
              setDetailId(null)
              setReloadKey((k) => k + 1)
            }}
            onChanged={() => setReloadKey((k) => k + 1)}
          />
        )}
      </Modal>
    </div>
  )
}
