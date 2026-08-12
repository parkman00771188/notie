import { useCallback, useEffect, useRef, useState } from 'react'
import { helperRecordOff, helperRecordOn } from '../recordModeHelper'

export type RecorderStatus = 'idle' | 'recording' | 'paused' | 'stopped'

/** 녹음 소스 — 마이크만 / 컴퓨터 소리만 / 둘 다 믹싱 */
export type RecordSource = 'mic' | 'system' | 'both'

/** 컴퓨터(시스템) 소리 캡처의 현재 상태 — 'ended'는 녹음 중 캡처가 끊긴 경우 */
export type SystemAudioStatus = 'off' | 'on' | 'ended'

/** 컴퓨터 소리 캡처 결과 — 'on' 외에는 캡처 실패. 'system-denied'는 OS가 브라우저의 화면 녹화를 막은 경우 */
export type SystemAudioStartResult = 'off' | 'on' | 'unsupported' | 'denied' | 'system-denied' | 'no-audio'

/** 컴퓨터 소리를 가져온 방법 — loopback(가상 오디오 장치, 팝업 없음) / display(화면 공유) */
export type SystemAudioVia = 'loopback' | 'display'

/**
 * 컴퓨터 소리 신호 상태 — 캡처 트랙은 살아있는데 소리가 계속 무음이면 'silent'.
 * 공유 창에서 오디오를 켜지 않았거나 가상 오디오 장치 라우팅이 빠진 경우를 녹음 중에 알아챌 수 있다.
 */
export type SystemSignal = 'none' | 'live' | 'silent'

export interface RecorderStartOptions {
  deviceId?: string
  source?: RecordSource
}

export interface RecorderStartOutcome {
  /** false면 녹음이 시작되지 않음 — 컴퓨터 소리 전용 모드에서 소리를 얻지 못한 경우 */
  started: boolean
  systemAudio: SystemAudioStartResult
  via?: SystemAudioVia
}

export interface RecorderResult {
  blob: Blob
  durationSec: number
}

export interface UseRecorderReturn {
  status: RecorderStatus
  elapsedSec: number
  analyser: AnalyserNode | null
  systemAudio: SystemAudioStatus
  /** 컴퓨터 소리 실시간 신호 — 'silent'면 캡처는 되는데 소리가 안 들어오는 상태 */
  systemSignal: SystemSignal
  /** 녹음 중 마이크 음소거 여부 — true면 마이크 구간이 무음으로 기록된다 */
  micMuted: boolean
  /** 녹음 중 컴퓨터 소리 음소거 여부 */
  systemMuted: boolean
  setMicMuted: (muted: boolean) => void
  setSystemMuted: (muted: boolean) => void
  start: (options?: RecorderStartOptions) => Promise<RecorderStartOutcome>
  /** 녹음을 유지한 채 컴퓨터 소리 캡처만 다시 시도 — source가 system/both인 녹음에서만 동작 */
  retrySystemAudio: () => Promise<SystemAudioStartResult>
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

/** 시스템 출력을 입력으로 되돌려주는 가상 오디오 장치(loopback) 라벨 패턴 */
const LOOPBACK_LABEL_RE =
  /blackhole|loopback|soundflower|vb-?cable|vb-?audio|virtual audio|virtual cable|stereo mix|스테레오 믹스/i

export const isLoopbackDevice = (d: MediaDeviceInfo) =>
  d.kind === 'audioinput' && LOOPBACK_LABEL_RE.test(d.label)

/**
 * 설치된 가상 오디오 장치 탐색 — 있으면 팝업 없이 컴퓨터 소리를 캡처할 수 있다.
 * 마이크 권한이 활성화되기 전에는 라벨이 빈 문자열이라 장치를 식별할 수 없으므로
 * (특히 Safari는 권한이 세션 간 유지되지 않는다), 임시 마이크 스트림으로 라벨을 연 뒤 다시 찾는다.
 */
export async function findLoopbackDevice(): Promise<MediaDeviceInfo | null> {
  if (!navigator.mediaDevices?.enumerateDevices) return null
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const found = devices.find(isLoopbackDevice)
    if (found) return found
    const labelsHidden = devices.some((d) => d.kind === 'audioinput' && !d.label)
    if (!labelsHidden) return null
    let temp: MediaStream | null = null
    try {
      temp = await navigator.mediaDevices.getUserMedia({ audio: true })
      const unlocked = await navigator.mediaDevices.enumerateDevices()
      return unlocked.find(isLoopbackDevice) ?? null
    } finally {
      temp?.getTracks().forEach((t) => t.stop())
    }
  } catch {
    // 마이크 권한 거부 포함 — 라벨을 열 수 없으면 가상 오디오 장치도 쓸 수 없다
    return null
  }
}

