import type { MeetingStatus } from './types'

/** 초 → "00:23:41" (항상 HH:MM:SS) */
export function formatClock(sec: number | null | undefined): string {
  const s = Math.max(0, Math.floor(sec ?? 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(r)}`
}

/** 초 → "1시간 32분" / "48분" / "30초" */
export function formatDuration(sec: number | null | undefined): string {
  const s = Math.max(0, Math.floor(sec ?? 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return m > 0 ? `${h}시간 ${m}분` : `${h}시간`
  if (m > 0) return `${m}분`
  return `${s}초`
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']

/** ISO → "2024년 6월 30일 (일) 오전 10:00" */
export function formatKoreanDateTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const ampm = d.getHours() < 12 ? '오전' : '오후'
  let h12 = d.getHours() % 12
  if (h12 === 0) h12 = 12
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAYS[d.getDay()]}) ${ampm} ${h12}:${mm}`
}

/** YYYY-MM-DD 입력값 검증. 브라우저별 date input 표시 차이를 피하려는 텍스트 입력에 사용한다. */
export function isValidDateInput(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  )
}

/** ISO → "오늘 11:30" / "어제 16:45" / "6월 28일" */
export function formatRelativeDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const now = new Date()
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86400000)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (diffDays === 0) return `오늘 ${hm}`
  if (diffDays === 1) return `어제 ${hm}`
  return `${d.getMonth() + 1}월 ${d.getDate()}일`
}

export const STATUS_LABEL: Record<MeetingStatus, string> = {
  scheduled: '예정',
  recording: '녹음 중',
  queued: '대기 중',
  transcribing: '변환 중',
  summarizing: '요약 중',
  done: '요약 완료',
  failed: '실패',
}

/** 배지 톤: green | gray | blue | red */
export const STATUS_TONE: Record<MeetingStatus, 'green' | 'gray' | 'blue' | 'red'> = {
  scheduled: 'gray',
  recording: 'red',
  queued: 'gray',
  transcribing: 'blue',
  summarizing: 'blue',
  done: 'green',
  failed: 'red',
}

/**
 * 오디오 파일 길이(초) 읽기.
 * MediaRecorder가 만든 webm은 길이 메타데이터가 없어 duration이 Infinity로 나온다 —
 * 그 경우 끝으로 시크해 브라우저가 계산한 실제 길이를 durationchange로 받는다.
 * 실패/시간 초과 시 0 (서버 파이프라인이 디코드 길이로 보정).
 */
export function readAudioDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const audio = new Audio()
    let settled = false
    let timer = 0
    const done = (sec: number) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      URL.revokeObjectURL(url)
      resolve(Number.isFinite(sec) && sec > 0 ? sec : 0)
    }
    timer = window.setTimeout(() => done(0), 15000)
    audio.preload = 'metadata'
    audio.onloadedmetadata = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        done(audio.duration)
        return
      }
      audio.ondurationchange = () => {
        if (Number.isFinite(audio.duration) && audio.duration > 0) done(audio.duration)
      }
      audio.currentTime = 1e101
    }
    audio.onerror = () => done(0)
    audio.src = url
  })
}
