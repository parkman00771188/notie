import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { marked } from 'marked'
import { api } from '../api'
import { useAuth } from '../App'
import { AudioPlayerCard } from './AudioPlayerCard'
import type { AudioPlayerCardHandle } from './AudioPlayerCard'
import { AvatarStack } from './Avatar'
import { useConfirm } from './confirm'
import { usePrompt } from './prompt'
import { ParticipantPicker } from './ParticipantPicker'
import { StatusBadge } from './StatusBadge'
import { TagPicker } from './TagPicker'
import type { Bookmark, MeetingDetail, MeetingStatus, Participant, Tag, TranscriptSegment } from '../types'
import { formatClock, formatKoreanDateTime, isValidDateInput } from '../utils'
import './MeetingDetailView.css'

type TabKey = 'minutes' | 'transcript' | 'notes'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'minutes', label: 'AI 회의록' },
  { key: 'transcript', label: '전체 스크립트' },
  { key: 'notes', label: '메모' },
]

const PROGRESS_MESSAGE: Partial<Record<MeetingStatus, string>> = {
  queued: '대기 중이에요...',
  transcribing: '음성을 텍스트로 변환하고 있어요...',
  summarizing: 'AI가 회의록을 만들고 있어요...',
}

function estimateProcessingTime(durationSec: number | null | undefined): string {
  if (!durationSec || durationSec <= 0) return '약 1~3분'
  const min = Math.max(1, Math.ceil(durationSec / 600))
  const max = Math.max(min + 1, Math.ceil(durationSec / 300))
  return `약 ${min}~${max}분`
}

function isTemporaryAudioFailure(meeting: MeetingDetail): boolean {
  return meeting.status === 'failed' && Boolean(meeting.audio_filename) && meeting.segments.length === 0
}

export interface MeetingDetailViewProps {
  meetingId: number
  /** 있으면 상단에 "← 회의 목록" 버튼 표시 (모달 안에서는 리스트 복귀) */
  onBack?: () => void
  /** 삭제 성공 시 호출 — 없으면 /meetings로 이동 */
  onDeleted?: () => void
  /** 제목/태그/참석자/상태가 바뀌었을 때 호출 (바깥 목록 갱신용) */
  onChanged?: () => void
  /** 녹음 화면 안 팝업처럼 음원 재생을 강제로 막아야 하는 컨텍스트 */
  audioPlaybackDisabled?: boolean
}

/**
 * 회의 상세 본문 — 헤더/메타/참석자/오디오 플레이어/탭/폴링/편집/재요약/삭제.
 * MeetingDetailPage(라우트)와 최근 회의 "전체 보기" 팝업에서 공용으로 사용한다.
 */
