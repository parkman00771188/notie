import type {
  AdminUser,
  Bookmark,
  BookmarkKind,
  Meeting,
  MeetingDetail,
  MeetingStatus,
  OrgKind,
  OrgOption,
  Participant,
  Project,
  Summary,
  Tag,
  TranscriptSegment,
  User,
} from './types'

const TOKEN_KEY = 'gimnote_token'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  }
  const token = getToken()
  if (token) headers['Authorization'] = `Bearer ${token}`
  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json'
  }
  const res = await fetch(path, { ...options, headers })
  if (!res.ok) {
    let message = `요청 실패 (${res.status})`
    try {
      const data = await res.json()
      if (typeof data.detail === 'string') message = data.detail
    } catch {
      /* JSON이 아니면 기본 메시지 사용 */
    }
    throw new Error(message)
  }
  return res.json() as Promise<T>
}

export interface AuthResponse {
  token: string
  user: User
}

export interface AppSettings {
  gemini_api_key_set: boolean
  gemini_key_preview: string | null
  gemini_model: string
  ollama_available: boolean
  summary_prompt: string
  manual_summary_prompt: string
  /** 음성 변환 엔진 — Gemini 전용 */
  stt_engine: 'gemini'
}

export interface AdminUserInput {
  username?: string
  password?: string
  name: string
  role: 'admin' | 'user'
  email?: string
  organization?: string
  department?: string
  position?: string
  phone?: string
  team?: string
  active?: boolean
}

export interface ProjectInput {
  title: string
  task_number?: string
  task_title?: string
  principal_investigator?: string
  research_institution?: string
  period_start?: string
  period_end?: string
  color?: string
  tag_ids?: number[]
  member_user_ids?: number[]
  active?: boolean
}

