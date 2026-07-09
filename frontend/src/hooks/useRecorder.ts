import { useCallback, useEffect, useRef, useState } from 'react'

export type RecorderStatus = 'idle' | 'recording' | 'paused' | 'stopped'

export interface RecorderResult {
  blob: Blob
  durationSec: number
}

export interface UseRecorderReturn {
  status: RecorderStatus
  elapsedSec: number
  analyser: AnalyserNode | null
  start: (deviceId?: string) => Promise<void>
  pause: () => void
  resume: () => void
  stop: () => Promise<RecorderResult>
  cancel: () => Promise<void>
}

/** 브라우저가 지원하는 webm 오디오 mimeType 선택 */
function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  const candidates = ['audio/webm;codecs=opus', 'audio/webm']
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c
  }
  return ''
}

/** Wake Lock 타입 (일부 TS lib에 없어 최소 선언) */
interface WakeLockSentinelLike {
  released: boolean
  release: () => Promise<void>
  addEventListener: (type: 'release', listener: () => void) => void
}

/**
 * 마이크 녹음 훅.
 * - getUserMedia(audio) + MediaRecorder(audio/webm)
 * - AudioContext + AnalyserNode(fftSize 256) 를 파형 시각화용으로 노출
 * - elapsedSec 는 일시정지 시간을 제외한 실경과(250ms 간격 갱신)
 * - 녹음/일시정지 동안 화면 절전 방지(Wake Lock) — 탭 복귀 시 자동 재획득
 * - stop() 시 스트림/오디오컨텍스트 정리 후 {blob, durationSec} 반환
 */
export function useRecorder(): UseRecorderReturn {
  const [status, setStatus] = useState<RecorderStatus>('idle')
  const [elapsedSec, setElapsedSec] = useState(0)
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null)

  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const intervalRef = useRef<number | null>(null)
  /** 일시정지 이전까지 누적된 녹음 시간(ms) */
  const accumulatedMsRef = useRef(0)
  /** 현재 진행 중인 녹음 구간의 시작 timestamp (일시정지 중엔 null) */
  const segmentStartRef = useRef<number | null>(null)
  /** 녹음 중 화면 꺼짐 방지 (미지원 브라우저는 조용히 무시) */
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null)
  const wakeLockWantedRef = useRef(false)

  const acquireWakeLock = useCallback(async () => {
    wakeLockWantedRef.current = true
    const wl = (navigator as unknown as {
      wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> }
    }).wakeLock
    if (!wl) return
    try {
      if (wakeLockRef.current && !wakeLockRef.current.released) return
      wakeLockRef.current = await wl.request('screen')
    } catch {
      /* 배터리 세이버 등으로 거부될 수 있음 — 녹음 자체에는 영향 없음 */
    }
  }, [])

  const releaseWakeLock = useCallback(() => {
    wakeLockWantedRef.current = false
    const sentinel = wakeLockRef.current
    wakeLockRef.current = null
    if (sentinel && !sentinel.released) {
      void sentinel.release().catch(() => {})
    }
  }, [])

  // 탭을 벗어나면 브라우저가 Wake Lock을 자동 해제하므로, 복귀 시 다시 획득
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && wakeLockWantedRef.current) {
        void acquireWakeLock()
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [acquireWakeLock])

  const currentElapsedMs = useCallback((): number => {
    const running =
      segmentStartRef.current != null ? Date.now() - segmentStartRef.current : 0
    return accumulatedMsRef.current + running
  }, [])

  const cleanup = useCallback(() => {
    if (intervalRef.current != null) {
      window.clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
    const ctx = audioCtxRef.current
    if (ctx && ctx.state !== 'closed') {
      void ctx.close().catch(() => {})
    }
    audioCtxRef.current = null
    recorderRef.current = null
    segmentStartRef.current = null
    releaseWakeLock()
    setAnalyser(null)
  }, [releaseWakeLock])

  // 언마운트 시 녹음 중이면 강제 정리
  useEffect(() => {
    return () => {
      const rec = recorderRef.current
      if (rec && rec.state !== 'inactive') {
        try {
          rec.stop()
        } catch {
          /* 이미 종료된 경우 무시 */
        }
      }
      cleanup()
    }
  }, [cleanup])

  const start = useCallback(async (deviceId?: string) => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') return

    const audioConstraint: MediaTrackConstraints | boolean = deviceId
      ? { deviceId: { exact: deviceId } }
      : true
    const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint })
    streamRef.current = stream

    // 파형용 AnalyserNode
    const AudioCtx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (AudioCtx) {
      const ctx = new AudioCtx()
      audioCtxRef.current = ctx
      const source = ctx.createMediaStreamSource(stream)
      const node = ctx.createAnalyser()
      node.fftSize = 256
      source.connect(node)
      setAnalyser(node)
    }

    const mimeType = pickMimeType()
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    chunksRef.current = []
    rec.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data)
    }
    rec.start(1000) // 1초 단위로 청크 수집
    recorderRef.current = rec

    accumulatedMsRef.current = 0
    segmentStartRef.current = Date.now()
    setElapsedSec(0)
    setStatus('recording')
    void acquireWakeLock() // 녹음 중 화면 꺼짐 방지

    if (intervalRef.current != null) window.clearInterval(intervalRef.current)
    intervalRef.current = window.setInterval(() => {
      setElapsedSec(currentElapsedMs() / 1000)
    }, 250)
  }, [acquireWakeLock, currentElapsedMs])

  const pause = useCallback(() => {
    const rec = recorderRef.current
    if (!rec || rec.state !== 'recording') return
    rec.pause()
    accumulatedMsRef.current = currentElapsedMs()
    segmentStartRef.current = null
    setElapsedSec(accumulatedMsRef.current / 1000)
    setStatus('paused')
  }, [currentElapsedMs])

  const resume = useCallback(() => {
    const rec = recorderRef.current
    if (!rec || rec.state !== 'paused') return
    rec.resume()
    segmentStartRef.current = Date.now()
    setStatus('recording')
  }, [])

  const stop = useCallback((): Promise<RecorderResult> => {
    return new Promise<RecorderResult>((resolve, reject) => {
      const rec = recorderRef.current
      if (!rec || rec.state === 'inactive') {
        reject(new Error('녹음 중이 아닙니다.'))
        return
      }
      const durationMs = currentElapsedMs()
      accumulatedMsRef.current = durationMs
      segmentStartRef.current = null
      const durationSec = durationMs / 1000

      rec.onstop = () => {
        const type = rec.mimeType || 'audio/webm'
        const blob = new Blob(chunksRef.current, { type })
        cleanup()
        setElapsedSec(durationSec)
        setStatus('stopped')
        resolve({ blob, durationSec })
      }
      try {
        rec.stop()
      } catch (err) {
        cleanup()
        setStatus('stopped')
        reject(err instanceof Error ? err : new Error('녹음 종료에 실패했습니다.'))
      }
    })
  }, [cleanup, currentElapsedMs])

  const cancel = useCallback((): Promise<void> => {
    return new Promise<void>((resolve) => {
      const rec = recorderRef.current
      chunksRef.current = []
      accumulatedMsRef.current = 0
      segmentStartRef.current = null

      const finish = () => {
        chunksRef.current = []
        cleanup()
        setElapsedSec(0)
        setStatus('idle')
        resolve()
      }

      if (!rec || rec.state === 'inactive') {
        finish()
        return
      }

      rec.ondataavailable = null
      rec.onstop = finish
      try {
        rec.stop()
      } catch {
        finish()
      }
    })
  }, [cleanup])

  return { status, elapsedSec, analyser, start, pause, resume, stop, cancel }
}

export default useRecorder
