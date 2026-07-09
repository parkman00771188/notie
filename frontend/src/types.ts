export interface User {
  id: number
  username: string
  email: string
  name: string
  team: string | null
  organization: string | null
  department: string | null
  position: string | null
  phone: string | null
  role: 'admin' | 'user'
  active: boolean
}

export interface AdminUser extends User {
  meeting_count: number
  created_at: string
}

export interface Participant {
  id: number
  source_user_id?: number | null
  source_username?: string | null
  name: string
  role: string | null
  department: string | null
  organization: string | null
  email: string | null
  phone: string | null
  color: string
  can_delete?: boolean
}

export interface Tag {
  id: number
  name: string
  color: string
  is_global: boolean
  is_project_tag?: boolean
  can_manage?: boolean
  allowed_user_ids: number[]
}

export interface Project {
  id: number
  task_number: string | null
  task_title: string | null
  principal_investigator: string | null
  research_institution: string | null
  title: string
  color: string
  active: boolean
  period_start: string | null
  period_end: string | null
  created_by: number
  created_by_name: string | null
  created_at: string
  updated_at: string
  tags: Tag[]
  members: User[]
}

export type OrgKind = 'department' | 'role' | 'organization'

export interface OrgOption {
  id: number
  kind: OrgKind
  name: string
  /** 소속(organization)에 지정한 색 — 같은 소속 참석자를 같은 색으로 표시 */
  color: string | null
  /** 관리자 계정이 만든 공용 항목 */
  is_shared?: boolean
  /** 현재 사용자가 수정/삭제할 수 있는 항목인지 여부 */
  can_manage?: boolean
}

export type MeetingStatus =
  | 'scheduled'
  | 'recording'
  | 'queued'
  | 'transcribing'
  | 'summarizing'
  | 'done'
  | 'failed'

export interface Meeting {
  id: number
  user_id: number
  title: string
  tag: string | null
  status: MeetingStatus
  started_at: string
  duration_sec: number | null
  audio_filename: string | null
  locked: boolean
  is_shared: boolean
  owner_name: string | null
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