export const api = {
  // ---- auth ----
  async signup(data: { email: string; password: string; name: string; team?: string }) {
    const res = await request<AuthResponse>('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify(data),
    })
    setToken(res.token)
    return res
  },

  async login(data: { email: string; password: string }) {
    const res = await request<AuthResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(data),
    })
    setToken(res.token)
    return res
  },

  // ---- admin users ----
  listAdminUsers(): Promise<AdminUser[]> {
    return request<AdminUser[]>('/api/admin/users')
  },

  createAdminUser(data: AdminUserInput & { username: string; password: string }): Promise<AdminUser> {
    return request<AdminUser>('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  updateAdminUser(id: number, data: Partial<AdminUserInput>): Promise<AdminUser> {
    return request<AdminUser>(`/api/admin/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    })
  },

  deleteAdminUser(id: number): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/admin/users/${id}`, { method: 'DELETE' })
  },

  // ---- projects ----
  listProjects(q?: string): Promise<Project[]> {
    const params = new URLSearchParams()
    if (q?.trim()) params.set('q', q.trim())
    const qs = params.toString()
    return request<Project[]>(`/api/projects${qs ? `?${qs}` : ''}`)
  },

  createProject(data: ProjectInput): Promise<Project> {
    return request<Project>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  updateProject(id: number, data: Partial<ProjectInput>): Promise<Project> {
    return request<Project>(`/api/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    })
  },

  deleteProject(id: number): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE' })
  },

  me(): Promise<User> {
    return request<User>('/api/auth/me')
  },

  listUserDirectory(): Promise<User[]> {
    return request<User[]>('/api/users/directory')
  },

  async logout(): Promise<void> {
    try {
      await request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' })
    } finally {
      setToken(null)
    }
  },

  // ---- participants ----
  listParticipants(): Promise<Participant[]> {
    return request<Participant[]>('/api/participants')
  },

  createParticipant(data: {
    name: string
    role?: string
    department?: string
    organization?: string
    email?: string
    phone?: string
    color?: string
  }): Promise<Participant> {
    return request<Participant>('/api/participants', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  updateParticipant(
    id: number,
    data: {
      name?: string
      role?: string
      department?: string
      organization?: string
      email?: string
      phone?: string
      color?: string
    },
  ): Promise<Participant> {
    return request<Participant>(`/api/participants/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    })
  },

  deleteParticipant(id: number): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/participants/${id}`, { method: 'DELETE' })
  },

  // ---- meetings ----
  createMeeting(data: {
    title: string
    tag?: string
    started_at?: string
    participant_ids?: number[]
  }): Promise<Meeting> {
    return request<Meeting>('/api/meetings', { method: 'POST', body: JSON.stringify(data) })
  },

  createSchedule(data: {
    title: string
    tag?: string
    started_at: string
    participant_ids?: number[]
  }): Promise<Meeting> {
    return request<Meeting>('/api/meetings/schedule', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  listMeetings(q?: string, tag?: string): Promise<Meeting[]> {
    const params = new URLSearchParams()
    if (q) params.set('q', q)
    if (tag) params.set('tag', tag)
    const qs = params.toString()
    return request<Meeting[]>(`/api/meetings${qs ? `?${qs}` : ''}`)
  },

  getMeeting(id: number): Promise<MeetingDetail> {
    return request<MeetingDetail>(`/api/meetings/${id}`)
  },

  updateMeeting(
    id: number,
    data: {
      title?: string
      tag?: string
      started_at?: string
      participant_ids?: number[]
      locked?: boolean
      is_shared?: boolean
    },
  ): Promise<Meeting> {
    return request<Meeting>(`/api/meetings/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    })
  },

  /** 휴지통으로 이동 (소프트 삭제) */
  deleteMeeting(id: number): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/meetings/${id}`, { method: 'DELETE' })
  },

  /** 휴지통 목록 (deleted_at DESC) */
  listTrash(): Promise<Meeting[]> {
    return request<Meeting[]>('/api/meetings/trash')
  },

  /** 휴지통에서 복원 */
  restoreMeeting(id: number): Promise<Meeting> {
    return request<Meeting>(`/api/meetings/${id}/restore`, { method: 'POST' })
  },

  /** 완전 삭제 (복구 불가, 오디오 파일 포함) */
  purgeMeeting(id: number): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/meetings/${id}/permanent`, { method: 'DELETE' })
  },

  uploadAudio(meetingId: number, blob: Blob, durationSec: number): Promise<Meeting> {
    const form = new FormData()
    const filename = blob instanceof File && blob.name ? blob.name : 'recording.webm'
    form.append('file', blob, filename)
    form.append('duration_sec', String(durationSec))
    return request<Meeting>(`/api/meetings/${meetingId}/audio`, { method: 'POST', body: form })
  },

  submitManualTranscript(
    meetingId: number,
    data: { text: string; duration_sec?: number },
  ): Promise<Meeting> {
    return request<Meeting>(`/api/meetings/${meetingId}/manual-transcript`, {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  getMeetingStatus(id: number): Promise<{ status: MeetingStatus; error_message: string | null }> {
    return request(`/api/meetings/${id}/status`)
  },

  resummarize(id: number): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/meetings/${id}/summarize`, { method: 'POST' })
  },

  retryAudioProcessing(id: number): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/meetings/${id}/retry-audio`, { method: 'POST' })
  },

  cancelProcessing(id: number): Promise<{ ok: boolean; message: string }> {
    return request<{ ok: boolean; message: string }>(`/api/meetings/${id}/cancel-processing`, {
      method: 'POST',
    })
  },

  /** 요약 내용 직접 수정 — 회의록도 함께 재생성됨. 보낸 필드만 반영 */
  updateSummary(
    id: number,
    data: {
      discussion?: string
      key_points?: string[]
      decisions?: string[]
      followups?: string[]
      action_items?: { text: string; owner?: string | null; due?: string | null }[]
    },
  ): Promise<Summary> {
    return request<Summary>(`/api/meetings/${id}/summary`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    })
  },

  /** 전체 스크립트 행 텍스트 수정 — 시간 정보는 서버에서 변경하지 않음 */
  updateTranscriptSegment(
    meetingId: number,
    segmentId: number,
    data: { text: string },
  ): Promise<TranscriptSegment> {
    return request<TranscriptSegment>(`/api/meetings/${meetingId}/segments/${segmentId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    })
  },

  /** 파형 피크(서버 계산, ≤600개) — 브라우저 전체 디코딩 OOM 방지 */
  getWaveform(meetingId: number): Promise<{ peaks: number[]; duration_sec: number | null }> {
    return request(`/api/meetings/${meetingId}/waveform`)
  },

  /** 회의록 문서(Word/PDF) 다운로드 URL — 브라우저가 다운로드 폴더에 저장 */
  exportUrl(meetingId: number, format: 'docx' | 'pdf' = 'docx'): string {
    const token = getToken()
    const params = new URLSearchParams({ format })
    if (token) params.set('token', token)
    return `/api/meetings/${meetingId}/export?${params.toString()}`
  },

  /** <audio src>용 URL — 헤더를 못 붙이므로 토큰을 쿼리로 전달 */
  audioUrl(meetingId: number): string {
    const token = getToken()
    return `/api/meetings/${meetingId}/audio${token ? `?token=${token}` : ''}`
  },

  // ---- tags (프로젝트/과제 태그 사전) ----
  listTags(): Promise<Tag[]> {
    return request<Tag[]>('/api/tags')
  },

  createTag(data: {
    name: string
    color?: string
    is_global?: boolean
    allowed_user_ids?: number[]
  }): Promise<Tag> {
    return request<Tag>('/api/tags', { method: 'POST', body: JSON.stringify(data) })
  },

  updateTag(
    id: number,
    data: { name?: string; color?: string; is_global?: boolean; allowed_user_ids?: number[] },
  ): Promise<Tag> {
    return request<Tag>(`/api/tags/${id}`, { method: 'PATCH', body: JSON.stringify(data) })
  },

  deleteTag(id: number): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/tags/${id}`, { method: 'DELETE' })
  },

  // ---- org options (소속/부서 · 직책 사전) ----
  listOrgOptions(kind?: OrgKind): Promise<OrgOption[]> {
    const qs = kind ? `?kind=${kind}` : ''
    return request<OrgOption[]>(`/api/org-options${qs}`)
  },

  createOrgOption(data: { kind: OrgKind; name: string; color?: string }): Promise<OrgOption> {
    return request<OrgOption>('/api/org-options', { method: 'POST', body: JSON.stringify(data) })
  },

  /** 소속 색 지정 — 빈 문자열이면 색 해제 */
  updateOrgOption(id: number, data: { name?: string; color?: string }): Promise<OrgOption> {
    return request<OrgOption>(`/api/org-options/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    })
  },

  deleteOrgOption(id: number): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/org-options/${id}`, { method: 'DELETE' })
  },

  // ---- settings ----
  getSettings(): Promise<AppSettings> {
    return request<AppSettings>('/api/settings')
  },

  /** gemini_api_key/summary_prompt/manual_summary_prompt/gemini_model에 빈 문자열을 주면 해당 값 삭제(기본값 복귀) */
  updateSettings(data: {
    gemini_api_key?: string
    summary_prompt?: string
    manual_summary_prompt?: string
    gemini_model?: string
    stt_engine?: 'gemini'
  }): Promise<AppSettings> {
    return request<AppSettings>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  },

  /** 등록된 키로 사용 가능한 Gemini 모델 목록 조회 */
  listGeminiModels(): Promise<{ models: { name: string; display_name: string }[]; error: string | null }> {
    return request('/api/settings/gemini-models')
  },

  testGemini(): Promise<{ ok: boolean; message: string }> {
    return request<{ ok: boolean; message: string }>('/api/settings/test-gemini', {
      method: 'POST',
    })
  },

  // ---- bookmarks ----
  addBookmark(
    meetingId: number,
    data: { time_sec: number; title: string; note?: string; kind?: BookmarkKind },
  ): Promise<Bookmark> {
    return request<Bookmark>(`/api/meetings/${meetingId}/bookmarks`, {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  listBookmarks(meetingId: number): Promise<Bookmark[]> {
    return request<Bookmark[]>(`/api/meetings/${meetingId}/bookmarks`)
  },

  updateBookmark(
    id: number,
    data: { title?: string; note?: string; time_sec?: number; kind?: BookmarkKind },
  ): Promise<Bookmark> {
    return request<Bookmark>(`/api/bookmarks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    })
  },

  deleteBookmark(id: number): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/bookmarks/${id}`, { method: 'DELETE' })
  },
}