/** 가상 오디오 장치를 원음 그대로 캡처 — EC/NS 가공이 음악·음성을 뭉개지 않도록 끈다 */
export async function captureLoopbackAudio(deviceId: string): Promise<MediaStream | null> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: deviceId },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    })
  } catch (err) {
    console.warn('[recorder] 가상 오디오 장치 캡처 실패:', err)
    return null
  }
}

/** Safari는 getDisplayMedia로 오디오를 주지 않으므로 화면 공유 폴백(팝업)이 무의미하다 */
const DISPLAY_AUDIO_SUPPORTED =
  typeof navigator !== 'undefined' &&
  !!navigator.mediaDevices?.getDisplayMedia &&
  !(
    /safari/i.test(navigator.userAgent) &&
    !/chrome|chromium|crios|edg|android/i.test(navigator.userAgent)
  )

/**
 * 화면 공유 방식의 컴퓨터 소리 캡처 요청.
 * 사용자 클릭 제스처(transient activation)가 살아있는 동안 호출해야 한다.
 */
async function requestDisplayAudio(): Promise<{
  result: SystemAudioStartResult
  stream: MediaStream | null
  track: MediaStreamTrack | null
}> {
  if (!DISPLAY_AUDIO_SUPPORTED) {
    return { result: 'unsupported', stream: null, track: null }
  }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      // 탭 패널이 기본으로 열리게 힌트 — 탭 오디오는 스피커 음소거와 무관하게 캡처된다
      // (Windows 전체 화면 공유는 시스템 음소거 시 무음이 되는 OS 제약이 있음)
      video: { displaySurface: 'browser' },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      // Chromium 전용 힌트들: 시스템 오디오 옵션 노출, 자기 자신 탭 제외, 전체 화면도 선택 가능
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
      monitorTypeSurfaces: 'include',
    } as MediaStreamConstraints)
    const track = stream.getAudioTracks()[0] ?? null
    if (!track) {
      // 공유는 허용했지만 오디오가 포함되지 않은 경우 (Safari는 화면 공유 오디오 미지원)
      stream.getTracks().forEach((t) => t.stop())
      return { result: 'no-audio', stream: null, track: null }
    }
    return { result: 'on', stream, track }
  } catch (err) {
    console.warn('[recorder] 화면 공유 오디오 캡처 실패:', err)
    // OS(macOS 화면 녹화 권한 등)가 막은 경우와 사용자가 공유 창에서 취소한 경우를 구분
    const result =
      err instanceof DOMException && err.name === 'NotAllowedError' && /system/i.test(err.message)
        ? 'system-denied'
        : 'denied'
    return { result, stream: null, track: null }
  }
}

/** Wake Lock 타입 (일부 TS lib에 없어 최소 선언) */
interface WakeLockSentinelLike {
  released: boolean
  release: () => Promise<void>
  addEventListener: (type: 'release', listener: () => void) => void
}

/**
 * 회의 녹음 훅.
 * - source 'mic': getUserMedia(마이크)만 녹음 (기존 동작)
 * - source 'system': 컴퓨터 소리만 — Mac 오디오 도우미가 있으면 출력 자동 전환 후 가상 오디오 장치로
 *   팝업 없이 캡처, 없으면 화면 공유(시스템 오디오) 우선 + 가상 오디오 장치 폴백
 * - source 'both': 마이크 + 컴퓨터 소리를 Web Audio로 믹싱해 한 트랙으로 녹음
 * - 컴퓨터 소리 캡처 실패/중단 시에도 가능한 녹음은 유지, retrySystemAudio()로 녹음 중 재시도
 * - AudioContext + AnalyserNode(fftSize 256) 를 파형 시각화용으로 노출
 * - elapsedSec 는 일시정지 시간을 제외한 실경과(250ms 간격 갱신)
 * - 녹음/일시정지 동안 화면 절전 방지(Wake Lock) — 탭 복귀 시 자동 재획득
 * - stop() 시 스트림/오디오컨텍스트 정리 후 {blob, durationSec} 반환
 */
