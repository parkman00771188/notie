import { useCallback, useEffect, useMemo, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { AvatarStack } from '../components/Avatar'
import { ParticipantPicker } from '../components/ParticipantPicker'
import { RecentMeetingsPanel } from '../components/RecentMeetingsPanel'
import { UploadModal } from '../components/UploadModal'
import { Waveform } from '../components/Waveform'
import { useRecorder } from '../hooks/useRecorder'
import type { Bookmark, Participant } from '../types'
import { formatClock, formatKoreanDateTime } from '../utils'
import './RecordPage.css'

const DEFAULT_TITLE = '새 회의 기록'

function sortByTime(list: Bookmark[]): Bookmark[] {
  return [...list].sort((a, b) => a.time_sec - b.time_sec)
}

export default function RecordPage() {
  const navigate = useNavigate()
  const recorder = useRecorder()

  // ---- 회의 메타 ----
  const [title, setTitle] = useState(DEFAULT_TITLE)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState(DEFAULT_TITLE)
  const [tag, setTag] = useState<string | null>(null)
  const [editingTag, setEditingTag] = useState(false)
  const [tagDraft, setTagDraft] = useState('')
  const [participants, setParticipants] = useState<Participant[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [startedAt] = useState(() => new Date().toISOString())

  // ---- 녹음/북마크 ----
  const [meetingId, setMeetingId] = useState<number | null>(null)
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [memoText, setMemoText] = useState('')
  const [starting, setStarting] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

  // ---- 메모 ⋯ 메뉴 / 인라인 수정 ----
  const [menuOpenId, setMenuOpenId] = useState<number | null>(null)
  const [editingBookmarkId, setEditingBookmarkId] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState('')

  const isLive = recorder.status === 'recording' || recorder.status === 'paused'
  const canMemo = isLive && meetingId != null

  // 녹음/업로드 중 페이지 이탈 경고
  useEffect(() => {
    if (!isLive && !uploading) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isLive, uploading])

  // ⋯ 메뉴 바깥 클릭 시 닫기
  useEffect(() => {
    if (menuOpenId == null) return
    const onDocMouseDown = () => setMenuOpenId(null)
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [menuOpenId])

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

  const beginEditTag = () => {
    setTagDraft(tag ?? '')
    setEditingTag(true)
  }

  const commitTag = () => {
    if (!editingTag) return
    setEditingTag(false)
    const next = tagDraft.trim()
    if ((next || null) === tag) return
    setTag(next || null)
    syncMeeting({ tag: next })
  }

  const onTagKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      commitTag()
    } else if (e.key === 'Escape') {
      setEditingTag(false)
    }
  }

  const handleParticipantsChange = (list: Participant[]) => {
    setParticipants(list)
    if (meetingId != null) {
      syncMeeting({ participant_ids: list.map((p) => p.id) })
    }
  }

  // ---- 녹음 시작/종료 ----
  const handleStart = async () => {
    if (starting || isLive) return
    setStarting(true)
    try {
      await recorder.start()
    } catch {
      alert('마이크를 사용할 수 없어요. 브라우저의 마이크 권한을 확인해주세요.')
      setStarting(false)
      return
    }
    try {
      const meeting = await api.createMeeting({
        title: title.trim() || DEFAULT_TITLE,
        tag: tag ?? undefined,
        participant_ids: participants.map((p) => p.id),
      })
      setMeetingId(meeting.id)
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
      const retry = window.confirm(
        `업로드에 실패했어요: ${(err as Error).message}\n다시 시도할까요?`,
      )
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

  // ---- 북마크(메모/마크) ----
  const handleAddMemo = async () => {
    const text = memoText.trim()
    if (!text || meetingId == null || !canMemo) return
    try {
      const bm = await api.addBookmark(meetingId, {
        time_sec: recorder.elapsedSec,
        title: text,
      })
      setBookmarks((prev) => sortByTime([...prev, bm]))
      setMemoText('')
      setRefreshKey((k) => k + 1)
    } catch (err) {
      alert(`메모를 저장하지 못했어요: ${(err as Error).message}`)
    }
  }

  const onMemoKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
    e.preventDefault()
    void handleAddMemo()
  }

  const handleAddMark = async () => {
    if (meetingId == null || !canMemo) return
    const n = bookmarks.filter((b) => /^마크 \d+$/.test(b.title)).length + 1
    try {
      const bm = await api.addBookmark(meetingId, {
        time_sec: recorder.elapsedSec,
        title: `마크 ${n}`,
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
    () => bookmarks.map((b) => ({ timeSec: b.time_sec, label: formatClock(b.time_sec) })),
    [bookmarks],
  )

  const showRecorder = isLive || uploading

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
            <span className="record-meta-item">📅 {formatKoreanDateTime(startedAt)}</span>
            <span className="record-meta-item">
              ⏱️ 회의 시간 <b>{formatClock(recorder.elapsedSec)}</b>
            </span>
            {editingTag ? (
              <input
                className="input record-tag-input"
                value={tagDraft}
                autoFocus
                placeholder="태그"
                onChange={(e) => setTagDraft(e.target.value)}
                onBlur={commitTag}
                onKeyDown={onTagKeyDown}
                aria-label="태그"
              />
            ) : (
              <button
                type="button"
                className={`record-tag-chip${tag ? ' has-tag' : ''}`}
                onClick={beginEditTag}
              >
                {tag ? `# ${tag}` : '+ 태그 추가'}
              </button>
            )}
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

        {/* ---- 레코더 카드 ---- */}
        <section className="card recorder-card">
          {!showRecorder ? (
            <div className="recorder-idle">
              <div className="recorder-idle-emoji">🎙️</div>
              <p className="recorder-idle-hint">
                녹음을 시작하면 회의가 만들어지고, 메모는 실시간으로 저장돼요.
              </p>
              <button
                type="button"
                className="btn btn-primary btn-lg record-start-btn"
                onClick={() => void handleStart()}
                disabled={starting}
              >
                <span className="record-start-dot" /> 녹음 시작
              </button>
              <button
                type="button"
                className="upload-entry-link"
                onClick={() => setUploadOpen(true)}
                disabled={starting}
              >
                또는 오디오 파일 업로드
              </button>
            </div>
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
        <section className="card memo-card">
          <div className="memo-header">
            <h2 className="memo-title">메모</h2>
            <span className="memo-count">{bookmarks.length}개</span>
          </div>

          <div className="memo-input-row">
            <input
              className="input"
              placeholder="회의 중 메모를 입력하세요..."
              value={memoText}
              onChange={(e) => setMemoText(e.target.value)}
              onKeyDown={onMemoKeyDown}
              disabled={!canMemo}
            />
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void handleAddMemo()}
              disabled={!canMemo || !memoText.trim()}
            >
              + 메모 추가
            </button>
          </div>

          {!canMemo && bookmarks.length === 0 ? (
            <p className="memo-empty">녹음을 시작하면 메모를 남길 수 있어요.</p>
          ) : bookmarks.length === 0 ? (
            <p className="memo-empty">아직 메모가 없어요. Enter로 빠르게 추가해보세요.</p>
          ) : (
            <ul className="memo-list">
              {bookmarks.map((b) => (
                <li key={b.id} className="memo-item">
                  <span className="time-chip">{formatClock(b.time_sec)}</span>
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
                  <div
                    className="memo-item-menu-wrap"
                    onMouseDown={(e) => e.stopPropagation()}
                  >
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
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* ---- 우측 최근 회의 패널 ---- */}
      <aside className="record-side">
        <RecentMeetingsPanel refreshKey={refreshKey} />
      </aside>

      <ParticipantPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        selected={participants}
        onChange={handleParticipantsChange}
      />

      <UploadModal open={uploadOpen} onClose={() => setUploadOpen(false)} />

      {uploading && (
        <div className="upload-overlay">
          <span className="spinner" />
          <p>녹음을 업로드하고 있어요...</p>
        </div>
      )}
    </div>
  )
}
