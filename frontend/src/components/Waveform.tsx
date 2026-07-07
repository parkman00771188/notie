import { useCallback, useEffect, useRef, useState } from 'react'

export interface WaveformMark {
  timeSec: number
  label: string
}

export interface WaveformProps {
  analyser: AnalyserNode | null
  active: boolean
  marks: WaveformMark[]
  elapsedSec: number
}

const SAMPLE_INTERVAL_MS = 250
/** 점 지름(무음 시 기본 크기) */
const DOT_SIZE = 4
const DOT_GAP = 4
const SLOT = DOT_SIZE + DOT_GAP
/** 패널 좌우 안쪽 여백 */
const PAD_X = 14
const CANVAS_HEIGHT = 120
/** 최근 10분치(250ms × 2400) 진폭 샘플만 유지 */
const MAX_HISTORY = 2400

interface AmpSample {
  amp: number
  t: number
}

interface Pin {
  x: number
  label: string
}

/**
 * 라이브 점(dot) 파형 — 연파랑 전폭 패널(스타일은 RecordPage.css).
 * - 세로 중앙의 가는 회색 수평선 위에 파란 점 시퀀스가 왼쪽부터 진행 (250ms당 1점)
 * - 진폭이 클수록 점이 세로 캡슐로 확장되고 색이 진해짐
 * - 폭을 넘으면 왼쪽으로 스크롤(최근 구간만 표시)
 * - marks(북마크)는 파형 위 핀(🔖 + 시간 라벨 칩)으로 표시
 * - active=false(일시정지)면 샘플링을 멈추고 페이드 처리
 */
export function Waveform({ analyser, active, marks, elapsedSec }: WaveformProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const historyRef = useRef<AmpSample[]>([])
  const elapsedRef = useRef(elapsedSec)
  elapsedRef.current = elapsedSec
  const marksRef = useRef(marks)
  marksRef.current = marks
  const [pins, setPins] = useState<Pin[]>([])

  const draw = useCallback(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return
    const width = wrap.clientWidth
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

    // 표시 가능한 점 개수만큼 최근 샘플 유지 (넘치면 왼쪽으로 스크롤)
    const innerW = width - PAD_X * 2
    const capacity = Math.max(2, Math.floor(innerW / SLOT))
    const visible = historyRef.current.slice(-capacity)

    // 파란 점 시퀀스 — 진폭이 크면 세로 캡슐로 확장 + 진해짐
    for (let i = 0; i < visible.length; i++) {
      const amp = visible[i].amp
      const h = Math.max(DOT_SIZE, amp * (CANVAS_HEIGHT - 28))
      const x = PAD_X + i * SLOT
      const y = mid - h / 2
      const alpha = Math.min(1, 0.38 + amp * 0.62)
      ctx.fillStyle = `rgba(37, 99, 235, ${alpha.toFixed(3)})`
      ctx.beginPath()
      ctx.roundRect(x, y, DOT_SIZE, h, DOT_SIZE / 2)
      ctx.fill()
    }

    // 보이는 시간 창 안의 북마크 핀 위치 계산
    if (visible.length >= 2) {
      const t0 = visible[0].t
      const t1 = visible[visible.length - 1].t
      const span = Math.max(t1 - t0, 0.001)
      const innerWidth = (visible.length - 1) * SLOT
      const next: Pin[] = []
      for (const m of marksRef.current) {
        if (m.timeSec < t0 || m.timeSec > t1 + SAMPLE_INTERVAL_MS / 1000) continue
        const raw = PAD_X + ((m.timeSec - t0) / span) * innerWidth + DOT_SIZE / 2
        next.push({ x: Math.min(Math.max(raw, 4), width - 4), label: m.label })
      }
      setPins(next)
    } else {
      setPins([])
    }
  }, [])

  // 새 녹음(새 analyser)이 시작되면 히스토리 초기화
  useEffect(() => {
    historyRef.current = []
  }, [analyser])

  // 250ms 간격 진폭 샘플링 (일시정지 중에는 중단)
  useEffect(() => {
    if (!analyser || !active) return
    const buf = new Uint8Array(analyser.fftSize)
    const sample = () => {
      analyser.getByteTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128
        sum += v * v
      }
      const rms = Math.sqrt(sum / buf.length)
      const amp = Math.min(1, rms * 3.2)
      const hist = historyRef.current
      hist.push({ amp, t: elapsedRef.current })
      if (hist.length > MAX_HISTORY) hist.splice(0, hist.length - MAX_HISTORY)
      draw()
    }
    sample()
    const id = window.setInterval(sample, SAMPLE_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [analyser, active, draw])

  // 마크/상태 변경 시 재렌더
  useEffect(() => {
    draw()
  }, [draw, marks, active])

  // 리사이즈 대응
  useEffect(() => {
    const onResize = () => draw()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [draw])

  return (
    <div ref={wrapRef} className={`waveform${active ? '' : ' waveform-paused'}`}>
      <canvas ref={canvasRef} className="waveform-canvas" />
      {pins.map((pin, i) => (
        <div key={`${pin.label}-${i}`} className="waveform-pin" style={{ left: pin.x }}>
          <span className="waveform-pin-chip">🔖 {pin.label}</span>
          <span className="waveform-pin-line" />
        </div>
      ))}
    </div>
  )
}

export default Waveform
