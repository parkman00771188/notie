import type {
  Bookmark,
  Meeting,
  MeetingDetail,
  MeetingStatus,
  Participant,
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

  me(): Promise<User> {
    return request<User>('/api/auth/me')
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

  createParticipant(data: { name: string; role?: string; color?: string }): Promise<Participant> {
    return request<Participant>('/api/participants', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  updateParticipant(
    id: number,
    data: { name?: string; role?: string; color?: string },
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
    participant_ids?: number[]
  }): Promise<Meeting> {
    return request<Meeting>('/api/meetings', { method: 'POST', body: JSON.stringify(data) })
  },

  listMeetings(q?: string): Promise<Meeting[]> {
    const qs = q ? `?q=${encodeURIComponent(q)}` : ''
    return request<Meeting[]>(`/api/meetings${qs}`)
  },

  getMeeting(id: number): Promise<MeetingDetail> {
    return request<MeetingDetail>(`/api/meetings/${id}`)
  },

  updateMeeting(
    id: number,
    data: { title?: string; tag?: string; participant_ids?: number[] },
  ): Promise<Meeting> {
    return request<Meeting>(`/api/meetings/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    })
  },

  deleteMeeting(id: number): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/meetings/${id}`, { method: 'DELETE' })
  },

  uploadAudio(meetingId: number, blob: Blob, durationSec: number): Promise<Meeting> {
    const form = new FormData()
    const filename = blob instanceof File && blob.name ? blob.name : 'recording.webm'
    form.append('file', blob, filename)
    form.append('duration_sec', String(durationSec))
    return request<Meeting>(`/api/meetings/${meetingId}/audio`, { method: 'POST', body: form })
  },

  getMeetingStatus(id: number): Promise<{ status: MeetingStatus; error_message: string | null }> {
    return request(`/api/meetings/${id}/status`)
  },

  resummarize(id: number): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/meetings/${id}/summarize`, { method: 'POST' })
  },

  /** <audio src>용 URL — 헤더를 못 붙이므로 토큰을 쿼리로 전달 */
  audioUrl(meetingId: number): string {
    const token = getToken()
    return `/api/meetings/${meetingId}/audio${token ? `?token=${token}` : ''}`
  },

  // ---- settings ----
  getSettings(): Promise<AppSettings> {
    return request<AppSettings>('/api/settings')
  },

  /** gemini_api_key에 빈 문자열을 주면 키 삭제 */
  updateSettings(data: { gemini_api_key?: string }): Promise<AppSettings> {
    return request<AppSettings>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  },

  testGemini(): Promise<{ ok: boolean; message: string }> {
    return request<{ ok: boolean; message: string }>('/api/settings/test-gemini', {
      method: 'POST',
    })
  },

  // ---- bookmarks ----
  addBookmark(
    meetingId: number,
    data: { time_sec: number; title: string; note?: string },
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
    data: { title?: string; note?: string; time_sec?: number },
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
