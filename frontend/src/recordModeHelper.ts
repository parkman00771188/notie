/**
 * Notie 오디오 도우미(로컬 데몬) 클라이언트.
 * Mac에서 도우미가 설치되어 있으면 녹음 시작 시 '현재 출력 장치(스피커·에어팟 등)+BlackHole'
 * 다중 출력으로 자동 전환하고, 종료 시 원래 장치로 되돌린다 — 팝업 없는 컴퓨터 소리 녹음.
 * 도우미가 없으면 모든 함수가 조용히 실패하고 기존 동작(화면 공유)으로 폴백한다.
 */

const HELPER_BASE = 'http://127.0.0.1:45123'
const IS_MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent)

export interface HelperStatus {
  mode: 'record' | 'normal'
  blackhole: boolean
  /** 현재 기본 출력 장치 이름 (예: 'MacBook Pro 스피커', 'AirPods Pro') */
  output: string
}

async function helperFetch(path: string, init?: RequestInit, timeoutMs = 1500): Promise<Response | null> {
  if (!IS_MAC) return null
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${HELPER_BASE}${path}`, { ...init, signal: ctrl.signal })
    return res.ok ? res : null
  } catch {
    return null
  } finally {
    window.clearTimeout(timer)
  }
}

/** 도우미 존재/상태 확인 — 없거나 다른 프로세스가 응답하면 null */
export async function helperStatus(): Promise<HelperStatus | null> {
  const res = await helperFetch('/status', undefined, 800)
  if (!res) return null
  try {
    const data = (await res.json()) as { helper?: string } & HelperStatus
    return data.helper === 'notie' ? data : null
  } catch {
    return null
  }
}

/** 녹음 모드 전환 — 성공하면 true (이후 가상 오디오 장치 캡처가 보장됨) */
export async function helperRecordOn(): Promise<boolean> {
  // 장치 생성+안정화(~0.8s)가 포함될 수 있어 타임아웃을 넉넉히 둔다
  const res = await helperFetch('/record-on', { method: 'POST' }, 4000)
  if (!res) return false
  try {
    const data = (await res.json()) as { ok?: boolean }
    return data.ok === true
  } catch {
    return false
  }
}

/** 원래 출력 장치로 복귀 — 실패해도 무시(사용자가 수동 전환 가능) */
export function helperRecordOff(): void {
  void helperFetch('/record-off', { method: 'POST' }, 2000)
}
