import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import type { Meeting } from '../types'
import { formatClock, formatRelativeDate } from '../utils'
import Modal from './Modal'
import StatusBadge from './StatusBadge'
import './components.css'

export interface RecentMeetingsPanelProps {
  refreshKey?: number
}

export function RecentMeetingsPanel({ refreshKey = 0 }: RecentMeetingsPanelProps) {
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [query, setQuery] = useState('')
  const navigate = useNavigate()

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api
      .listMeetings()
      .then((list) => {
        if (!cancelled) setMeetings(list)
      })
      .catch(() => {
        if (!cancelled) setMeetings([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  const recent = meetings.slice(0, 6)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return meetings
    return meetings.filter((m) => m.title.toLowerCase().includes(q))
  }, [meetings, query])

  const goToMeeting = (id: number) => {
    setModalOpen(false)
    navigate(`/meetings/${id}`)
  }

  const openAll = () => {
    setQuery('')
    setModalOpen(true)
  }

  return (
    <aside className="recent-panel">
      <div className="card recent-card">
        <div className="recent-head">
          <h3>최근 회의</h3>
          <button type="button" className="link-btn" onClick={openAll}>
            전체 보기
          </button>
        </div>

        {loading ? (
          <div className="recent-loading">
            <span className="spinner" />
          </div>
        ) : recent.length === 0 ? (
          <div className="recent-empty">아직 회의 기록이 없어요</div>
        ) : (
          <div className="recent-list">
            {recent.map((m) => (
              <button
                key={m.id}
                type="button"
                className="recent-item"
                onClick={() => navigate(`/meetings/${m.id}`)}
              >
                <span className="recent-item-title">
                  <span className="recent-item-icon">📄</span>
                  <span className="recent-item-name">{m.title}</span>
                </span>
                <span className="recent-item-meta">
                  <StatusBadge status={m.status} />
                  <span className="muted">
                    {formatRelativeDate(m.started_at)} · {formatClock(m.duration_sec)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="ai-promo">
        <div className="ai-promo-emoji">✨</div>
        <p className="ai-promo-title">회의를 더 빠르게 정리해보세요</p>
        <button type="button" className="ai-promo-link" onClick={() => navigate('/meetings')}>
          AI 요약 사용하기 →
        </button>
      </div>

      <Modal open={modalOpen} title="전체 회의" width={560} onClose={() => setModalOpen(false)}>
        <input
          className="input meeting-modal-search"
          type="search"
          placeholder="회의 제목으로 검색..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        {filtered.length === 0 ? (
          <div className="empty-state">
            <div className="emoji">🔍</div>
            {meetings.length === 0 ? '아직 회의 기록이 없어요' : '검색 결과가 없어요'}
          </div>
        ) : (
          <div className="meeting-modal-list">
            {filtered.map((m) => (
              <button
                key={m.id}
                type="button"
                className="meeting-modal-row"
                onClick={() => goToMeeting(m.id)}
              >
                <span className="meeting-modal-row-title">{m.title}</span>
                <StatusBadge status={m.status} />
                <span className="meeting-modal-row-meta">
                  {formatRelativeDate(m.started_at)} · {formatClock(m.duration_sec)}
                </span>
              </button>
            ))}
          </div>
        )}
      </Modal>
    </aside>
  )
}

export default RecentMeetingsPanel
