import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { marked } from 'marked'
import { api } from '../api'
import { AudioPlayerCard } from './AudioPlayerCard'
import type { AudioPlayerCardHandle } from './AudioPlayerCard'
import { AvatarStack } from './Avatar'
import { useConfirm } from './confirm'
import { usePrompt } from './prompt'
import { ParticipantPicker } from './ParticipantPicker'
import { StatusBadge } from './StatusBadge'
import { TagPicker } from './TagPicker'
import type { Bookmark, MeetingDetail, MeetingStatus, Participant } from '../types'
import { formatClock, formatKoreanDateTime } from '../utils'
import './MeetingDetailView.css'

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

export interface MeetingDetailViewProps {
  meetingId: number
  /** 있으면 상단에 "← 회의 목록" 버튼 표시 (모달 안에서는 리스트 복귀) */
  onBack?: () => void
  /** 삭제 성공 시 호출 — 없으면 /meetings로 이동 */
  onDeleted?: () => void
  /** 제목/태그/참석자/상태가 바뀌었을 때 호출 (바깥 목록 갱신용) */
  onChanged?: () => void
}

/**
 * 회의 상세 본문 — 헤더/메타/참석자/오디오 플레이어/탭/폴링/편집/재요약/삭제.
 * MeetingDetailPage(라우트)와 최근 회의 "전체 보기" 팝업에서 공용으로 사용한다.
 */