export function MeetingDetailView({
  meetingId,
  onBack,
  onDeleted,
  onChanged,
  audioPlaybackDisabled = false,
}: MeetingDetailViewProps) {
  const navigate = useNavigate()
  const confirm = useConfirm()
  const promptInput = usePrompt()
  const { user } = useAuth()

  const [meeting, setMeeting] = useState<MeetingDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tab, setTab] = useState<TabKey>('minutes')
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [addingMark, setAddingMark] = useState(false)
  const [noteDraft, setNoteDraft] = useState('')
  const [addingNote, setAddingNote] = useState(false)
  const [tags, setTags] = useState<Tag[]>([])
  const [editingDate, setEditingDate] = useState(false)
  const [dateDraft, setDateDraft] = useState('') // YYYY-MM-DD
  const [hourDraft, setHourDraft] = useState(9)
  const [minuteDraft, setMinuteDraft] = useState(0)
  const [editingSegmentId, setEditingSegmentId] = useState<number | null>(null)
  const [segmentDraft, setSegmentDraft] = useState('')
  const [savingSegmentId, setSavingSegmentId] = useState<number | null>(null)
  const [cancellingProcessing, setCancellingProcessing] = useState(false)

  // AI 회의록 내용 직접 편집 (리스트는 "한 줄에 하나" 텍스트로 편집)
  const [editingSummary, setEditingSummary] = useState(false)
  const [savingSummary, setSavingSummary] = useState(false)
  const [sumDraft, setSumDraft] = useState({
    discussion: '',
    key_points: '',
    decisions: '',
    followups: '',
    action_items: '',
  })

  // 회의록 헤더의 태그 칩 색 매칭용 (실패해도 기본색으로 표시)
  useEffect(() => {
    api
      .listTags()
      .then(setTags)
      .catch(() => {})
  }, [])

  const playerRef = useRef<AudioPlayerCardHandle | null>(null)
  const skipTitleSaveRef = useRef(false)

  // 콜백은 ref로 들고 있어 폴링 effect 재구독 없이 최신 것을 호출
  const onChangedRef = useRef(onChanged)
  onChangedRef.current = onChanged
  const notifyChanged = () => onChangedRef.current?.()

  // 최초 로드 (meetingId가 바뀌면 상태 초기화 후 재로드 — 모달 안 재사용 대비)
  useEffect(() => {
    setMeeting(null)
    setTab('minutes')
    setEditingTitle(false)
    setEditingSegmentId(null)
    setSegmentDraft('')
    setSavingSegmentId(null)
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

  // 처리 중인 상태만 3초 폴링
  const status = meeting?.status
  useEffect(() => {
    if (!status || status === 'scheduled' || status === 'done' || status === 'failed') return
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

  // 참석자 소속별 그룹 (회의록 탭 표시용) — 라이브 데이터라 참석자 편집 즉시 반영.
  // 소속·이름 모두 가나다순 정렬, 소속 미지정은 마지막.
  const peopleGroups = useMemo(() => {
    const grouped = new Map<string, Participant[]>()
    const loose: Participant[] = []
    for (const p of meeting?.participants ?? []) {
      const org = (p.organization ?? '').trim()
      if (org) {
        const arr = grouped.get(org)
        if (arr) arr.push(p)
        else grouped.set(org, [p])
      } else {
        loose.push(p)
      }
    }
    const byName = (a: Participant, b: Participant) => a.name.localeCompare(b.name, 'ko')
    const groups = [...grouped.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], 'ko'))
      .map(([org, people]) => ({ org, people: [...people].sort(byName) }))
    if (loose.length > 0) {
      groups.push({ org: groups.length > 0 ? '소속 미지정' : '', people: [...loose].sort(byName) })
    }
    return groups
  }, [meeting?.participants])

  const personLine = (p: Participant) => {
    const extras = [p.department, p.role].filter((v): v is string => Boolean(v && v.trim()))
    return extras.length > 0 ? `${p.name} (${extras.join(' · ')})` : p.name
  }

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

  const beginEditSegment = (seg: TranscriptSegment) => {
    setEditingSegmentId(seg.id)
    setSegmentDraft(seg.text)
  }

  const cancelSegmentEdit = () => {
    setEditingSegmentId(null)
    setSegmentDraft('')
  }

  const commitSegment = async (seg: TranscriptSegment) => {
    if (!meeting || savingSegmentId) return
    const text = segmentDraft.trim()
    if (!text) {
      alert('스크립트 내용을 입력해주세요')
      return
    }
    if (text === seg.text) {
      cancelSegmentEdit()
      return
    }

    setSavingSegmentId(seg.id)
    try {
      const updated = await api.updateTranscriptSegment(meeting.id, seg.id, { text })
      setMeeting((prev) =>
        prev
          ? {
              ...prev,
              segments: prev.segments.map((item) => (item.id === seg.id ? updated : item)),
            }
          : prev,
      )
      cancelSegmentEdit()
    } catch (e) {
      alert(e instanceof Error ? e.message : '스크립트 수정에 실패했어요')
    } finally {
      setSavingSegmentId(null)
    }
  }

  const onSegmentEditorKeyDown = (
    e: KeyboardEvent<HTMLTextAreaElement>,
    seg: TranscriptSegment,
  ) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Escape') {
      e.preventDefault()
      cancelSegmentEdit()
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void commitSegment(seg)
    }
  }

  /** 날짜 편집 시작 — 기존 일시를 날짜/시(24h)/분으로 분해 */
  const beginEditDate = () => {
    if (!meeting) return
    const iso = meeting.started_at || ''
    setDateDraft(iso.slice(0, 10))
    setHourDraft(Number(iso.slice(11, 13)) || 0)
    setMinuteDraft(Number(iso.slice(14, 16)) || 0)
    setEditingDate(true)
  }

  /** 회의 날짜/시간 변경 (날짜 + 24시간제 시/분 → ISO) */
  const commitDate = async () => {
    if (!meeting) return
    const dateValue = dateDraft.trim()
    if (!dateValue) return
    if (!isValidDateInput(dateValue)) {
      alert('날짜는 2026-07-08 형식으로 입력해주세요.')
      return
    }
    setEditingDate(false)
    const value = `${dateValue}T${String(hourDraft).padStart(2, '0')}:${String(minuteDraft).padStart(2, '0')}`
    if (value === (meeting.started_at || '').slice(0, 16)) return
    try {
      const updated = await api.updateMeeting(meeting.id, { started_at: value })
      setMeeting((prev) => (prev ? { ...prev, started_at: updated.started_at } : prev))
      notifyChanged()
    } catch (e) {
      alert(e instanceof Error ? e.message : '날짜 변경에 실패했어요')
    }
  }

  /** 요약 편집 시작 — 리스트는 줄바꿈으로 펼쳐서 textarea에 채운다 */
  const beginEditSummary = () => {
    const s = meeting?.summary
    if (!s) return
    if (meeting.locked) {
      alert('잠긴 회의는 AI 회의록을 수정할 수 없어요. 잠금을 해제한 뒤 다시 시도해주세요.')
      return
    }
    setSumDraft({
      discussion: s.discussion ?? '',
      key_points: (s.key_points ?? []).join('\n'),
      decisions: (s.decisions ?? []).join('\n'),
      followups: (s.followups ?? []).join('\n'),
      action_items: (s.action_items ?? []).map((a) => a.text).join('\n'),
    })
    setEditingSummary(true)
  }

  const commitSummary = async () => {
    if (!meeting || savingSummary) return
    if (meeting.locked) {
      alert('잠긴 회의는 AI 회의록을 수정할 수 없어요. 잠금을 해제한 뒤 다시 시도해주세요.')
      setEditingSummary(false)
      return
    }
    setSavingSummary(true)
    const toLines = (v: string) =>
      v.split('\n').map((x) => x.trim()).filter(Boolean)
    try {
      const updated = await api.updateSummary(meeting.id, {
        discussion: sumDraft.discussion.trim(),
        key_points: toLines(sumDraft.key_points),
        decisions: toLines(sumDraft.decisions),
        followups: toLines(sumDraft.followups),
        action_items: toLines(sumDraft.action_items).map((text) => ({ text })),
      })
      setMeeting((prev) => (prev ? { ...prev, summary: updated } : prev))
      setEditingSummary(false)
      notifyChanged()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'AI 회의록 수정에 실패했어요')
    } finally {
      setSavingSummary(false)
    }
  }

  const filenameFromDisposition = (header: string | null, fallback: string): string => {
    if (!header) return fallback
    const utf8 = header.match(/filename\*=UTF-8''([^;]+)/i)
    if (utf8?.[1]) {
      try {
        return decodeURIComponent(utf8[1])
      } catch {
        return fallback
      }
    }
    const plain = header.match(/filename="?([^";]+)"?/i)
    return plain?.[1] || fallback
  }

  const fetchExportBlob = async (format: 'docx' | 'pdf') => {
    if (!meeting) return
    const res = await fetch(api.exportUrl(meeting.id, format))
    if (!res.ok) {
      let message = `내보내기에 실패했어요 (${res.status})`
      try {
        const data = await res.json()
        if (typeof data.detail === 'string') message = data.detail
      } catch {
        const text = await res.text().catch(() => '')
        if (text.trim()) message = text.trim()
      }
      throw new Error(message)
    }

    const blob = await res.blob()
    const filename = filenameFromDisposition(
      res.headers.get('Content-Disposition'),
      `[회의록] ${meeting.title}.${format}`,
    )
    return { blob, filename }
  }

  const saveBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  /** 회의록 문서 다운로드 (브라우저 다운로드 폴더) */
  const downloadExport = async (format: 'docx' | 'pdf') => {
    if (!meeting) return
    try {
      const result = await fetchExportBlob(format)
      if (!result) return
      saveBlob(result.blob, result.filename)
    } catch (e) {
      alert(e instanceof Error ? e.message : '내보내기에 실패했어요')
    }
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

  // ----- AI 회의록 다시 생성 / 재시도 -----
  const handleResummarize = async () => {
    if (!meeting) return
    if (meeting.locked) {
      alert('잠긴 회의는 AI 회의록을 다시 생성할 수 없어요. 잠금을 해제한 뒤 다시 시도해주세요.')
      return
    }
    const retryFromAudio = isTemporaryAudioFailure(meeting)
    try {
      if (retryFromAudio) {
        await api.retryAudioProcessing(meeting.id)
      } else {
        await api.resummarize(meeting.id)
      }
      // 상태를 즉시 바꿔 폴링 재개
      setMeeting((prev) =>
        prev
          ? {
              ...prev,
              status: retryFromAudio ? 'queued' : 'summarizing',
              error_message: null,
              ...(retryFromAudio ? { segments: [], summary: null } : {}),
            }
          : prev,
      )
      setTab('minutes')
      notifyChanged()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'AI 회의록 처리에 실패했어요')
    }
  }

  const handleResummarizeWithConfirm = async () => {
    if (!meeting) return
    const retryFromAudio = isTemporaryAudioFailure(meeting)
    const ok = await confirm({
      title: retryFromAudio ? '텍스트 추출부터 다시 시도할까요?' : 'AI 요약을 진행하시겠습니까?',
      message: retryFromAudio
        ? `임시저장된 음성 파일로 텍스트 추출을 다시 실행한 뒤 AI 요약까지 진행합니다. 음성 길이 기준 ${estimateProcessingTime(
            meeting.duration_sec,
          )} 정도 걸릴 수 있어요.`
        : undefined,
      confirmLabel: retryFromAudio ? '다시 시도' : '진행',
    })
    if (!ok) return
    await handleResummarize()
  }

  const handleCancelProcessing = async () => {
    if (!meeting) return
    const isSummaryCancel = meeting.status === 'summarizing'
    const cancelTranscriptLabel =
      !meeting.audio_filename && meeting.segments.length > 0 ? '직접 작성 내용' : '전체 스크립트'
    const ok = await confirm({
      title: isSummaryCancel ? 'AI 요약을 취소할까요?' : '변환을 취소할까요?',
      message: isSummaryCancel
        ? `현재 진행 중인 AI 요약을 멈춥니다. ${cancelTranscriptLabel}과 기존 회의 내용은 유지되고, 나중에 다시 AI 요약을 실행할 수 있어요.`
        : '현재 텍스트 변환을 멈추고 음성 파일만 임시저장합니다. 나중에 AI 요약을 누르면 텍스트 추출부터 다시 시도할 수 있어요.',
      confirmLabel: isSummaryCancel ? '요약 취소' : '변환 취소',
      danger: true,
    })
    if (!ok) return
    setCancellingProcessing(true)
    try {
      const result = await api.cancelProcessing(meeting.id)
      setMeeting((prev) =>
        prev
          ? {
              ...prev,
              status: 'failed',
              error_message: result.message,
              ...(isSummaryCancel ? {} : { segments: [], summary: null }),
            }
          : prev,
      )
      notifyChanged()
    } catch (e) {
      alert(e instanceof Error ? e.message : '처리 취소에 실패했어요')
      api.getMeeting(meetingId).then(setMeeting).catch(() => {})
    } finally {
      setCancellingProcessing(false)
    }
  }

  // ----- 회의 잠금 -----
  const handleToggleLock = async () => {
    if (!meeting) return
    const next = !meeting.locked
    if (!next) {
      const ok = await confirm({
        title: '잠금을 해제하시겠습니까?',
        message: '잠금을 해제하면 AI 회의록 수정/재생성과 삭제를 다시 사용할 수 있어요.',
        confirmLabel: '잠금 해제',
      })
      if (!ok) return
    }
    setMeeting((prev) => (prev ? { ...prev, locked: next } : prev))
    if (next) setEditingSummary(false)
    try {
      await api.updateMeeting(meeting.id, { locked: next })
      notifyChanged()
    } catch (e) {
      setMeeting((prev) => (prev ? { ...prev, locked: !next } : prev))
      alert(e instanceof Error ? e.message : '잠금 상태 변경에 실패했어요')
    }
  }

  // ----- 회의 공유 -----
  const handleToggleShare = async () => {
    if (!meeting || user?.id !== meeting.user_id) return
    const nextShared = !meeting.is_shared
    const ok = await confirm({
      title: nextShared ? '회의를 공유하시겠습니까?' : '회의 공유를 해제하시겠습니까?',
      message: nextShared
        ? '공유하면 해당 회의록과 회의 내용이 모든 사용자에게 공개됩니다. 공개된 회의는 내용 보호를 위해 자동으로 잠금 처리됩니다.'
        : '공유를 해제하면 해당 회의록은 더 이상 다른 사용자에게 공개되지 않습니다. 공유 해제와 함께 회의 잠금도 해제됩니다.',
      confirmLabel: nextShared ? '회의 공유' : '회의 공유 해제',
      danger: !nextShared,
    })
    if (!ok) return

    const prevShared = meeting.is_shared
    const prevLocked = meeting.locked
    setMeeting((prev) => (prev ? { ...prev, is_shared: nextShared, locked: nextShared } : prev))
    if (nextShared) setEditingSummary(false)
    try {
      await api.updateMeeting(meeting.id, { is_shared: nextShared, locked: nextShared })
      notifyChanged()
    } catch (e) {
      setMeeting((prev) => (prev ? { ...prev, is_shared: prevShared, locked: prevLocked } : prev))
      alert(e instanceof Error ? e.message : '공유 설정을 변경하지 못했어요')
    }
  }

  // ----- 삭제 (휴지통 이동) -----
  const handleDelete = async () => {
    if (!meeting) return
    if (meeting.locked) {
      alert('잠긴 회의는 삭제할 수 없어요. 잠금을 해제한 뒤 다시 시도해주세요.')
      return
    }
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
  const isRecordingMeeting = meeting.status === 'recording'
  const isScheduledMeeting = meeting.status === 'scheduled'
  const isManualMeeting = !meeting.audio_filename && meeting.segments.length > 0
  const manualSegment = isManualMeeting ? meeting.segments[0] : null
  const transcriptLabel = isManualMeeting ? '직접 작성 내용' : '전체 스크립트'
  const shouldBlockAudioPlayback = audioPlaybackDisabled || isRecordingMeeting
  const isLocked = meeting.locked
  const isOwner = user?.id === meeting.user_id
  const lockedActionMessage = '잠금 상태에서는 AI 회의록 수정/재생성과 삭제를 할 수 없어요.'
  const resummarizeHint = isManualMeeting
    ? '메모와 직접 작성 내용을 기준으로 다시 요약합니다'
    : '메모와 전체 스크립트를 기준으로 다시 요약합니다'
  const temporaryAudioFailure = isTemporaryAudioFailure(meeting)
  const processingEstimate = estimateProcessingTime(meeting.duration_sec)
  const canCancelProcessing =
    isOwner &&
    (meeting.status === 'queued' || meeting.status === 'transcribing' || meeting.status === 'summarizing')
  const canResummarize =
    temporaryAudioFailure ||
    (meeting.segments.length > 0 && (meeting.status === 'done' || meeting.status === 'failed'))
  const aiSummaryHint = temporaryAudioFailure
    ? `임시저장된 음성 파일로 텍스트 추출부터 다시 시도합니다. 예상 소요 시간: ${processingEstimate}`
    : resummarizeHint

  return (
    <div className="detail-view">
      <div className="detail-topbar">
        {onBack ? (
          <button className="detail-back" onClick={onBack}>
            ← 회의 목록
          </button>
        ) : (
          <span />
        )}
        <div className="detail-actions">
          <button
            type="button"
            className={`btn detail-lock-btn${isLocked ? ' locked' : ' btn-ghost'}`}
            aria-pressed={isLocked}
            title={isLocked ? '잠금을 해제합니다' : `회의 삭제와 AI 수정을 잠급니다. ${resummarizeHint}`}
            onClick={() => void handleToggleLock()}
          >
            {isLocked ? '🔒 잠금됨' : '🔓 잠금'}
          </button>
          {isOwner && (
            <button
              type="button"
              className={`btn detail-share-btn${meeting.is_shared ? ' active' : ' btn-ghost'}`}
              aria-pressed={meeting.is_shared}
              title={
                meeting.is_shared
                  ? '회의 공유를 해제합니다'
                  : '회의록과 회의 내용을 모든 사용자에게 공유합니다'
              }
              onClick={() => void handleToggleShare()}
            >
              ↗ {meeting.is_shared ? '회의 공유 해제' : '회의 공유'}
            </button>
          )}
          {canResummarize && (
            <button
              className="btn btn-soft"
              onClick={() => void handleResummarizeWithConfirm()}
              disabled={isLocked}
              title={isLocked ? lockedActionMessage : aiSummaryHint}
            >
              ✨ AI 요약
            </button>
          )}
          <button
            className="btn btn-danger"
            onClick={handleDelete}
            disabled={isLocked}
            title={isLocked ? lockedActionMessage : undefined}
          >
            삭제
          </button>
        </div>
      </div>

      {/* 헤더 */}
      <div className="detail-header">
        <div className="detail-title-row">
          <span className="detail-title-tag">
            <TagPicker compact value={meeting.tag} onChange={handleTagChange} />
          </span>
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
            <span className="detail-title-edit-wrap">
              <h1 className="page-title detail-title">{meeting.title}</h1>
              <button className="btn-icon" aria-label="제목 수정" title="제목 수정" onClick={startEditTitle}>
                ✏️
              </button>
            </span>
          )}
          <StatusBadge status={meeting.status} />
        </div>
        {isLocked && (
          <div className="detail-lock-banner">
            🔒 잠금 상태입니다. AI 회의록 수정/재생성과 삭제가 비활성화돼요.
          </div>
        )}

        <div className="detail-meta">
          {editingDate ? (
            <span className="detail-date-edit">
              <input
                type="text"
                className="input detail-date-input"
                value={dateDraft}
                inputMode="numeric"
                placeholder="YYYY-MM-DD"
                pattern="[0-9]{4}-[0-9]{2}-[0-9]{2}"
                maxLength={10}
                autoFocus
                onChange={(e) => setDateDraft(e.target.value)}
              />
              <select
                className="input detail-time-select"
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
                className="input detail-time-select"
                aria-label="분"
                value={minuteDraft}
                onChange={(e) => setMinuteDraft(Number(e.target.value))}
              >
                {Array.from({ length: 60 }, (_, m) => (
                  <option key={m} value={m}>
                    {String(m).padStart(2, '0')}분
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-primary detail-date-save"
                onClick={() => void commitDate()}
              >
                저장
              </button>
              <button
                type="button"
                className="btn btn-ghost detail-date-save"
                onClick={() => setEditingDate(false)}
              >
                취소
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="detail-date-btn"
              title="회의 날짜/시간 변경"
              onClick={beginEditDate}
            >
              {formatKoreanDateTime(meeting.started_at)} ✎
            </button>
          )}
          {meeting.duration_sec != null && (
            <>
              <span className="meta-dot">·</span>
              <span>{formatClock(meeting.duration_sec)}</span>
            </>
          )}
        </div>

        <div className="detail-people">
          {meeting.participants.length > 0 && (
            <AvatarStack participants={meeting.participants} max={6} />
          )}
          <span className="muted">참석자 {meeting.participants.length}명</span>
          <button className="btn btn-ghost detail-people-edit" onClick={() => setPickerOpen(true)}>
            참석자
          </button>
        </div>
      </div>

      {/* 진행 배너 */}
      {progressMessage && (
        <div className="progress-banner">
          <span className="spinner" />
          <div className="progress-copy">
            <span className="progress-text">{progressMessage}</span>
            {(meeting.status === 'queued' || meeting.status === 'transcribing') && (
              <span className="progress-subtext">
                음성 길이 기준 {processingEstimate} 정도 걸릴 수 있어요.
              </span>
            )}
          </div>
          {canCancelProcessing && (
            <button
              type="button"
              className="btn btn-ghost progress-cancel-btn"
              disabled={cancellingProcessing}
              onClick={() => void handleCancelProcessing()}
            >
              {cancellingProcessing
                ? '취소 중...'
                : meeting.status === 'summarizing'
                  ? 'AI 요약 취소'
                  : '변환 취소'}
            </button>
          )}
        </div>
      )}

      {/* 실패 배너 */}
      {meeting.status === 'failed' && (
        <div className={`failed-banner${temporaryAudioFailure ? ' temp-audio' : ''}`}>
          <span className="failed-emoji">⚠️</span>
          <div className="failed-body">
            <strong>{temporaryAudioFailure ? '음성 변환에 실패했어요' : '처리에 실패했어요'}</strong>
            {meeting.error_message && <p className="failed-message">{meeting.error_message}</p>}
            {temporaryAudioFailure && (
              <p className="failed-help">
                음성 파일은 임시저장되어 있어요. AI 요약을 누르면 텍스트 추출부터 다시
                시도합니다. 예상 소요 시간은 {processingEstimate} 정도예요.
              </p>
            )}
          </div>
          <button
            className={`btn ${temporaryAudioFailure ? 'btn-primary' : 'btn-danger'}`}
            onClick={() => void handleResummarizeWithConfirm()}
            disabled={isLocked}
            title={isLocked ? lockedActionMessage : undefined}
          >
            {temporaryAudioFailure ? '텍스트 추출 다시 시도' : '다시 시도'}
          </button>
        </div>
      )}

      {/* 오디오 플레이어 (파형 클릭 시크 + 북마크 핀 + 마크 추가) */}
      {shouldBlockAudioPlayback ? (
        <div className="card audio-unavailable-card" role="status" aria-live="polite">
          <div className="audio-unavailable-icon">🎙️</div>
          <div className="audio-unavailable-copy">
            <strong>지금 회의 기록 중이라 음원 재생은 사용할 수 없어요.</strong>
            <p>녹음을 종료한 뒤 다시 열면 음원을 재생할 수 있습니다.</p>
          </div>
        </div>
      ) : meeting.audio_filename ? (
        <AudioPlayerCard
          ref={playerRef}
          src={api.audioUrl(meeting.id)}
          meetingId={meeting.id}
          durationSec={meeting.duration_sec}
          bookmarks={timedBookmarks}
          onAddMark={(timeSec) => void handleAddMark(timeSec)}
        />
      ) : null}

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
            {t.key === 'transcript' ? transcriptLabel : t.label}
            {t.key === 'notes' && meeting.bookmarks.length > 0 && (
              <span className="tab-count">{meeting.bookmarks.length}</span>
            )}
          </button>
        ))}
      </div>

      <div className="card tab-panel">
        {/* AI 회의록 — K1 구조: 회의내용 / 핵심내용 / 결정사항(+추가 확인 필요) / 할 일 */}
        {tab === 'minutes' &&
          (summary ? (
            editingSummary ? (
              <div className="minutes-panel summary-edit">
                <p className="muted summary-edit-hint">
                  AI 회의록의 항목과 내용을 직접 수정할 수 있어요. 핵심내용·결정사항·추가
                  확인·할 일은 한 줄에 하나씩 적어주세요. 저장하면 Word/PDF 출력에도 반영됩니다.
                </p>
                <label className="field-label">회의내용 (마크다운)</label>
                <textarea
                  className="input summary-edit-area summary-edit-discussion"
                  value={sumDraft.discussion}
                  onChange={(e) => setSumDraft((d) => ({ ...d, discussion: e.target.value }))}
                />
                <label className="field-label">핵심내용 (한 줄에 하나)</label>
                <textarea
                  className="input summary-edit-area"
                  value={sumDraft.key_points}
                  onChange={(e) => setSumDraft((d) => ({ ...d, key_points: e.target.value }))}
                />
                <label className="field-label">결정사항 (한 줄에 하나)</label>
                <textarea
                  className="input summary-edit-area"
                  value={sumDraft.decisions}
                  onChange={(e) => setSumDraft((d) => ({ ...d, decisions: e.target.value }))}
                />
                <label className="field-label">추가 확인 필요 사항 (한 줄에 하나)</label>
                <textarea
                  className="input summary-edit-area"
                  value={sumDraft.followups}
                  onChange={(e) => setSumDraft((d) => ({ ...d, followups: e.target.value }))}
                />
                <label className="field-label">할 일 (한 줄에 하나)</label>
                <textarea
                  className="input summary-edit-area"
                  value={sumDraft.action_items}
                  onChange={(e) => setSumDraft((d) => ({ ...d, action_items: e.target.value }))}
                />
                <div className="summary-edit-actions">
                  <button
                    className="btn btn-ghost"
                    onClick={() => setEditingSummary(false)}
                    disabled={savingSummary}
                  >
                    취소
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={() => void commitSummary()}
                    disabled={savingSummary}
                  >
                    {savingSummary ? '저장 중...' : '저장'}
                  </button>
                </div>
              </div>
            ) : (
            <div className="minutes-panel ai-minutes-panel">
              <div className="minutes-toolbar">
                <button
                  className="btn btn-ghost"
                  onClick={beginEditSummary}
                  disabled={isLocked}
                  title={isLocked ? lockedActionMessage : undefined}
                >
                  {isLocked ? '🔒 수정 잠김' : '✏️ 수정'}
                </button>
                <button
                  className="btn btn-soft"
                  title="회의록 양식(Word .docx)으로 다운로드합니다"
                  onClick={() => downloadExport('docx')}
                >
                  📄 Word로 출력
                </button>
                <button
                  className="btn btn-soft"
                  title="회의록 양식(PDF)으로 다운로드합니다"
                  onClick={() => downloadExport('pdf')}
                >
                  🖨 PDF로 출력
                </button>
              </div>

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

              <div className="minutes-header">
                {meeting.tag &&
                  (() => {
                    const c = tags.find((t) => t.name === meeting.tag)?.color ?? '#16a34a'
                    return (
                      <span
                        className="tag-pill minutes-tag"
                        style={{
                          color: c,
                          borderColor: c,
                          background: `color-mix(in srgb, ${c} 10%, transparent)`,
                        }}
                      >
                        #{meeting.tag}
                      </span>
                    )
                  })()}
                <h2 className="minutes-title">{meeting.title}</h2>
              </div>
              <p className="minutes-meta muted">일시: {formatKoreanDateTime(meeting.started_at)}</p>

              {peopleGroups.length > 0 && (
                <div className="minutes-people">
                  <h3 className="minutes-people-heading">참석자</h3>
                  {peopleGroups.map((g) => (
                    <div key={g.org || '__none__'} className="minutes-people-group">
                      {g.org && <div className="minutes-people-org">{g.org}</div>}
                      <ul className="minutes-people-list">
                        {g.people.map((p) => (
                          <li key={p.id}>{personLine(p)}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
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
                  💡 설정에서 Gemini API 키를 등록하면 더 정확한 AI 회의록을 받을 수 있어요.
                </div>
              )}
            </div>
            )
          ) : (
            <div className="empty-state">
              <div className="emoji">
                {isScheduledMeeting ? '📅' : isRecordingMeeting ? '🎙️' : '✨'}
              </div>
              <p>
                {isScheduledMeeting
                  ? '예정된 회의입니다. 회의가 진행되면 AI 회의록이 준비됩니다.'
                  : isRecordingMeeting
                  ? '녹음 중이에요. 녹음을 종료하면 AI 회의록이 생성됩니다.'
                  : (progressMessage ?? 'AI 회의록이 아직 준비되지 않았어요.')}
              </p>
            </div>
          ))}

        {/* 전체 스크립트 / 직접 작성 내용 */}
        {tab === 'transcript' &&
          (manualSegment ? (
            <div className={`manual-content-panel${editingSegmentId === manualSegment.id ? ' editing' : ''}`}>
              <div className="manual-content-head">
                <div>
                  <h3>직접 작성 내용</h3>
                  <p>직접 입력한 회의 원문입니다. 수정 후 AI 요약을 다시 실행하면 변경 내용이 반영돼요.</p>
                </div>
                {editingSegmentId !== manualSegment.id && (
                  <button
                    type="button"
                    className="btn btn-soft"
                    onClick={() => beginEditSegment(manualSegment)}
                  >
                    ✎ 수정
                  </button>
                )}
              </div>

              {editingSegmentId === manualSegment.id ? (
                <div className="manual-content-editor">
                  <textarea
                    className="input manual-content-textarea"
                    value={segmentDraft}
                    autoFocus
                    onChange={(e) => setSegmentDraft(e.target.value)}
                    onKeyDown={(e) => onSegmentEditorKeyDown(e, manualSegment)}
                  />
                  <div className="manual-content-actions">
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={cancelSegmentEdit}
                      disabled={savingSegmentId === manualSegment.id}
                    >
                      취소
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => void commitSegment(manualSegment)}
                      disabled={
                        savingSegmentId === manualSegment.id ||
                        segmentDraft.trim().length === 0 ||
                        segmentDraft.trim() === manualSegment.text
                      }
                    >
                      {savingSegmentId === manualSegment.id ? '저장 중...' : '저장'}
                    </button>
                  </div>
                </div>
              ) : (
                <p className="manual-content-text">{manualSegment.text}</p>
              )}
            </div>
          ) : meeting.segments.length > 0 ? (
            <div className="transcript-list">
              {meeting.segments.map((seg) => {
                const isEditingSegment = editingSegmentId === seg.id
                const isSavingSegment = savingSegmentId === seg.id
                const canSaveSegment =
                  segmentDraft.trim().length > 0 && segmentDraft.trim() !== seg.text
                return (
                  <div
                    key={seg.id}
                    className={`segment-row${isEditingSegment ? ' editing' : ''}`}
                  >
                    <button className="time-chip" onClick={() => seekTo(seg.start_sec)}>
                      {formatClock(seg.start_sec)}
                    </button>
                    <div className="segment-body">
                      {isEditingSegment ? (
                        <div className="segment-editor">
                          <textarea
                            className="input segment-edit-textarea"
                            value={segmentDraft}
                            autoFocus
                            rows={3}
                            onChange={(e) => setSegmentDraft(e.target.value)}
                            onKeyDown={(e) => onSegmentEditorKeyDown(e, seg)}
                          />
                          <div className="segment-edit-actions">
                            <button
                              type="button"
                              className="btn btn-ghost"
                              onClick={cancelSegmentEdit}
                              disabled={isSavingSegment}
                            >
                              취소
                            </button>
                            <button
                              type="button"
                              className="btn btn-primary"
                              onClick={() => void commitSegment(seg)}
                              disabled={isSavingSegment || !canSaveSegment}
                            >
                              {isSavingSegment ? '저장 중...' : '저장'}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <p className="segment-text">{seg.text}</p>
                          <button
                            type="button"
                            className="btn-icon segment-edit-btn"
                            aria-label="스크립트 수정"
                            title="스크립트 수정"
                            onClick={() => beginEditSegment(seg)}
                          >
                            ✎
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="empty-state">
              <div className="emoji">🗣️</div>
              <p>
                {isScheduledMeeting
                  ? `회의가 진행되면 ${transcriptLabel}이 준비됩니다.`
                  : isRecordingMeeting
                  ? `녹음 종료 후 ${transcriptLabel}이 준비됩니다.`
                  : (progressMessage ?? '인식된 음성이 없어요.')}
              </p>
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