export function useRecorder(): UseRecorderReturn {
  const [status, setStatus] = useState<RecorderStatus>('idle')
  const [elapsedSec, setElapsedSec] = useState(0)
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null)
  const [systemAudio, setSystemAudio] = useState<SystemAudioStatus>('off')
  const [systemSignal, setSystemSignal] = useState<SystemSignal>('none')
  const [micMuted, setMicMutedState] = useState(false)
  const [systemMuted, setSystemMutedState] = useState(false)
  /** 재시도로 새 시스템 스트림이 붙을 때 현재 음소거 상태를 적용하기 위한 미러 */
  const systemMutedRef = useRef(false)
  /** 시스템 소리 무음 감지용 — 시스템 소스만 연결된 분석기와 마지막 신호 시각 */
  const sysAnalyserRef = useRef<AnalyserNode | null>(null)
  const sysMonitorRef = useRef<number | null>(null)
  const lastSysSignalAtRef = useRef(0)
  /** Mac 오디오 도우미가 이번 녹음을 위해 출력을 전환했는지 — true면 종료 시 복귀시켜야 한다 */
  const helperEngagedRef = useRef(false)

  /** 도우미가 전환해둔 출력 장치를 원래대로 복귀 (전환한 적 없으면 no-op) */
  const releaseHelper = useCallback(() => {
    if (helperEngagedRef.current) {
      helperEngagedRef.current = false
      helperRecordOff()
    }
  }, [])

  const streamRef = useRef<MediaStream | null>(null)
  const displayStreamRef = useRef<MediaStream | null>(null)
  const loopbackStreamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  /** 마이크/시스템 오디오가 합쳐지는 버스 — retrySystemAudio()에서 소스를 추가로 꽂는다 */
  const mixBusRef = useRef<GainNode | null>(null)
  /** 녹음 스트림이 믹스 경로(destination)를 거치는지 — 아니면 재시도로 붙여도 녹음에 안 들어간다 */
  const mixRecordingRef = useRef(false)
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

  /** 시스템 소리 무음 감시 — 350ms 간격으로 RMS를 읽어 4초 이상 완전 무음이면 'silent' 표시 */
  const startSystemMonitor = useCallback(() => {
    if (sysMonitorRef.current != null) return
    sysMonitorRef.current = window.setInterval(() => {
      const node = sysAnalyserRef.current
      if (!node) return
      if (systemMutedRef.current) {
        // 사용자가 직접 끈 상태 — 무음이 정상이므로 경고하지 않는다
        lastSysSignalAtRef.current = Date.now()
        setSystemSignal('live')
        return
      }
      const data = new Uint8Array(node.fftSize)
      node.getByteTimeDomainData(data)
      let sum = 0
      for (const v of data) {
        const n = (v - 128) / 128
        sum += n * n
      }
      const rms = Math.sqrt(sum / data.length)
      if (rms > 0.0015) {
        lastSysSignalAtRef.current = Date.now()
        setSystemSignal('live')
      } else if (Date.now() - lastSysSignalAtRef.current > 4000) {
        setSystemSignal('silent')
      }
    }, 350)
  }, [])

  const cleanup = useCallback(() => {
    if (intervalRef.current != null) {
      window.clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    if (sysMonitorRef.current != null) {
      window.clearInterval(sysMonitorRef.current)
      sysMonitorRef.current = null
    }
    sysAnalyserRef.current = null
    setSystemSignal('none')
    for (const ref of [streamRef, displayStreamRef, loopbackStreamRef]) {
      ref.current?.getTracks().forEach((t) => t.stop())
      ref.current = null
    }
    const ctx = audioCtxRef.current
    if (ctx && ctx.state !== 'closed') {
      void ctx.close().catch(() => {})
    }
    audioCtxRef.current = null
    mixBusRef.current = null
    mixRecordingRef.current = false
    recorderRef.current = null
    segmentStartRef.current = null
    releaseHelper()
    releaseWakeLock()
    setAnalyser(null)
    setSystemAudio('off')
    setMicMutedState(false)
    setSystemMutedState(false)
    systemMutedRef.current = false
  }, [releaseHelper, releaseWakeLock])

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

  /** 확보한 컴퓨터 소리 스트림을 믹스 버스에 연결하고, 캡처 중단·무음 감지를 부착 */
  const attachSystemStream = useCallback((stream: MediaStream, kind: SystemAudioVia): boolean => {
    const ctx = audioCtxRef.current
    const mixBus = mixBusRef.current
    const track = stream.getAudioTracks()[0]
    if (!ctx || !mixBus || !track) return false
    track.enabled = !systemMutedRef.current
    const source = ctx.createMediaStreamSource(new MediaStream([track]))
    source.connect(mixBus)
    // 시스템 소스만 따로 분석해 '캡처는 되는데 무음'인 상태를 사용자에게 보여준다
    const sysAnalyser = ctx.createAnalyser()
    sysAnalyser.fftSize = 256
    source.connect(sysAnalyser)
    sysAnalyserRef.current = sysAnalyser
    lastSysSignalAtRef.current = Date.now()
    setSystemSignal('live')
    startSystemMonitor()
    const ref = kind === 'display' ? displayStreamRef : loopbackStreamRef
    ref.current = stream
    // 브라우저의 '공유 중지'나 장치 분리로 캡처가 끊겨도 남은 소스 녹음은 이어간다
    track.addEventListener('ended', () => {
      ref.current?.getTracks().forEach((t) => t.stop())
      ref.current = null
      sysAnalyserRef.current = null
      setSystemSignal('none')
      setSystemAudio('ended')
    })
    return true
  }, [startSystemMonitor])

  /**
   * 컴퓨터 소리 확보.
   * - 오디오 도우미가 출력을 전환해준 경우(preferLoopback): 가상 오디오 장치 우선 —
   *   라우팅이 보장되므로 팝업 없이 캡처된다.
   * - 그 외: 화면 공유(시스템 오디오) 우선 — OS 출력 장치·볼륨 설정을 건드리지 않아
   *   볼륨 키가 평소처럼 동작한다. 미지원(Safari)/공유 취소 시 가상 오디오 장치 폴백.
   */
  const captureSystemAudio = useCallback(async (preferLoopback: boolean): Promise<{
    result: SystemAudioStartResult
    via?: SystemAudioVia
    stream: MediaStream | null
  }> => {
    const tryLoopback = async (): Promise<MediaStream | null> => {
      const loopback = await findLoopbackDevice()
      if (!loopback) return null
      return captureLoopbackAudio(loopback.deviceId)
    }
    if (preferLoopback) {
      const stream = await tryLoopback()
      if (stream) return { result: 'on', via: 'loopback', stream }
    }
    let displayResult: SystemAudioStartResult = 'unsupported'
    if (DISPLAY_AUDIO_SUPPORTED) {
      const captured = await requestDisplayAudio()
      if (captured.result === 'on') {
        return { result: 'on', via: 'display', stream: captured.stream }
      }
      displayResult = captured.result
    }
    if (!preferLoopback) {
      const stream = await tryLoopback()
      if (stream) return { result: 'on', via: 'loopback', stream }
    }
    return { result: displayResult, stream: null }
  }, [])

  const start = useCallback(async (options: RecorderStartOptions = {}): Promise<RecorderStartOutcome> => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      return { started: false, systemAudio: 'off' }
    }
    const { deviceId, source = 'mic' } = options
    const AudioCtx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    // 믹싱이 필요한 소스인데 AudioContext가 없으면 컴퓨터 소리는 포기
    const wantSystem = source !== 'mic' && !!AudioCtx
    const wantMic = source !== 'system'

    // 1) 컴퓨터 소리부터 확보 — 화면 공유 폴백은 클릭 제스처가 살아있는 동안 요청해야 한다
    let systemAudioResult: SystemAudioStartResult = source !== 'mic' && !AudioCtx ? 'unsupported' : 'off'
    let via: SystemAudioVia | undefined
    let systemStream: MediaStream | null = null
    if (wantSystem) {
      // Mac 오디오 도우미가 있으면 '현재 출력 장치+BlackHole'로 자동 전환 — 팝업 없이 캡처
      helperEngagedRef.current = await helperRecordOn()
      const captured = await captureSystemAudio(helperEngagedRef.current)
      systemAudioResult = captured.result
      via = captured.via
      systemStream = captured.stream
    }

    // 컴퓨터 소리 전용 모드에서 소리를 못 얻었으면 녹음을 시작하지 않는다
    if (source === 'system' && systemAudioResult !== 'on') {
      systemStream?.getTracks().forEach((t) => t.stop())
      releaseHelper()
      return { started: false, systemAudio: systemAudioResult, via }
    }

    // 2) 마이크
    let micStream: MediaStream | null = null
    if (wantMic) {
      const audioConstraint: MediaTrackConstraints | boolean = deviceId
        ? { deviceId: { exact: deviceId } }
        : true
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint })
      } catch (err) {
        systemStream?.getTracks().forEach((t) => t.stop())
        releaseHelper()
        throw err
      }
    }
    streamRef.current = micStream

    // 3) 오디오 그래프 — 파형용 AnalyserNode + (컴퓨터 소리 시) 믹싱 버스
    let recordStream = micStream
    if (AudioCtx) {
      const ctx = new AudioCtx()
      audioCtxRef.current = ctx
      const mixBus = ctx.createGain()
      mixBusRef.current = mixBus
      if (micStream) ctx.createMediaStreamSource(micStream).connect(mixBus)
      const node = ctx.createAnalyser()
      node.fftSize = 256
      mixBus.connect(node)
      setAnalyser(node)
      if (source !== 'mic') {
        // 캡처에 실패했더라도 녹음 중 재시도로 붙일 수 있도록 항상 믹스 경로로 녹음.
        // 두 소스 합산 피크가 0dB를 넘어 깨지지 않도록 리미터를 거친다.
        const limiter = ctx.createDynamicsCompressor()
        limiter.threshold.value = -6
        limiter.knee.value = 3
        limiter.ratio.value = 12
        limiter.attack.value = 0.003
        limiter.release.value = 0.25
        const dest = ctx.createMediaStreamDestination()
        mixBus.connect(limiter)
        limiter.connect(dest)
        recordStream = dest.stream
        mixRecordingRef.current = true
      }
      if (systemStream && via) {
        attachSystemStream(systemStream, via)
      }
      void ctx.resume().catch(() => {})
    }
    if (!recordStream) {
      // 도달 불가 방어: mic 모드는 micStream 보장, system/both는 위에서 dest.stream 지정
      systemStream?.getTracks().forEach((t) => t.stop())
      throw new Error('녹음할 오디오 소스가 없습니다.')
    }

    const mimeType = pickMimeType()
    const rec = new MediaRecorder(recordStream, mimeType ? { mimeType } : undefined)
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
    setSystemAudio(systemAudioResult === 'on' ? 'on' : 'off')
    setMicMutedState(false)
    setSystemMutedState(false)
    systemMutedRef.current = false
    void acquireWakeLock() // 녹음 중 화면 꺼짐 방지

    if (intervalRef.current != null) window.clearInterval(intervalRef.current)
    intervalRef.current = window.setInterval(() => {
      setElapsedSec(currentElapsedMs() / 1000)
    }, 250)
    return { started: true, systemAudio: systemAudioResult, via }
  }, [acquireWakeLock, attachSystemStream, captureSystemAudio, currentElapsedMs, releaseHelper])

  /** 녹음 중 마이크 음소거 토글 — 트랙은 유지한 채 해당 구간이 무음으로 기록된다 */
  const setMicMuted = useCallback((muted: boolean) => {
    streamRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = !muted
    })
    setMicMutedState(muted)
  }, [])

  /** 녹음 중 컴퓨터 소리 음소거 토글 */
  const setSystemMuted = useCallback((muted: boolean) => {
    systemMutedRef.current = muted
    for (const ref of [displayStreamRef, loopbackStreamRef]) {
      ref.current?.getAudioTracks().forEach((t) => {
        t.enabled = !muted
      })
    }
    setSystemMutedState(muted)
  }, [])

  const retrySystemAudio = useCallback(async (): Promise<SystemAudioStartResult> => {
    const rec = recorderRef.current
    if (!rec || rec.state === 'inactive') return 'off'
    if (!mixRecordingRef.current) return 'unsupported'
    if (displayStreamRef.current || loopbackStreamRef.current) return 'on' // 이미 캡처 중

    if (!helperEngagedRef.current) {
      helperEngagedRef.current = await helperRecordOn()
    }
    const captured = await captureSystemAudio(helperEngagedRef.current)
    if (captured.result !== 'on' || !captured.stream || !captured.via) return captured.result
    if (!attachSystemStream(captured.stream, captured.via)) {
      captured.stream.getTracks().forEach((t) => t.stop())
      return 'unsupported'
    }
    setSystemAudio('on')
    return 'on'
  }, [attachSystemStream, captureSystemAudio])

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

  return {
    status,
    elapsedSec,
    analyser,
    systemAudio,
    systemSignal,
    micMuted,
    systemMuted,
    setMicMuted,
    setSystemMuted,
    start,
    retrySystemAudio,
    pause,
    resume,
    stop,
    cancel,
  }
}

export default useRecorder
