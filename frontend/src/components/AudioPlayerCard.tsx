import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { BookmarkKind } from '../types'
import { formatClock } from '../utils'
import './AudioPlayerCard.css'

export interface AudioPlayerCardHandle {
  seekTo(sec: number, autoplay?: boolean): void
}

export interface AudioPlayerCardBookmark {
  id: number
  time_sec: number
  title: string
  kind: BookmarkKind
}

export interface AudioPlayerCardProps {
  src: string
  /** webm 등 audio.duration이 Infinity일 때 폴백 */
  durationSec?: number | null
  /** note 제외(시간 있는 memo/mark만) 전달됨 */
  bookmarks: AudioPlayerCardBookmark[]
  /** 없으면 마크 버튼 숨김 */
  onAddMark?: (timeSec: number) => void
}

/** 다운샘플 버킷 수 (~600) */
const PEAK_BUCKETS = 600
/** 점 지름(무음 시 기본 크기) */
const DOT_SIZE = 4
const DOT_GAP = 4
const SLOT = DOT_SIZE + DOT_GAP
/** 패널 좌우 안쪽 여백 */
const PAD_X = 14
const CANVAS_HEIGHT = 120
/** 디코드 실패/로딩 중 폴백 점의 균일 진폭 */
const FALLBACK_AMP = 0.14

const PLAYED_COLOR = 'rgba(37, 99, 235, 1)'
const REMAIN_COLOR = 'rgba(37, 99, 235, 0.3)'
const CURSOR_COLOR = '#1d4ed8'

interface Pin {
  x: number
  timeSec: number
  title: string
  kind: BookmarkKind
}

/** 채널 평균 절대값을 버킷별 피크로 다운샘플 (최대값 기준 정규화) */
function computePeaks(buffer: AudioBuffer, buckets: number): number[] {
  const length = buffer.length
  const channels = buffer.numberOfChannels
  if (length === 0 || channels === 0) return []
  const datas: Float32Array[] = []
  for (let c = 0; c < channels; c++) datas.push(buffer.getChannelData(c))

  const n = Math.min(buckets, length)
  const peaks = new Array<number>(n).fill(0)
  const step = length / n
  for (let i = 0; i < n; i++) {
    const start = Math.floor(i * step)
    const end = Math.min(length, Math.max(start + 1, Math.floor((i + 1) * step)))
    // 긴 오디오 대비 버킷 내부는 건너뛰며 샘플링 (버킷당 최대 ~256 샘플)
    const stride = Math.max(1, Math.floor((end - start) / 256))
    let peak = 0
    for (let j = start; j < end; j += stride) {
      let sum = 0
      for (let c = 0; c < channels; c++) sum += Math.abs(datas[c][j])
      const amp = sum / channels
      if (amp > peak) peak = amp
    }
    peaks[i] = peak
  }

  let max = 0
  for (const p of peaks) if (p > max) max = p
  if (max > 0) for (let i = 0; i < n; i++) peaks[i] = Math.min(1, peaks[i] / max)
  return peaks
}

/** 폭 → 점 슬롯 수/점 트랙 폭(첫 점 시작 ~ 마지막 점 끝) */
function trackMetrics(width: number) {
  const innerW = Math.max(0, width - PAD_X * 2)
  const slotCount = Math.max(2, Math.floor((innerW + DOT_GAP) / SLOT))
  const trackW = slotCount * SLOT - DOT_GAP
  return { slotCount, trackW }
}

/**
 * 레코더 카드 무드의 오디오 재생 UI — 숨긴 <audio> + 점(dot) 파형 패널.
 * - fetch(src) → decodeAudioData → ~600 버킷 피크를 canvas 점 시퀀스로 렌더
 * - 재생된 구간은 진한 파랑, 이후는 연한 파랑, 현재 위치 세로 커서
 * - 파형 클릭/드래그 시크, 북마크 핀(시간 칩) 클릭 시크
 * - ref.seekTo(sec, autoplay)로 외부(스크립트/메모 시간 칩)에서 점프
 */
