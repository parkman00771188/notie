import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { marked } from 'marked'
import { api } from '../api'
import { AvatarStack } from '../components/Avatar'
import { ParticipantPicker } from '../components/ParticipantPicker'
import { StatusBadge } from '../components/StatusBadge'
import { TagPicker } from '../components/TagPicker'
import type { Bookmark, MeetingDetail, MeetingStatus, Participant } from '../types'
import { formatClock, formatKoreanDateTime } from '../utils'
import './MeetingDetailPage.css'

type TabKey = 'summary' | 'minutes' | 'transcript' | 'notes'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'summary', label: 'AI 요약' },
  { key: 'minutes', label: '회의록' },
  { key: 'transcript', label: '전체 스크립트' },
  { key: 'notes', label: '메모' },
]

const PROGRESS_MESSAGE: Partial<Record<MeetingStatus, string>> = {
  queued: '대기 중이에요...',
  transcribing: '음성을 텍스트로 변환하고 있어요...',
  summarizing: 'AI가 요약을 만들고 있어요...',
}

export default function MeetingDetailPage() {
  const { id } = useParams()
  const meetingId = Number(id)
  const navigate = useNavigate()

  const [meeting, setMeeting] = useState<MeetingDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tab, setTab] = useState<TabKey>('summary')
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const skipTitleSaveRef = useRef(false)
  const copyTimerRef = useRef<number | null>(null)

  // 최초 로드
  useEffect(() => {
    if (!Number.isFinite(meetingId)) {
      setLoadError('잘못된 회의 주소예요.')
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    setLoadError(null)
    api
      .getMeeting(meetingId)
      .then((m) => {
        if (alive) setMeeting(m)
      })
      .catch((e: unknown) => {
        if (alive) setLoadError(e instanceof Error ? e.message : '회의를 불러오지 못했어요.')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [meetingId])

  // done/failed가 아니면 3초 폴링
  const status = meeting?.status
  useEffect(() => {
    if (!status || status === 'done' || status === 'failed') return
    const timer = window.setInterval(() => {
      api
        .getMeeting(meetingId)
        .then(setMeeting)
        .catch(() => {
          /* 다음 폴링에서 재시도 */
        })
    }, 3000)
    return () => window.clearInterval(timer)
  }, [status, meetingId])

  // 복사 토스트 타이머 정리
  useEffect(() => {
    return () => {
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current)
    }
  }, [])

  const minutesHtml = useMemo(() => {
    const md = meeting?.summary?.minutes_md
    if (!md) return ''
    return marked.parse(md, { async: false }) as string
  }, [meeting?.summary?.minutes_md])

  const seekTo = (sec: number) => {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = Math.max(0, sec)
    audio.play().catch(() => {
      /* 자동재생 차단 시 무시 */
    })
  }

  // ----- 제목 인라인 편집 -----
  const startEditTitle = () => {
    if (!meeting) return
    setTitleDraft(meeting.title)
    setEditingTitle(true)
  }

  const saveTitle = async () => {
    setEditingTitle(false)
    if (!meeting) return
    const next = titleDraft.trim()
    if (!next || next === meeting.title) return
    setMeeting((prev) => (prev ? { ...prev, title: next } : prev))
    try {
      await api.updateMeeting(meeting.id, { title: next })
    } catch (e) {
      alert(e instanceof Error ? e.message : '제목 저장에 실패했어요')
      api.getMeeting(meetingId).then(setMeeting).catch(() => {})
    }
  }

  // ----- 태그 변경 (TagPicker) -----
  const handleTagChange = (tag: string | null) => {
    if (!meeting || tag === meeting.tag) return
    setMeeting((prev) => (prev ? { ...prev, tag } : prev))
    // 태그 제거(null)는 API 계약대로 빈 문자열로 전송
    api.updateMeeting(meeting.id, { tag: tag ?? '' }).catch(() => {
      api.getMeeting(meetingId).then(setMeeting).catch(() => {})
    })
  }

  // ----- 참석자 편집 -----
  const handleParticipantsChange = (ps: Participant[]) => {
    if (!meeting) return
    setMeeting((prev) => (prev ? { ...prev, participants: ps } : prev))
    api
      .updateMeeting(meeting.id, { participant_ids: ps.map((p) => p.id) })
      .catch(() => {
        api.getMeeting(meetingId).then(setMeeting).catch(() => {})
      })
  }

  // ----- 요약 다시 생성 / 재시도 -----
  const handleResummarize = async () => {
    if (!meeting) return
    try {
      await api.resummarize(meeting.id)
      // 상태를 즉시 summarizing으로 바꿔 폴링 재개
      setMeeting((prev) =>
        prev ? { ...prev, status: 'summarizing', error_message: null } : prev,
      )
      setTab('summary')
    } catch (e) {
      alert(e instanceof Error ? e.message : '요약 재생성에 실패했어요')
    }
  }

  // ----- 삭제 -----
  const handleDelete = async () => {
    if (!meeting) return
    if (!window.confirm('이 회의를 삭제할까요?\n녹음 파일과 기록이 모두 삭제됩니다.')) return
    try {
      await api.deleteMeeting(meeting.id)
      navigate('/meetings')
    } catch (e) {
      alert(e instanceof Error ? e.message : '삭제에 실패했어요')
    }
  }

  // ----- 회의록 복사 -----
  const handleCopy = async () => {
    const md = meeting?.summary?.minutes_md
    if (!md) return
    try {
      await navigator.clipboard.writeText(md)
      setCopied(true)
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current)
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 2000)
    } catch {
      alert('클립보드 복사에 실패했어요')
    }
  }

  // ----- 북마크(메모) 수정/삭제 -----
  const handleEditBookmark = async (b: Bookmark) => {
    const next = window.prompt('메모 내용을 수정하세요', b.title)
    if (next === null) return
    const title = next.trim()
    if (!title || title === b.title) return
    try {
      const updated = await api.updateBookmark(b.id, { title })
      setMeeting((prev) =>
        prev
          ? { ...prev, bookmarks: prev.bookmarks.map((x) => (x.id === b.id ? updated : x)) }
          : prev,
      )
    } catch (e) {
      alert(e instanceof Error ? e.message : '메모 수정에 실패했어요')
    }
  }

  const handleDeleteBookmark = async (b: Bookmark) => {
    if (!window.confirm('이 메모를 삭제할까요?')) return
    try {
      await api.deleteBookmark(b.id)
      setMeeting((prev) =>
        prev ? { ...prev, bookmarks: prev.bookmarks.filter((x) => x.id !== b.id) } : prev,
      )
    } catch (e) {
      alert(e instanceof Error ? e.message : '메모 삭제에 실패했어요')
    }
  }

  // ----- 렌더 -----
  if (loading) {
    return (
      <div className="page detail-page">
        <div className="detail-loading">
          <span className="spinner" />
        </div>
      </div>
    )
  }

  if (loadError || !meeting) {
    return (
      <div className="page detail-page">
        <div className="card">
          <div className="empty-state">
            <div className="emoji">😕</div>
            <p className="empty-title">{loadError ?? '회의를 찾을 수 없어요.'}</p>
            <button className="btn btn-primary empty-cta" onClick={() => navigate('/meetings')}>
              회의 목록으로
            </button>
          </div>
        </div>
      </div>
    )
  }

  const summary = meeting.summary
  const progressMessage = PROGRESS_MESSAGE[meeting.status]
  const canResummarize =
    meeting.segments.length > 0 && (meeting.status === 'done' || meeting.status === 'failed')

  return (
    <div className="page detail-page">
      <button className="detail-back" onClick={() => navigate('/meetings')}>
        ← 회의 목록
      </button>

      {/* 헤더 */}
      <div className="detail-header">
        <div className="detail-title-row">
          {editingTitle ? (
            <input
              className="input detail-title-input"
              value={titleDraft}
              autoFocus
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => {
                if (skipTitleSaveRef.current) {
                  skipTitleSaveRef.current = false
                  return
                }
                saveTitle()
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
                if (e.key === 'Escape') {
                  skipTitleSaveRef.current = true
                  setEditingTitle(false)
                }
              }}
            />
          ) : (
            <>
              <h1 className="page-title detail-title">{meeting.title}</h1>
              <button className="btn-icon" aria-label="제목 수정" title="제목 수정" onClick={startEditTitle}>
                ✏️
              </button>
            </>
          )}
          <StatusBadge status={meeting.status} />
          <div className="detail-actions">
            {canResummarize && (
              <button className="btn btn-soft" onClick={handleResummarize}>
                ✨ 요약 다시 생성
              </button>
            )}
            <button className="btn btn-danger" onClick={handleDelete}>
              삭제
            </button>
          </div>
        </div>

        <div className="detail-meta">
          <span>{formatKoreanDateTime(meeting.started_at)}</span>
          {meeting.duration_sec != null && (
            <>
              <span className="meta-dot">·</span>
              <span>{formatClock(meeting.duration_sec)}</span>
            </>
          )}
          <TagPicker compact value={meeting.tag} onChange={handleTagChange} />
        </div>

        <div className="detail-people">
          {meeting.participants.length > 0 && (
            <AvatarStack participants={meeting.participants} max={6} />
          )}
          <span className="muted">참석자 {meeting.participants.length}명</span>
          <button className="btn btn-ghost detail-people-edit" onClick={() => setPickerOpen(true)}>
            참석자 편집
          </button>
        </div>
      </div>

      {/* 진행 배너 */}
      {progressMessage && (
        <div className="progress-banner">
          <span className="spinner" />
          <span className="progress-text">{progressMessage}</span>
        </div>
      )}

      {/* 실패 배너 */}
      {meeting.status === 'failed' && (
        <div className="failed-banner">
          <span className="failed-emoji">⚠️</span>
          <div className="failed-body">
            <strong>처리에 실패했어요</strong>
            {meeting.error_message && <p className="failed-message">{meeting.error_message}</p>}
          </div>
          <button className="btn btn-danger" onClick={handleResummarize}>
            다시 시도
          </button>
        </div>
      )}

      {/* 오디오 플레이어 + 북마크 칩 */}
      {meeting.audio_filename && (
        <div className="card audio-card">
          <audio
            ref={audioRef}
            className="detail-audio"
            controls
            preload="metadata"
            src={api.audioUrl(meeting.id)}
          />
          {meeting.bookmarks.length > 0 && (
            <div className="bookmark-chips">
              {meeting.bookmarks.map((b) => (
                <button
                  key={b.id}
                  className="time-chip bm-chip"
                  title={b.title}
                  onClick={() => seekTo(b.time_sec)}
                >
                  🔖 {formatClock(b.time_sec)}
                  <span className="bm-chip-title">{b.title}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 탭 */}
      <div className="detail-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`detail-tab${tab === t.key ? ' active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.key === 'notes' && meeting.bookmarks.length > 0 && (
              <span className="tab-count">{meeting.bookmarks.length}</span>
            )}
          </button>
        ))}
      </div>

      <div className="card tab-panel">
        {/* AI 요약 */}
        {tab === 'summary' &&
          (summary ? (
            <div className="summary-panel">
              <section className="summary-section">
                <h3 className="section-title">핵심 요약</h3>
                {summary.key_points.length > 0 ? (
                  <ul className="kp-list">
                    {summary.key_points.map((p, i) => (
                      <li key={i}>{p}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">핵심 요약이 없어요.</p>
                )}
              </section>

              <section className="summary-section">
                <h3 className="section-title">결정 사항</h3>
                {summary.decisions.length > 0 ? (
                  <ul className="decision-list">
                    {summary.decisions.map((d, i) => (
                      <li key={i}>
                        <span className="decision-check">✅</span>
                        <span>{d}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">기록된 결정 사항이 없어요.</p>
                )}
              </section>

              <section className="summary-section">
                <h3 className="section-title">할 일</h3>
                {summary.action_items.length > 0 ? (
                  <ul className="todo-list">
                    {summary.action_items.map((t, i) => (
                      <li key={i}>
                        <span className="todo-box" aria-hidden="true" />
                        <span className="todo-text">{t.text}</span>
                        {t.owner && <span className="badge badge-blue">{t.owner}</span>}
                        {t.due && <span className="badge badge-gray">{t.due}</span>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">할 일이 없어요.</p>
                )}
              </section>

              <p className="muted engine-note">엔진: {summary.engine}</p>

              {summary.engine.startsWith('extractive') && (
                <div className="gemini-hint">
                  💡 설정에서 Gemini API 키를 등록하면 더 정확한 AI 요약을 받을 수 있어요.
                </div>
              )}
            </div>
          ) : (
            <div className="empty-state">
              <div className="emoji">✨</div>
              <p>{progressMessage ?? 'AI 요약이 아직 준비되지 않았어요.'}</p>
            </div>
          ))}

        {/* 회의록 */}
        {tab === 'minutes' &&
          (summary?.minutes_md ? (
            <div className="minutes-panel">
              <div className="minutes-toolbar">
                <button className="btn btn-ghost" onClick={handleCopy}>
                  {copied ? '복사됨 ✓' : '복사'}
                </button>
              </div>
              <div className="markdown-body" dangerouslySetInnerHTML={{ __html: minutesHtml }} />
            </div>
          ) : (
            <div className="empty-state">
              <div className="emoji">📄</div>
              <p>{progressMessage ?? '회의록이 아직 준비되지 않았어요.'}</p>
            </div>
          ))}

        {/* 전체 스크립트 */}
        {tab === 'transcript' &&
          (meeting.segments.length > 0 ? (
            <div className="transcript-list">
              {meeting.segments.map((seg) => (
                <div key={seg.id} className="segment-row">
                  <button className="time-chip" onClick={() => seekTo(seg.start_sec)}>
                    {formatClock(seg.start_sec)}
                  </button>
                  <p className="segment-text">{seg.text}</p>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <div className="emoji">🗣️</div>
              <p>{progressMessage ?? '인식된 음성이 없어요.'}</p>
            </div>
          ))}

        {/* 메모 */}
        {tab === 'notes' &&
          (meeting.bookmarks.length > 0 ? (
            <div className="note-list">
              {meeting.bookmarks.map((b) => (
                <div key={b.id} className="note-row">
                  <button className="time-chip" onClick={() => seekTo(b.time_sec)}>
                    {formatClock(b.time_sec)}
                  </button>
                  <div className="note-body">
                    <p className="note-title">{b.title}</p>
                    {b.note && <p className="muted">{b.note}</p>}
                  </div>
                  <div className="note-actions">
                    <button
                      className="btn-icon"
                      aria-label="메모 수정"
                      title="수정"
                      onClick={() => handleEditBookmark(b)}
                    >
                      ✏️
                    </button>
                    <button
                      className="btn-icon note-delete"
                      aria-label="메모 삭제"
                      title="삭제"
                      onClick={() => handleDeleteBookmark(b)}
                    >
                      🗑️
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <div className="emoji">📝</div>
              <p>녹음 중 남긴 메모가 없어요.</p>
            </div>
          ))}
      </div>

      {/* 참석자 편집 팝업 */}
      <ParticipantPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        selected={meeting.participants}
        onChange={handleParticipantsChange}
      />
    </div>
  )
}
