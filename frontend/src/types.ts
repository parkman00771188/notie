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
  color: string
}

export interface Tag {
  id: number
  name: string
  color: string
}

export interface OrgOption {
  id: number
  kind: 'department' | 'role'
  name: string
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

export interface Bookmark {
  id: number
  meeting_id: number
  time_sec: number
  title: string
  note: string | null
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