export const AudioPlayerCard = forwardRef<AudioPlayerCardHandle, AudioPlayerCardProps>(
  function AudioPlayerCard({ src, durationSec, bookmarks, onAddMark }, ref) {
    const audioRef = useRef<HTMLAudioElement | null>(null)
    const panelRef = useRef<HTMLDivElement | null>(null)
    const canvasRef = useRef<HTMLCanvasElement | null>(null)

    const [playing, setPlaying] = useState(false)
    const [currentSec, setCurrentSec] = useState(0)
    const [peaks, setPeaks] = useState<number[] | null>(null)
    const [decodeFailed, setDecodeFailed] = useState(false)
    const [mediaDuration, setMediaDuration] = useState<number | null>(null)
    const [bufferDuration, setBufferDuration] = useState<number | null>(null)
    const [panelWidth, setPanelWidth] = useState(0)

    // duration: audio.duration(유한) → props.durationSec → 디코드 buffer.duration
    const propDuration =
      typeof durationSec === 'number' && isFinite(durationSec) && durationSec > 0
        ? durationSec
        : null
    const duration = mediaDuration ?? propDuration ?? bufferDuration ?? 0

    // draw()가 stale 없이 읽도록 렌더마다 ref 갱신
    const peaksRef = useRef<number[] | null>(null)
    peaksRef.current = peaks
    const durationRef = useRef(0)
    durationRef.current = duration
    const currentRef = useRef(0)
    currentRef.current = currentSec

    // src 변경 시 재생 상태 초기화 (+ 재디코드는 아래 디코드 effect가 담당)
    useEffect(() => {
      setPlaying(false)
      setCurrentSec(0)
      setMediaDuration(null)
    }, [src])

    // fetch → AudioContext.decodeAudioData → 피크 다운샘플 (언마운트/재디코드 시 컨텍스트 close)
    useEffect(() => {
      setPeaks(null)
      setBufferDuration(null)
      setDecodeFailed(false)

      let cancelled = false
      const win = window as unknown as {
        AudioContext?: typeof AudioContext
        webkitAudioContext?: typeof AudioContext
      }
      const Ctor = win.AudioContext ?? win.webkitAudioContext
      if (!Ctor) {
        setDecodeFailed(true)
        return
      }
      let ctx: AudioContext | null = null
      try {
        ctx = new Ctor()
      } catch {
        setDecodeFailed(true)
        return
      }

      // src에 token 쿼리가 포함돼 있어 Authorization 헤더 불필요
      fetch(src)
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          return res.arrayBuffer()
        })
        .then((buf) => ctx!.decodeAudioData(buf))
        .then((buffer) => {
          if (cancelled) return
          setPeaks(computePeaks(buffer, PEAK_BUCKETS))
          if (isFinite(buffer.duration) && buffer.duration > 0) {
            setBufferDuration(buffer.duration)
          }
        })
        .catch(() => {
          // 디코드 실패 → 균일 점 폴백 (재생/시크는 <audio>로 정상 동작)
          if (!cancelled) setDecodeFailed(true)
        })

      return () => {
        cancelled = true
        void ctx?.close().catch(() => {})
      }
    }, [src])

    // <audio> 이벤트 — 메타데이터/재생 상태/진행(timeupdate → rAF 스로틀)
    useEffect(() => {
      const audio = audioRef.current
      if (!audio) return
      let rafId: number | null = null

      const onDuration = () => {
        if (isFinite(audio.duration) && audio.duration > 0) setMediaDuration(audio.duration)
      }
      const onTimeUpdate = () => {
        if (rafId != null) return
        rafId = requestAnimationFrame(() => {
          rafId = null
          setCurrentSec(audio.currentTime)
        })
      }
      const onPlay = () => setPlaying(true)
      const onPause = () => setPlaying(false)
      const onEnded = () => setPlaying(false)

      onDuration()
      audio.addEventListener('loadedmetadata', onDuration)
      audio.addEventListener('durationchange', onDuration)
      audio.addEventListener('timeupdate', onTimeUpdate)
      audio.addEventListener('seeked', onTimeUpdate)
      audio.addEventListener('play', onPlay)
      audio.addEventListener('pause', onPause)
      audio.addEventListener('ended', onEnded)
      return () => {
        if (rafId != null) cancelAnimationFrame(rafId)
        audio.removeEventListener('loadedmetadata', onDuration)
        audio.removeEventListener('durationchange', onDuration)
        audio.removeEventListener('timeupdate', onTimeUpdate)
        audio.removeEventListener('seeked', onTimeUpdate)
        audio.removeEventListener('play', onPlay)
        audio.removeEventListener('pause', onPause)
        audio.removeEventListener('ended', onEnded)
      }
    }, [src])

    // 패널 폭 추적 (핀 위치 계산용)
    useEffect(() => {
      const measure = () => setPanelWidth(panelRef.current?.clientWidth ?? 0)
      measure()
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }, [])

    const draw = useCallback(() => {
      const panel = panelRef.current
      const canvas = canvasRef.current
      if (!panel || !canvas) return
      const width = panel.clientWidth
      if (width <= 0) return

      const dpr = window.devicePixelRatio || 1
      const pxW = Math.round(width * dpr)
      const pxH = Math.round(CANVAS_HEIGHT * dpr)
      if (canvas.width !== pxW) canvas.width = pxW
      if (canvas.height !== pxH) canvas.height = pxH

      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, CANVAS_HEIGHT)

      const mid = CANVAS_HEIGHT / 2

      // 세로 중앙의 가는 회색 수평선
      ctx.fillStyle = 'rgba(100, 116, 139, 0.28)'
      ctx.fillRect(0, mid - 0.5, width, 1)

      const { slotCount, trackW } = trackMetrics(width)
      const dur = durationRef.current
      const progress = dur > 0 ? Math.min(1, Math.max(0, currentRef.current / dur)) : 0
      const cursorX = PAD_X + progress * trackW
      const data = peaksRef.current

      // 점/캡슐 시퀀스 — 진폭 비례 높이, 재생 위치 기준 좌 진한/우 연한 파랑
      for (let i = 0; i < slotCount; i++) {
        let amp = FALLBACK_AMP
        if (data && data.length > 0) {
          const from = Math.floor((i * data.length) / slotCount)
          const to = Math.max(from + 1, Math.floor(((i + 1) * data.length) / slotCount))
          amp = 0
          for (let j = from; j < to && j < data.length; j++) {
            if (data[j] > amp) amp = data[j]
          }
        }
        const h = Math.max(DOT_SIZE, amp * (CANVAS_HEIGHT - 28))
        const x = PAD_X + i * SLOT
        const played = x + DOT_SIZE / 2 <= cursorX
        ctx.fillStyle = played ? PLAYED_COLOR : REMAIN_COLOR
        ctx.beginPath()
        ctx.roundRect(x, mid - h / 2, DOT_SIZE, h, DOT_SIZE / 2)
        ctx.fill()
      }

      // 현재 위치 얇은 세로 커서
      if (dur > 0) {
        ctx.fillStyle = CURSOR_COLOR
        ctx.fillRect(cursorX - 1, 8, 2, CANVAS_HEIGHT - 16)
      }
    }, [])

    useEffect(() => {
      draw()
    }, [draw, peaks, decodeFailed, duration, currentSec, panelWidth])

    useEffect(() => {
      const onResize = () => draw()
      window.addEventListener('resize', onResize)
      return () => window.removeEventListener('resize', onResize)
    }, [draw])

    const applySeek = useCallback((sec: number, autoplay?: boolean) => {
      const audio = audioRef.current
      if (!audio) return
      const dur = durationRef.current
      const t = Math.max(0, dur > 0 ? Math.min(sec, dur) : sec)
      try {
        audio.currentTime = t
      } catch {
        // 아직 시크 불가 상태면 표시만 갱신
      }
      setCurrentSec(t)
      if (autoplay) void audio.play().catch(() => {})
    }, [])

    useImperativeHandle(ref, () => ({ seekTo: applySeek }), [applySeek])

    // ---- 파형 클릭/드래그 시크 ----
    const draggingRef = useRef(false)

    const seekFromPointer = useCallback(
      (clientX: number) => {
        const panel = panelRef.current
        if (!panel) return
        const dur = durationRef.current
        if (dur <= 0) return
        const rect = panel.getBoundingClientRect()
        const { trackW } = trackMetrics(rect.width)
        if (trackW <= 0) return
        const ratio = Math.min(1, Math.max(0, (clientX - rect.left - PAD_X) / trackW))
        applySeek(ratio * dur)
      },
      [applySeek],
    )

    const onPanelPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      draggingRef.current = true
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        // 포인터 캡처 미지원 환경 무시
      }
      seekFromPointer(e.clientX)
    }

    const onPanelPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return
      seekFromPointer(e.clientX)
    }

    const onPanelPointerUp = () => {
      draggingRef.current = false
    }

    // ---- 북마크 핀 (시간 칩, 클릭 시크) ----
    const pins = useMemo<Pin[]>(() => {
      if (panelWidth <= 0 || duration <= 0) return []
      const { trackW } = trackMetrics(panelWidth)
      const next: Pin[] = []
      for (const b of bookmarks) {
        if (b.time_sec < 0 || b.time_sec > duration + 0.5) continue
        const raw = PAD_X + (Math.min(b.time_sec, duration) / duration) * trackW
        next.push({
          x: Math.min(Math.max(raw, 4), panelWidth - 4),
          timeSec: b.time_sec,
          title: b.title,
          kind: b.kind,
        })
      }
      return next
    }, [bookmarks, duration, panelWidth])

    const togglePlay = () => {
      const audio = audioRef.current
      if (!audio) return
      if (audio.paused) void audio.play().catch(() => {})
      else audio.pause()
    }

    return (
      <div className="card audio-player-card">
        {/* 실제 재생은 숨긴 audio 엘리먼트가 담당 */}
        <audio ref={audioRef} className="audio-player-audio" src={src} preload="metadata" />

        <div className="audio-player-timer">
          <span className="audio-player-current">{formatClock(currentSec)}</span>
          <span className="audio-player-total">/ {formatClock(duration)}</span>
        </div>

        <div
          ref={panelRef}
          className="audio-player-wave"
          role="slider"
          aria-label="재생 위치"
          aria-valuemin={0}
          aria-valuemax={Math.floor(duration)}
          aria-valuenow={Math.floor(currentSec)}
          onPointerDown={onPanelPointerDown}
          onPointerMove={onPanelPointerMove}
          onPointerUp={onPanelPointerUp}
          onPointerCancel={onPanelPointerUp}
        >
          <canvas ref={canvasRef} className="audio-player-canvas" />
          {pins.map((pin, i) => (
            <div key={`${pin.timeSec}-${i}`} className="audio-player-pin" style={{ left: pin.x }}>
              <button
                type="button"
                className="audio-player-pin-chip"
                title={pin.title}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => applySeek(pin.timeSec)}
              >
                {pin.kind === 'mark' ? '🔖' : '📝'} {formatClock(pin.timeSec)}
              </button>
              <span className="audio-player-pin-line" />
            </div>
          ))}
        </div>

        <div className="audio-player-controls">
          <button className="btn btn-primary btn-lg audio-player-play" onClick={togglePlay}>
            {playing ? '⏸ 일시정지' : '▶ 재생'}
          </button>
          {onAddMark && (
            <button
              className="btn btn-soft"
              onClick={() => onAddMark(audioRef.current?.currentTime ?? currentSec)}
              title="현재 재생 시간에 마크를 추가합니다"
            >
              🔖 마크 추가
            </button>
          )}
        </div>
      </div>
    )
  },
)

export default AudioPlayerCard
