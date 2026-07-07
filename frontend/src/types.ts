export interface User {
  id: number
  email: string
  name: string
  team: string | null
}

export interface Participant {
  id: number
  name: string
  role: string | null
  department: string | null
  organization: string | null
  email: string | null
  phone: string | null
  color: string
}

export interface Tag {
  id: number
  name: string
  color: string
}

export type OrgKind = 'department' | 'role' | 'organization'

export interface OrgOption {
  id: number
  kind: OrgKind
  name: string
  /** 소속(organization)에 지정한 색 — 같은 소속 참석자를 같은 색으로 표시 */
  color: string | null
}

export type MeetingStatus =
  | 'recording'
  | 'queued'
  | 'transcribing'
  | 'summarizing'
  | 'done'
  | 'failed'

export interface Meeting {
  id: number
  title: string
  tag: string | null
  status: MeetingStatus
  started_at: string
  duration_sec: number | null
  audio_filename: string | null
  created_at: string
  participants: Participant[]
}

/** memo: 시간 연동 메모, mark: 시간 핀, note: 시간 기록 없는 일반 메모 */
export type BookmarkKind = 'memo' | 'mark' | 'note'

export interface Bookmark {
  id: number
  meeting_id: number
  time_sec: number
  title: string
  note: string | null
  kind: BookmarkKind
  created_at: string
}

export interface TranscriptSegment {
  id: number
  start_sec: number
  end_sec: number
  text: string
}

export interface ActionItem {
  text: string
  owner?: string | null
  due?: string | null
}

export interface Summary {
  key_points: string[]
  decisions: string[]
  action_items: ActionItem[]
  /** 회의내용 — 주제별 정리(마크다운) */
  discussion: string
  /** 추가 확인 필요 사항 */
  followups: string[]
  /** LLM 실패로 폴백됐을 때의 사유 (정상이면 null) */
  engine_note: string | null
  minutes_md: string
  engine: string
  created_at: string
}

export interface MeetingDetail extends Meeting {
  bookmarks: Bookmark[]
  segments: TranscriptSegment[]
  summary: Summary | null
  error_message: string | null
}
