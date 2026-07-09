import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent, KeyboardEvent, ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { AvatarStack } from '../components/Avatar'
import { useConfirm } from '../components/confirm'
import { ParticipantPicker } from '../components/ParticipantPicker'
import { RecentMeetingsPanel } from '../components/RecentMeetingsPanel'
import { TagPicker } from '../components/TagPicker'
import { Waveform } from '../components/Waveform'
import { useRecorder } from '../hooks/useRecorder'
import type { Bookmark, Participant } from '../types'
import { formatClock, formatKoreanDateTime, isValidDateInput } from '../utils'
import './RecordPage.css'

const DEFAULT_TITLE = '새 회의 기록'
const ACCEPT_AUDIO = 'audio/*,.mp3,.m4a,.wav,.webm,.ogg,.mp4,.aac,.flac'
const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.wav', '.webm', '.ogg', '.mp4', '.aac', '.flac']

function localDateTimeString(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`
}

function startedAtFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get('started_at')
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null

  const dateValue = value.slice(0, 10)
  const hourValue = Number(value.slice(11, 13))
  const minuteValue = Number(value.slice(14, 16))
  if (!isValidDateInput(dateValue) || hourValue < 0 || hourValue > 23 || minuteValue < 0 || minuteValue > 59) {
    return null
  }
  return value
}

function isAudioFile(file: File): boolean {
  if (file.type.startsWith('audio/')) return true
  const lower = file.name.toLowerCase()
  return AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

function readAudioDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const audio = new Audio()
    const done = (sec: number) => {
      URL.revokeObjectURL(url)
      resolve(sec)
    }
    audio.preload = 'metadata'
    audio.onloadedmetadata = () => {
      const duration = audio.duration
      done(Number.isFinite(duration) && duration > 0 ? duration : 0)
    }
    audio.onerror = () => done(0)
    audio.src = url
  })
}

function sortByTime(list: Bookmark[]): Bookmark[] {
  return [...list].sort((a, b) => a.time_sec - b.time_sec)
}

export default function RecordPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const recorder = useRecorder()
  const confirm = useConfirm()

  // ---- 회의 메타 ----
  const [title, setTitle] = useState(DEFAULT_TITLE)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState(DEFAULT_TITLE)
  const [tag, setTag] = useState<string | null>(null)
  const [participants, setParticipants] = useState<Participant[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [startedAt, setStartedAt] = useState(() => startedAtFromSearch(location.search) ?? localDateTimeString())
  const [editingDate, setEditingDate] = useState(false)
  const [dateDraft, setDateDraft] = useState('')
  const [hourDraft, setHourDraft] = useState(9)
  const [minuteDraft, setMinuteDraft] = useState(0)

  // ---- 녹음/북마크 ----
  const [meetingId, setMeetingId] = useState<number | null>(null)
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [memoText, setMemoText] = useState('')
  const [withTime, setWithTime] = useState(true)
  const memoAreaRef = useRef<HTMLTextAreaElement>(null)
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const [recordMode, setRecordMode] = useState<'idle' | 'manual'>('idle')
  const [manualText, setManualText] = useState('')
  const [manualSubmitting, setManualSubmitting] = useState(false)
  const [uploadDragActive, setUploadDragActive] = useState(false)
  const [starting, setStarting] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

  // ---- 메모 ⋯ 메뉴 / 인라인 수정 ----
  const [menuOpenId, setMenuOpenId] = useState<number | null>(null)
  const [editingBookmarkId, setEditingBookmarkId] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState('')

  const isLive = recorder.status === 'recording' || recorder.status === 'paused'
  const canMemo = isLive && meetingId != null
  const processing = uploading || manualSubmitting

  // 녹음/업로드 중 페이지 이탈 경고
  useEffect(() => {
    if (!isLive && !processing) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isLive, processing])

  // ⋯ 메뉴 바깥 클릭 시 닫기
  useEffect(() => {
    if (menuOpenId == null) return
    const onDocMouseDown = () => setMenuOpenId(null)
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [menuOpenId])

  // 메모 textarea 자동 높이 (기본 2줄 ~ 최대 5줄, 초과 시 스크롤 — max-height는 CSS)
  useEffect(() => {
    const el = memoAreaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [memoText])

  // ---- 회의 메타 편집 ----
  const syncMeeting = useCallback(
    (patch: { title?: string; tag?: string; participant_ids?: number[] }) => {
      if (meetingId == null) return
      void api.updateMeeting(meetingId, patch).catch(() => {
        /* 메타 동기화 실패는 치명적이지 않으므로 무시 */
      })
    },
    [meetingId],
  )

  const beginEditTitle = () => {
    setTitleDraft(title)
    setEditingTitle(true)
  }

  const commitTitle = () => {
    if (!editingTitle) return
    setEditingTitle(false)
    const next = titleDraft.trim() || DEFAULT_TITLE
    if (next === title) return
    setTitle(next)
    syncMeeting({ title: next })
  }

  const onTitleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      commitTitle()
    } else if (e.key === 'Escape') {
      setEditingTitle(false)
    }
  }

  const handleTagChange = (next: string | null) => {
    if (next === tag) return
    setTag(next)
    // 태그 제거(null)는 API 계약대로 빈 문자열로 전송
    syncMeeting({ tag: next ?? '' })
  }

  const handleParticipantsChange = (list: Participant[]) => {
    setParticipants(list)
    if (meetingId != null) {
      syncMeeting({ participant_ids: list.map((p) => p.id) })
    }
  }

  const beginEditDate = () => {
    const iso = startedAt || new Date().toISOString()
    setDateDraft(iso.slice(0, 10))
    setHourDraft(Number(iso.slice(11, 13)) || 0)
    setMinuteDraft(Number(iso.slice(14, 16)) || 0)
    setEditingDate(true)
  }

  const commitDate = async () => {
    const dateValue = dateDraft.trim()
    if (!dateValue) return
    if (!isValidDateInput(dateValue)) {
      alert('날짜는 2026-07-08 형식으로 입력해주세요.')
      return
    }
    setEditingDate(false)
    const next = `${dateValue}T${String(hourDraft).padStart(2, '0')}:${String(minuteDraft).padStart(2, '0')}`
    if (next === startedAt.slice(0, 16)) return
    setStartedAt(next)
    if (meetingId == null) return
    try {
      const updated = await api.updateMeeting(meetingId, { started_at: next })
      setStartedAt(updated.started_at)
      setRefreshKey((k) => k + 1)
    } catch (err) {
      alert(err instanceof Error ? err.message : '날짜 변경에 실패했어요')
    }
  }

  // ---- 녹음 시작/종료 ----
  const createMeetingFromCurrentMeta = async () =>
    api.createMeeting({
      title: title.trim() || DEFAULT_TITLE,
      tag: tag ?? undefined,
      started_at: startedAt,
      participant_ids: participants.map((p) => p.id),
    })

  const handleStart = async () => {
    if (starting || isLive) return
    setRecordMode('idle')
    setStarting(true)
    try {
      await recorder.start()
    } catch {
      alert('마이크를 사용할 수 없어요. 브라우저의 마이크 권한을 확인해주세요.')
      setStarting(false)
      return
    }
    try {
      const meeting = await createMeetingFromCurrentMeta()
      setMeetingId(meeting.id)
      setStartedAt(meeting.started_at)
      setBookmarks([])
      setRefreshKey((k) => k + 1)
    } catch (err) {
      alert(`회의를 생성하지 못했어요: ${(err as Error).message}`)
      void recorder.stop().catch(() => {})
    } finally {
      setStarting(false)
    }
  }

  const uploadAndGo = async (blob: Blob, durationSec: number): Promise<void> => {
    if (meetingId == null) return
    try {
      await api.uploadAudio(meetingId, blob, durationSec)
      navigate(`/meetings/${meetingId}`)
    } catch (err) {
      const retry = await confirm({
        title: '업로드에 실패했어요',
        message: `${(err as Error).message}\n다시 시도할까요?`,
        confirmLabel: '다시 시도',
      })
      if (retry) return uploadAndGo(blob, durationSec)
      setUploading(false)
      navigate(`/meetings/${meetingId}`)
    }
  }

  const handleStop = async () => {
    if (meetingId == null || uploading) return
    setUploading(true)
    let result: { blob: Blob; durationSec: number }
    try {
      result = await recorder.stop()
    } catch (err) {
      setUploading(false)
      alert(`녹음을 종료하지 못했어요: ${(err as Error).message}`)
      return
    }
    await uploadAndGo(result.blob, result.durationSec)
  }

  const handleUploadFile = async (file: File) => {
    if (starting || uploading || manualSubmitting) return
    if (!isAudioFile(file)) {
      alert('오디오 파일만 업로드할 수 있어요. (mp3, m4a, wav, webm, ogg, mp4, aac, flac)')
      return
    }
    setUploading(true)
    let createdMeetingId: number | null = null
    try {
      const durationSec = await readAudioDuration(file)
      const meeting = await createMeetingFromCurrentMeta()
      createdMeetingId = meeting.id
      setMeetingId(meeting.id)
      setStartedAt(meeting.started_at)
      setRefreshKey((k) => k + 1)
      await api.uploadAudio(meeting.id, file, durationSec)
      navigate(`/meetings/${meeting.id}`)
    } catch (err) {
      if (createdMeetingId != null) void api.deleteMeeting(createdMeetingId).catch(() => {})
      alert(err instanceof Error ? err.message : '오디오 파일 업로드에 실패했어요')
      setUploading(false)
    }
  }

  const handleUploadInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) void handleUploadFile(file)
    e.target.value = ''
  }

  const handleUploadDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    if (!uploadDragActive) setUploadDragActive(true)
  }

  const handleUploadDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setUploadDragActive(false)
    }
  }

  const handleUploadDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setUploadDragActive(false)
    const file = e.dataTransfer.files?.[0]
    if (file) void handleUploadFile(file)
  }

  const handleUploadZoneClick = () => {
    if (starting || uploading) return
    uploadInputRef.current?.click()
  }

  const handleUploadZoneKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    handleUploadZoneClick()
  }

  const handleManualSubmit = async () => {
    const text = manualText.trim()
    if (!text || starting || uploading || manualSubmitting) return
    setManualSubmitting(true)
    let createdMeetingId: number | null = null
    try {
      const meeting = await createMeetingFromCurrentMeta()
      createdMeetingId = meeting.id
      setMeetingId(meeting.id)
      setStartedAt(meeting.started_at)
      await api.submitManualTranscript(meeting.id, { text, duration_sec: 0 })
      setRefreshKey((k) => k + 1)
      navigate(`/meetings/${meeting.id}`)
    } catch (err) {
      if (createdMeetingId != null) void api.deleteMeeting(createdMeetingId).catch(() => {})
      alert(err instanceof Error ? err.message : '직접 작성한 회의 내용을 요약하지 못했어요')
      setManualSubmitting(false)
    }
  }

  // ---- 북마크(메모/마크) ----
  const handleAddMemo = async () => {
    const text = memoText.trim()
    if (!text || meetingId == null || !canMemo) return
    try {
      const bm = await api.addBookmark(
        meetingId,
        withTime
          ? { time_sec: recorder.elapsedSec, title: text, kind: 'memo' }
          : { time_sec: 0, title: text, kind: 'note' },
      )
      setBookmarks((prev) => sortByTime([...prev, bm]))
      setMemoText('')
      setRefreshKey((k) => k + 1)
    } catch (err) {
      alert(`메모를 저장하지 못했어요: ${(err as Error).message}`)
    }
  }

  // Enter 제출 / Shift+Enter 줄바꿈 (IME 조합 중에는 무시)
  const onMemoKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
    e.preventDefault()
    void handleAddMemo()
  }

  const handleAddMark = async () => {
    if (meetingId == null || !canMemo) return
    const n = bookmarks.filter((b) => b.kind === 'mark').length + 1
    try {
      const bm = await api.addBookmark(meetingId, {
        time_sec: recorder.elapsedSec,
        title: `마크 ${n}`,
        kind: 'mark',
      })
      setBookmarks((prev) => sortByTime([...prev, bm]))
      setRefreshKey((k) => k + 1)
    } catch (err) {
      alert(`마크를 저장하지 못했어요: ${(err as Error).message}`)
    }
  }

  const beginEditBookmark = (b: Bookmark) => {
    setMenuOpenId(null)
    setEditDraft(b.title)
    setEditingBookmarkId(b.id)
  }

  const commitBookmarkEdit = async () => {
    const id = editingBookmarkId
    if (id == null) return
    setEditingBookmarkId(null)
    const text = editDraft.trim()
    const original = bookmarks.find((b) => b.id === id)
    if (!original || !text || text === original.title) return
    try {
      const updated = await api.updateBookmark(id, { title: text })
      setBookmarks((prev) => sortByTime(prev.map((b) => (b.id === id ? updated : b))))
    } catch (err) {
      alert(`메모를 수정하지 못했어요: ${(err as Error).message}`)
    }
  }

  const onEditKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void commitBookmarkEdit()
    } else if (e.key === 'Escape') {
      setEditingBookmarkId(null)
    }
  }

  const handleDeleteBookmark = async (id: number) => {
    setMenuOpenId(null)
    try {
      await api.deleteBookmark(id)
      setBookmarks((prev) => prev.filter((b) => b.id !== id))
    } catch (err) {
      alert(`메모를 삭제하지 못했어요: ${(err as Error).message}`)
    }
  }

  const waveMarks = useMemo(
    () =>
      bookmarks
        .filter((b) => b.kind !== 'note')
        .map((b) => ({ timeSec: b.time_sec, label: formatClock(b.time_sec) })),
    [bookmarks],
  )

  // 시간 메모/마크 그룹 + 일반 메모(note) 그룹 분리
  const timedBookmarks = useMemo(() => bookmarks.filter((b) => b.kind !== 'note'), [bookmarks])
  const noteBookmarks = useMemo(() => bookmarks.filter((b) => b.kind === 'note'), [bookmarks])

  const showRecorder = isLive || (uploading && recorder.status !== 'idle')

  // 메모/마크/일반 메모 공통 행 렌더 (수정/삭제 UX 동일)
  const renderBookmarkItem = (b: Bookmark): ReactNode => (
    <li key={b.id} className="memo-item">
      {b.kind === 'note' ? (
        <span className="badge badge-gray memo-note-badge">📝 메모</span>
      ) : (
        <span className="time-chip">{formatClock(b.time_sec)}</span>
      )}
      {b.kind === 'mark' && <span className="badge badge-blue memo-mark-badge">🔖 마크</span>}
      {editingBookmarkId === b.id ? (
        <input
          className="input memo-edit-input"
          value={editDraft}
          autoFocus
          onChange={(e) => setEditDraft(e.target.value)}
          onBlur={() => void commitBookmarkEdit()}
          onKeyDown={onEditKeyDown}
          aria-label="메모 수정"
        />
      ) : (
        <span className="memo-item-title">{b.title}</span>
      )}
      <div className="memo-item-menu-wrap" onMouseDown={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="btn-icon memo-menu-btn"
          aria-label="메모 메뉴"
          onClick={() => setMenuOpenId(menuOpenId === b.id ? null : b.id)}
        >
          ⋯
        </button>
        {menuOpenId === b.id && (
          <div className="memo-menu">
            <button type="button" onClick={() => beginEditBookmark(b)}>
              ✏️ 수정
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => void handleDeleteBookmark(b.id)}
            >
              🗑️ 삭제
            </button>
          </div>
        )}
      </div>
    </li>
  )

  return (
    <div className="record-page">
      <div className="record-main">
        {/* ---- 헤더: 제목 / 메타 / 참석자 ---- */}
        <header className="record-header">
          <div className="record-title-row">
            {editingTitle ? (
              <input
                className="input record-title-input"
                value={titleDraft}
                autoFocus
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={commitTitle}
                onKeyDown={onTitleKeyDown}
                aria-label="회의 제목"
              />
            ) : (
              <>
                <h1 className="record-title" onClick={beginEditTitle}>
                  {title}
                </h1>
                <button
                  type="button"
                  className="btn-icon"
                  aria-label="제목 수정"
                  onClick={beginEditTitle}
                >
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                  </svg>
                </button>
              </>
            )}
          </div>

          <div className="record-meta">
            {editingDate ? (
              <span className="record-date-edit">
                <input
                  type="text"
                  className="input record-date-input"
                  value={dateDraft}
                  inputMode="numeric"
                  placeholder="YYYY-MM-DD"
                  pattern="[0-9]{4}-[0-9]{2}-[0-9]{2}"
                  maxLength={10}
                  onChange={(e) => setDateDraft(e.target.value)}
                  autoFocus
                />
                <select
                  className="input record-time-select"
                  aria-label="시"
                  value={hourDraft}
                  onChange={(e) => setHourDraft(Number(e.target.value))}
                >
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>
                      {h}시
                    </option>
                  ))}
                </select>
                <select
                  className="input record-time-select"
                  aria-label="분"
                  value={minuteDraft}
                  onChange={(e) => setMinuteDraft(Number(e.target.value))}
                >
                  {Array.from({ length: 12 }, (_, i) => i * 5).map((m) => (
                    <option key={m} value={m}>
                      {String(m).padStart(2, '0')}분
                    </option>
                  ))}
                </select>
                <button type="button" className="btn btn-primary record-date-save" onClick={() => void commitDate()}>
                  저장
                </button>
                <button type="button" className="btn btn-ghost record-date-save" onClick={() => setEditingDate(false)}>
                  취소
                </button>
              </span>
            ) : (
              <button type="button" className="record-meta-item record-date-btn" onClick={beginEditDate}>
                📅 {formatKoreanDateTime(startedAt)} ✎
              </button>
            )}
            <span className="record-meta-item">
              ⏱️ 회의 시간 <b>{formatClock(recorder.elapsedSec)}</b>
            </span>
            <TagPicker value={tag} onChange={handleTagChange} />
          </div>

          <div className="record-participants">
            <AvatarStack participants={participants} />
            <span className="record-participants-count">참석자 {participants.length}명</span>
            <button
              type="button"
              className="btn btn-soft record-add-btn"
              onClick={() => setPickerOpen(true)}
            >
              + 추가
            </button>
          </div>
        </header>

        <div className="record-content-row">
          <div className="record-content-main">
            {/* ---- 레코더 카드 ---- */}
            <section className="card recorder-card">
              {!showRecorder ? (
                recordMode === 'manual' ? (
                  <div className="manual-writing-panel">
                    <div className="manual-writing-head">
                      <span className="manual-writing-icon" aria-hidden="true">
                        📝
                      </span>
                      <div>
                        <h2>회의 내용 입력</h2>
                        <p>녹음 없이 회의 내용을 직접 작성하면 바로 AI 요약을 시작할 수 있어요.</p>
                      </div>
                    </div>
                    <textarea
                      className="input manual-writing-textarea"
                      value={manualText}
                      onChange={(e) => setManualText(e.target.value)}
                      placeholder={'여기에 회의 내용을 직접 작성하세요.\n결정사항, 할 일, 논의 내용을 자유롭게 적어도 됩니다.'}
                      spellCheck={false}
                      autoFocus
                    />
                    <div className="manual-writing-actions">
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => {
                          setRecordMode('idle')
                          setManualText('')
                        }}
                        disabled={manualSubmitting}
                      >
                        돌아가기
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => void handleManualSubmit()}
                        disabled={!manualText.trim() || manualSubmitting}
                      >
                        {manualSubmitting ? '요약 시작 중...' : 'AI 요약 시작'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="recorder-idle">
                    <div className="record-start-options">
                      <article className="record-start-option record-start-option-audio">
                        <div className="record-start-option-icon" aria-hidden="true">
                          🎙️
                        </div>
                        <h2>녹음으로 회의 시작</h2>
                        <p>실시간 녹음과 메모를 함께 기록합니다.</p>
                        <button
                          type="button"
                          className="btn btn-primary btn-lg record-start-btn"
                          onClick={() => void handleStart()}
                          disabled={starting}
                        >
                          <span className="record-start-dot" /> 녹음 시작
                        </button>
                      </article>

                      <article className="record-start-option record-start-option-manual">
                        <div className="record-start-option-icon manual" aria-hidden="true">
                          📝
                        </div>
                        <h2>직접 작성으로 시작</h2>
                        <p>녹음 없이 회의 내용만 직접 작성합니다.</p>
                        <button
                          type="button"
                          className="btn btn-lg manual-start-btn"
                          onClick={() => setRecordMode('manual')}
                          disabled={starting}
                        >
                          바로 작성하기
                        </button>
                      </article>
                    </div>

                    <div
                      className={`record-upload-strip${uploadDragActive ? ' drag-over' : ''}`}
                      role="button"
                      tabIndex={starting || uploading ? -1 : 0}
                      aria-label="오디오 파일 업로드"
                      aria-disabled={starting || uploading}
                      onClick={handleUploadZoneClick}
                      onKeyDown={handleUploadZoneKeyDown}
                      onDragOver={handleUploadDragOver}
                      onDragLeave={handleUploadDragLeave}
                      onDrop={handleUploadDrop}
                    >
                      <div className="record-upload-copy">
                        <div className="record-upload-title-row">
                          <span className="record-upload-mini-icon" aria-hidden="true">
                            ☁
                          </span>
                          <span className="record-upload-text">오디오 파일 업로드</span>
                        </div>
                        <span className="record-upload-hint">
                          파일을 끌어오거나 클릭하여 업로드하세요
                        </span>
                      </div>
                      <input
                        ref={uploadInputRef}
                        type="file"
                        className="record-upload-input"
                        accept={ACCEPT_AUDIO}
                        onClick={(e) => e.stopPropagation()}
                        onChange={handleUploadInputChange}
                        aria-hidden="true"
                        tabIndex={-1}
                      />
                    </div>
                  </div>
                )
              ) : (
                <>
                  <div
                    className={`recorder-status${recorder.status === 'paused' ? ' paused' : ''}`}
                  >
                    <span
                      className={`rec-dot${recorder.status === 'paused' ? ' paused' : ''}`}
                    />
                    {recorder.status === 'paused' ? '일시정지됨' : '녹음 중'}
                  </div>

                  <div className="recorder-timer">{formatClock(recorder.elapsedSec)}</div>

                  <Waveform
                    analyser={recorder.analyser}
                    active={recorder.status === 'recording'}
                    marks={waveMarks}
                    elapsedSec={recorder.elapsedSec}
                  />

                  <div className="recorder-controls">
                    {recorder.status === 'paused' ? (
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={recorder.resume}
                      >
                        ▶ 재개
                      </button>
                    ) : (
                      <button type="button" className="btn btn-ghost" onClick={recorder.pause}>
                        ⏸ 일시정지
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn record-stop-btn"
                      onClick={() => void handleStop()}
                      disabled={uploading}
                    >
                      ■ 종료
                    </button>
                    <button
                      type="button"
                      className="btn btn-soft"
                      onClick={() => void handleAddMark()}
                      disabled={!canMemo}
                    >
                      🔖 마크 추가
                    </button>
                  </div>
                </>
              )}
            </section>

            {/* ---- 메모 카드 ---- */}
            {recordMode !== 'manual' && (
            <section className="card memo-card">
              <div className="memo-header">
                <h2 className="memo-title">메모</h2>
                <span className="memo-count">{bookmarks.length}개</span>
              </div>

              <div className="memo-input-area">
                <textarea
                  ref={memoAreaRef}
                  className="input memo-textarea"
                  placeholder="회의 중 메모를 입력하세요... (Enter 제출, Shift+Enter 줄바꿈)"
                  rows={2}
                  value={memoText}
                  onChange={(e) => setMemoText(e.target.value)}
                  onKeyDown={onMemoKeyDown}
                  disabled={!canMemo}
                />
                <div className="memo-input-footer">
                  <label className="memo-time-toggle">
                    <input
                      type="checkbox"
                      checked={withTime}
                      onChange={(e) => setWithTime(e.target.checked)}
                      disabled={!canMemo}
                    />
                    ⏱ 시간 기록
                  </label>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void handleAddMemo()}
                    disabled={!canMemo || !memoText.trim()}
                  >
                    + 메모 추가
                  </button>
                </div>
              </div>

              {!canMemo && bookmarks.length === 0 ? (
                <p className="memo-empty">녹음을 시작하면 메모를 남길 수 있어요.</p>
              ) : bookmarks.length === 0 ? (
                <p className="memo-empty">아직 메모가 없어요. Enter로 빠르게 추가해보세요.</p>
              ) : (
                <>
                  {timedBookmarks.length > 0 && (
                    <ul className="memo-list">{timedBookmarks.map(renderBookmarkItem)}</ul>
                  )}
                  {noteBookmarks.length > 0 && (
                    <div className="memo-note-group">
                      <h3 className="memo-group-title">일반 메모</h3>
                      <ul className="memo-list">{noteBookmarks.map(renderBookmarkItem)}</ul>
                    </div>
                  )}
                </>
              )}
            </section>
            )}
          </div>

          {/* ---- 우측 최근 회의 패널 ---- */}
          <aside className="record-side">
            <RecentMeetingsPanel refreshKey={refreshKey} recordingActive={isLive || uploading} />
          </aside>
        </div>
      </div>

      <ParticipantPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        selected={participants}
        onChange={handleParticipantsChange}
      />

      {processing && (
        <div className="upload-overlay">
          <span className="spinner" />
          <p>
            {manualSubmitting
              ? '작성한 회의 내용으로 AI 요약을 시작하고 있어요...'
              : '음성 파일을 업로드하고 분석을 시작하고 있어요...'}
          </p>
        </div>
      )}
    </div>
  )
}
