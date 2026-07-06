import { useEffect, useState } from 'react'
import type { MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { AvatarStack } from '../components/Avatar'
import { StatusBadge } from '../components/StatusBadge'
import type { Meeting } from '../types'
import { formatClock, formatKoreanDateTime } from '../utils'
import './MeetingsPage.css'

export default function MeetingsPage() {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [meetings, setMeetings] = useState<Meeting[] | null>(null)

  // 검색어 300ms 디바운스 후 목록 조회
  useEffect(() => {
    let alive = true
    const timer = window.setTimeout(() => {
      api
        .listMeetings(q.trim() || undefined)
        .then((list) => {
          if (alive) setMeetings(list)
        })
        .catch(() => {
          if (alive) setMeetings([])
        })
    }, 300)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [q])

  const handleDelete = async (e: MouseEvent, m: Meeting) => {
    e.stopPropagation()
    if (!window.confirm(`'${m.title}' 회의를 삭제할까요?\n녹음 파일과 기록이 모두 삭제됩니다.`)) return
    try {
      await api.deleteMeeting(m.id)
      setMeetings((prev) => (prev ? prev.filter((x) => x.id !== m.id) : prev))
    } catch (err) {
      alert(err instanceof Error ? err.message : '삭제에 실패했어요')
    }
  }

  const loading = meetings === null
  const list = meetings ?? []
  const searching = q.trim().length > 0

  return (
    <div className="page meetings-page">
      <div className="meetings-header">
        <h1 className="page-title">회의 목록</h1>
        <input
          className="input meetings-search"
          type="search"
          placeholder="회의 제목 검색"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {loading ? (
        <div className="meetings-loading">
          <span className="spinner" />
        </div>
      ) : list.length === 0 ? (
        <div className="card">
          {searching ? (
            <div className="empty-state">
              <div className="emoji">🔍</div>
              <p className="empty-title">검색 결과가 없어요</p>
              <p>다른 검색어로 다시 시도해보세요.</p>
            </div>
          ) : (
            <div className="empty-state">
              <div className="emoji">🎙️</div>
              <p className="empty-title">아직 기록된 회의가 없어요</p>
              <p>첫 회의를 녹음하면 여기에 표시돼요.</p>
              <button className="btn btn-primary empty-cta" onClick={() => navigate('/record')}>
                녹음 시작하기
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="card meeting-list">
          {list.map((m) => (
            <div
              key={m.id}
              className="meeting-row"
              role="button"
              tabIndex={0}
              onClick={() => navigate(`/meetings/${m.id}`)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') navigate(`/meetings/${m.id}`)
              }}
            >
              <span className="row-title" title={m.title}>
                {m.title}
                {m.tag && <span className="row-tag">#{m.tag}</span>}
              </span>
              <span className="row-badge">
                <StatusBadge status={m.status} />
              </span>
              <span className="row-date">{formatKoreanDateTime(m.started_at)}</span>
              <span className="row-dur">{formatClock(m.duration_sec)}</span>
              <span className="row-people">
                {m.participants.length > 0 ? (
                  <AvatarStack participants={m.participants} max={3} />
                ) : (
                  <span className="muted">-</span>
                )}
              </span>
              <button
                className="btn-icon row-delete"
                aria-label="회의 삭제"
                title="삭제"
                onClick={(e) => handleDelete(e, m)}
              >
                🗑️
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