export function MeetingDetailView({ meetingId, onBack, onDeleted, onChanged }: MeetingDetailViewProps) {
  const navigate = useNavigate()
  const confirm = useConfirm()
  const promptInput = usePrompt()

  const [meeting, setMeeting] = useState<MeetingDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tab, setTab] = useState<TabKey>('summary')
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [addingMark, setAddingMark] = useState(false)
  const [noteDraft, setNoteDraft] = useState('')
  const [addingNote, setAddingNote] = useState(false)

  const playerRef = useRef<AudioPlayerCardHandle | null>(null)
  const skipTitleSaveRef = useRef(false)
  const copyTimerRef = useRef<number | null>(null)

  // 콜백은 ref로 들고 있어 폴링 effect 재구독 없이 최신 것을 호출
  const onChangedRef = useRef(onChanged)
  onChangedRef.current = onChanged
  const notifyChanged = () => onChangedRef.current?.()

  // 최초 로드 (meetingId가 바뀌면 상태 초기화 후 재로드 — 모달 안 재사용 대비)
  useEffect(() => {
    setMeeting(null)
    setTab('summary')
    setEditingTitle(false)
    setCopied(false)
    setNoteDraft('')
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
        .then((m) => {
          setMeeting(m)
          // 상태가 넘어가면(변환→요약→완료) 바깥 목록의 배지도 갱신
          if (m.status !== status) onChangedRef.current?.()
        })
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

  // 회의내용(주제별 정리) — 레거시 요약에는 discussion이 없을 수 있음
  const discussionHtml = useMemo(() => {
    const md = meeting?.summary?.discussion
    if (!md) return ''
    return marked.parse(md, { async: false }) as string
  }, [meeting?.summary?.discussion])

  /** 스크립트 세그먼트/메모 시간 칩 클릭 → 플레이어 점프 + 재생 */
  const seekTo = (sec: number) => {
    playerRef.current?.seekTo(sec, true)
  }

  const goBackToList = () => {
    if (onBack) onBack()
    else navigate('/meetings')
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
      notifyChanged()
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
    api
      .updateMeeting(meeting.id, { tag: tag ?? '' })
      .then(() => notifyChanged())
      .catch(() => {
        api.getMeeting(meetingId).then(setMeeting).catch(() => {})
      })
  }

  // ----- 참석자 편집 -----
  const handleParticipantsChange = (ps: Participant[]) => {
    if (!meeting) return
    setMeeting((prev) => (prev ? { ...prev, participants: ps } : prev))
    api
      .updateMeeting(meeting.id, { participant_ids: ps.map((p) => p.id) })
      .then(() => notifyChanged())
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
      notifyChanged()
    } catch (e) {
      alert(e instanceof Error ? e.message : '요약 재생성에 실패했어요')
    }
  }

  // ----- 삭제 (휴지통 이동) -----
  const handleDelete = async () => {
    if (!meeting) return
    const ok = await confirm({
      title: '휴지통으로 이동할까요?',
      message: '휴지통에서 복원하거나 완전 삭제할 수 있어요.',
      confirmLabel: '휴지통으로 이동',
      danger: true,
    })
    if (!ok) return
    try {
      await api.deleteMeeting(meeting.id)
      if (onDeleted) onDeleted()
      else navigate('/meetings')
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

  // ----- 마크 추가 (AudioPlayerCard의 현재 재생 시간) -----
  const handleAddMark = async (timeSec: number) => {
    if (!meeting || addingMark) return
    const markCount = meeting.bookmarks.filter((b) => b.kind === 'mark').length
    setAddingMark(true)
    try {
      const created = await api.addBookmark(meeting.id, {
        time_sec: timeSec,
        title: `마크 ${markCount + 1}`,
        kind: 'mark',
      })
      setMeeting((prev) =>
        prev
          ? {
              ...prev,
              bookmarks: [...prev.bookmarks, created].sort((a, b) => a.time_sec - b.time_sec),
            }
          : prev,
      )
    } catch (e) {
      alert(e instanceof Error ? e.message : '마크 추가에 실패했어요')
    } finally {
      setAddingMark(false)
    }
  }

  // ----- 북마크(메모) 수정/삭제 -----
  const handleEditBookmark = async (b: Bookmark) => {
    const next = await promptInput({
      title: b.kind === 'mark' ? '마크 이름 수정' : '메모 수정',
      initialValue: b.title,
      placeholder: '내용을 입력하세요',
    })
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
    const ok = await confirm({
      title: '이 메모를 삭제할까요?',
      confirmLabel: '삭제',
      danger: true,
    })
    if (!ok) return
    try {
      await api.deleteBookmark(b.id)
      setMeeting((prev) =>
        prev ? { ...prev, bookmarks: prev.bookmarks.filter((x) => x.id !== b.id) } : prev,
      )
    } catch (e) {
      alert(e instanceof Error ? e.message : '메모 삭제에 실패했어요')
    }
  }

  // ----- 일반 메모(note) 추가 — 시간 기록 없음 -----
  const handleAddNote = async () => {
    if (!meeting || addingNote) return
    const title = noteDraft.trim()
    if (!title) return
    setAddingNote(true)
    try {
      const created = await api.addBookmark(meeting.id, { time_sec: 0, title, kind: 'note' })
      setMeeting((prev) => (prev ? { ...prev, bookmarks: [...prev.bookmarks, created] } : prev))
      setNoteDraft('')
    } catch (e) {
      alert(e instanceof Error ? e.message : '메모 추가에 실패했어요')
    } finally {
      setAddingNote(false)
    }
  }

  const onNoteKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter 제출, Shift+Enter 줄바꿈, 한글 IME 조합 중에는 무시
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
    e.preventDefault()
    void handleAddNote()
  }

  // ----- 렌더 -----
  if (loading) {
    return (
      <div className="detail-view">
        <div className="detail-loading">
          <span className="spinner" />
        </div>
      </div>
    )
  }

  if (loadError || !meeting) {
    return (
      <div className="detail-view">
        <div className="card">
          <div className="empty-state">
            <div className="emoji">😕</div>
            <p className="empty-title">{loadError ?? '회의를 찾을 수 없어요.'}</p>
            <button className="btn btn-primary empty-cta" onClick={goBackToList}>
              회의 목록으로
            </button>
          </div>
        </div>
      </div>
    )
  }

  const summary = meeting.summary
  // note는 시간 개념이 없으므로 시간 기반 UI(플레이어 핀/점프)와 분리
  const timedBookmarks = meeting.bookmarks.filter((b) => b.kind !== 'note')
  const noteBookmarks = meeting.bookmarks.filter((b) => b.kind === 'note')
  const progressMessage = PROGRESS_MESSAGE[meeting.status]
  const canResummarize =
    meeting.segments.length > 0 && (meeting.status === 'done' || meeting.status === 'failed')

  return (
    <div className="detail-view">
      {onBack && (
        <button className="detail-back" onClick={onBack}>
          ← 회의 목록
        </button>
      )}

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
              <>
                <span className="muted resummarize-hint">
                  메모와 전체 스크립트를 기준으로 다시 요약합니다
                </span>
                <button className="btn btn-soft" onClick={handleResummarize}>
                  🔄 재요약
                </button>
              </>
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

      {/* 오디오 플레이어 (파형 클릭 시크 + 북마크 핀 + 마크 추가) */}
      {meeting.audio_filename && (
        <AudioPlayerCard
          ref={playerRef}
          src={api.audioUrl(meeting.id)}
          meetingId={meeting.id}
          durationSec={meeting.duration_sec}
          bookmarks={timedBookmarks}
          onAddMark={(timeSec) => void handleAddMark(timeSec)}
        />
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
        {/* AI 요약 — K1 구조: 회의내용 / 핵심내용 / 결정사항(+추가 확인 필요) / 할 일 */}
        {tab === 'summary' &&
          (summary ? (
            <div className="summary-panel">
              {summary.engine_note && (
                <div className="engine-warn-banner">
                  <span>⚠ {summary.engine_note}</span>
                  <button
                    type="button"
                    className="engine-warn-link"
                    onClick={() => navigate('/settings#ai')}
                  >
                    설정 확인 →
                  </button>
                </div>
              )}

              {discussionHtml && (
                <section className="summary-section">
                  <h3 className="section-title">회의내용</h3>
                  <div
                    className="markdown-body discussion-body"
                    dangerouslySetInnerHTML={{ __html: discussionHtml }}
                  />
                </section>
              )}

              <section className="summary-section">
                <h3 className="section-title">핵심내용</h3>
                {summary.key_points.length > 0 ? (
                  <ul className="kp-list">
                    {summary.key_points.map((p, i) => (
                      <li key={i}>{p}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">핵심내용이 없어요.</p>
                )}
              </section>

              <section className="summary-section">
                <h3 className="section-title">결정사항</h3>
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
                  <p className="muted">명확히 확정된 결정사항은 없음</p>
                )}
              </section>

              {(summary.followups ?? []).length > 0 && (
                <section className="summary-section">
                  <h3 className="section-title">추가 확인 필요 사항</h3>
                  <ul className="followup-list">
                    {(summary.followups ?? []).map((f, i) => (
                      <li key={i}>
                        <span className="followup-mark">❓</span>
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

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
        {tab === 'notes' && (
          <div className="notes-panel">
            {meeting.bookmarks.length === 0 && (
              <div className="empty-state">
                <div className="emoji">📝</div>
                <p>녹음 중 남긴 메모가 없어요.</p>
              </div>
            )}

            {/* 시간 메모 · 마크 */}
            {timedBookmarks.length > 0 && (
              <div className="note-list">
                {timedBookmarks.map((b) => (
                  <div key={b.id} className="note-row">
                    <button className="time-chip" onClick={() => seekTo(b.time_sec)}>
                      {formatClock(b.time_sec)}
                    </button>
                    <div className="note-body">
                      <p className="note-title">
                        {b.kind === 'mark' && (
                          <span className="badge badge-blue note-kind-badge">🔖 마크</span>
                        )}
                        {b.title}
                      </p>
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
            )}

            {/* 일반 메모 (시간 기록 없음) */}
            {noteBookmarks.length > 0 && (
              <div className="note-group">
                <h3 className="note-group-title">일반 메모</h3>
                <div className="note-list">
                  {noteBookmarks.map((b) => (
                    <div key={b.id} className="note-row note-plain">
                      <span className="badge badge-gray note-plain-badge">📝 메모</span>
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
              </div>
            )}

            {/* 일반 메모 추가 */}
            <div className="note-add">
              <textarea
                className="input note-add-textarea"
                rows={2}
                placeholder="회의에 대한 메모를 남겨보세요..."
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                onKeyDown={onNoteKeyDown}
                aria-label="일반 메모 입력"
              />
              <button
                type="button"
                className="btn btn-soft note-add-btn"
                onClick={() => void handleAddNote()}
                disabled={!noteDraft.trim() || addingNote}
              >
                메모 추가
              </button>
            </div>
          </div>
        )}
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

export default MeetingDetailView
