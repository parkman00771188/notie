import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent, KeyboardEvent, MutableRefObject, ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { AvatarStack } from '../components/Avatar'
import { useConfirm } from '../components/confirm'
import Modal from '../components/Modal'
import { ParticipantPicker } from '../components/ParticipantPicker'
import { RecentMeetingsPanel } from '../components/RecentMeetingsPanel'
import { TagPicker } from '../components/TagPicker'
import { Waveform } from '../components/Waveform'
import { findLoopbackDevice, isLoopbackDevice, requestDisplayAudio, useRecorder } from '../hooks/useRecorder'
import type { RecordSource, SystemAudioStartResult } from '../hooks/useRecorder'
import { helperRecordOff, helperRecordOn, helperStatus } from '../recordModeHelper'
import type { HelperStatus } from '../recordModeHelper'
import type { Bookmark, Participant } from '../types'
import { formatClock, formatKoreanDateTime, isValidDateInput, readAudioDuration } from '../utils'
import './RecordPage.css'

const DEFAULT_TITLE = '새 회의 기록'
const ACCEPT_AUDIO = 'audio/*,.mp3,.m4a,.wav,.webm,.ogg,.mp4,.aac,.flac'
const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.wav', '.webm', '.ogg', '.mp4', '.aac', '.flac']
const RECORDING_NAVIGATION_MESSAGE = '녹음 중에는 취소 또는 종료 후 이동할 수 있어요.'
const PREFERRED_MIC_ID_KEY = 'notie.preferredMicId'
const PREFERRED_MIC_LABEL_KEY = 'notie.preferredMicLabel'
const BLACKHOLE_INSTALL_CMD = 'brew install blackhole-2ch'
const BLACKHOLE_DOWNLOAD_URL = 'https://existential.audio/blackhole/'

/** macOS 시스템 설정의 '화면 및 시스템 오디오 녹음' 패널 딥링크 */
const MAC_SCREEN_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
const IS_MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent)
const IS_SAFARI =
  typeof navigator !== 'undefined' &&
  /safari/i.test(navigator.userAgent) &&
  !/chrome|chromium|crios|edg|android/i.test(navigator.userAgent)
const CAN_DISPLAY_CAPTURE =
  typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia
/** 화면 공유로 '소리'까지 받을 수 있는 환경 — Safari는 getDisplayMedia가 있어도 오디오 미지원 */
const CAN_DISPLAY_AUDIO = CAN_DISPLAY_CAPTURE && !IS_SAFARI

/** 모바일 기기 — 컴퓨터 소리 캡처(화면 공유 오디오·가상 오디오 장치)가 불가능해 마이크만 노출 */
const IS_MOBILE_DEVICE =
  typeof navigator !== 'undefined' &&
  (/android|iphone|ipad|ipod|windows phone|mobile/i.test(navigator.userAgent) ||
    // iPadOS 13+는 데스크톱(Macintosh) UA를 쓰므로 터치 지점 수로 구분
    (/mac/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1))

/** 공유 창 안내문에 쓸 브라우저별 명칭 — 공유 창의 탭 패널 이름이 브라우저마다 다르다 */
const BROWSER = (() => {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  if (/edg\//i.test(ua)) return { name: 'Edge', tab: 'Microsoft Edge 탭', shareAudioOk: true }
  if (/whale\//i.test(ua)) return { name: 'Whale', tab: 'Whale 탭', shareAudioOk: true }
  if (/opr\//i.test(ua)) return { name: 'Opera', tab: '브라우저 탭', shareAudioOk: true }
  if (/firefox\//i.test(ua)) return { name: 'Firefox', tab: '창', shareAudioOk: false }
  if (/chrome|chromium|crios/i.test(ua)) return { name: 'Chrome', tab: 'Chrome 탭', shareAudioOk: true }
  return { name: '브라우저', tab: '브라우저 탭', shareAudioOk: true }
})()

// 녹음 소스는 세션 간 저장하지 않는다 — 페이지를 열 때마다 기본은 '마이크'
function initialRecordSource(): RecordSource {
  return 'mic'
}

const SOURCE_OPTIONS: { value: RecordSource; icon: string; title: string; desc: string }[] = [
  { value: 'mic', icon: '🎙️', title: '마이크', desc: '내 목소리만 마이크로 녹음해요.' },
  { value: 'system', icon: '🔊', title: '컴퓨터 소리', desc: '화상회의·영상 등 컴퓨터에서 나는 소리만 녹음해요.' },
  { value: 'both', icon: '🎙️＋🔊', title: '마이크 + 컴퓨터 소리', desc: '내 목소리와 컴퓨터 소리를 함께 녹음해요.' },
]

/** 컴퓨터 소리 캡처에 실패한 경우의 안내 (모달) */
const SYSTEM_AUDIO_ISSUES: Partial<Record<SystemAudioStartResult, { title: string; body: string }>> = {
  unsupported: {
    title: '컴퓨터 소리를 가져올 수 없어요',
    body: '이 브라우저는 화면 공유 소리 녹음을 지원하지 않아요.\nChrome 또는 Edge를 사용하거나, 녹음 설정에서 안내하는 가상 오디오 장치(BlackHole 등)를 설치하면 팝업 없이 컴퓨터 소리를 녹음할 수 있어요.\n\n가상 오디오 장치를 이미 설치했다면 브라우저의 마이크 권한을 허용해야 장치를 인식할 수 있어요 — 권한을 허용한 뒤 [다시 시도]를 눌러주세요.',
  },
  denied: {
    title: '화면 공유가 시작되지 않았어요',
    body: '공유 창에서 취소되었거나 요청이 차단됐어요.\n[다시 시도]를 누른 뒤 공유 창에서 탭(또는 화면)을 고르고 [공유] 버튼까지 눌러주세요.',
  },
  'system-denied': {
    title: 'macOS가 화면 녹화를 막고 있어요',
    body: `[시스템 설정 열기]로 이동해 [화면 및 시스템 오디오 녹음]에서 사용 중인 브라우저를 허용해주세요. 적용하려면 브라우저를 완전히 종료했다가 다시 실행해야 해요.\n\n지금 당장은 [다시 시도]에서 [${BROWSER.tab}] 공유를 선택하면 이 권한 없이도 탭 소리를 녹음할 수 있어요.`,
  },
  'no-audio': {
    title: '공유에 소리가 포함되지 않았어요',
    body: `화면은 공유됐지만 소리가 들어오지 않았어요.\n[창] 공유는 소리를 지원하지 않고, Mac에서는 [전체 화면]도 안 될 수 있어요.\n[다시 시도]를 눌러 회의·영상이 열려 있는 [${BROWSER.tab}]을 고르고 '오디오도 공유'를 켜주세요.`,
  },
}
const RECORDING_NAVIGATION_TARGET_SELECTOR = [
  'a[href]',
  '.sidebar-new button',
  '.mobile-logo-btn',
  '.mobile-more-logo',
  '.sidebar-user-menu-item',
  '.mobile-user-menu-item',
].join(',')

function localDateTimeString(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`
}

function startedAtFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get('started_at')
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null

  const dateValue = value.slice(0, 10)
  const hourValue = Number(value.slice(11, 13))
  const minuteValue = Number(value.slice(14, 16))
  if (!isValidDateInput(dateValue) || hourValue < 0 || hourValue > 23 || minuteValue < 0 || minuteValue > 59) {
    return null
  }
  return value
}

function isAudioFile(file: File): boolean {
  if (file.type.startsWith('audio/')) return true
  const lower = file.name.toLowerCase()
  return AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext))
}


function sortByTime(list: Bookmark[]): Bookmark[] {
  return [...list].sort((a, b) => a.time_sec - b.time_sec)
}

export default function RecordPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const recorder = useRecorder()
  const confirm = useConfirm()

  // ---- 회의 메타 ----
  const [title, setTitle] = useState(DEFAULT_TITLE)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState(DEFAULT_TITLE)
  const [tag, setTag] = useState<string | null>(null)
  const [participants, setParticipants] = useState<Participant[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [startedAt, setStartedAt] = useState(() => startedAtFromSearch(location.search) ?? localDateTimeString())
  const [editingDate, setEditingDate] = useState(false)
  const [dateDraft, setDateDraft] = useState('')
  const [hourDraft, setHourDraft] = useState(9)
  const [minuteDraft, setMinuteDraft] = useState(0)

  // ---- 녹음/북마크 ----
  const [meetingId, setMeetingId] = useState<number | null>(null)
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [memoText, setMemoText] = useState('')
  const [withTime, setWithTime] = useState(true)
  const memoAreaRef = useRef<HTMLTextAreaElement>(null)
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const lastNavigationAlertRef = useRef(0)
  const [recordMode, setRecordMode] = useState<'idle' | 'manual'>('idle')
  const [manualText, setManualText] = useState('')
  const [manualSubmitting, setManualSubmitting] = useState(false)
  const [uploadDragActive, setUploadDragActive] = useState(false)
  const [starting, setStarting] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [cancellingRecording, setCancellingRecording] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [micTestOpen, setMicTestOpen] = useState(false)
  const [micTestLoading, setMicTestLoading] = useState(false)
  const [micTestError, setMicTestError] = useState('')
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedMicId, setSelectedMicId] = useState('')
  const [confirmedMicId, setConfirmedMicId] = useState(() => localStorage.getItem(PREFERRED_MIC_ID_KEY) ?? '')
  const [confirmedMicLabel, setConfirmedMicLabel] = useState(() => localStorage.getItem(PREFERRED_MIC_LABEL_KEY) ?? '')
  const [micLevel, setMicLevel] = useState(0)
  const [recordSource, setRecordSource] = useState<RecordSource>(initialRecordSource)
  /** 감지된 가상 오디오 장치(BlackHole 등) — 있으면 팝업 없이 컴퓨터 소리 녹음 */
  const [loopbackDevice, setLoopbackDevice] = useState<{ deviceId: string; label: string } | null>(null)
  const [sysLevel, setSysLevel] = useState(0)
  /** 컴퓨터 소리 캡처 실패 안내 모달 — null이면 닫힘 */
  const [sysAudioIssue, setSysAudioIssue] = useState<SystemAudioStartResult | null>(null)
  const [brewCopied, setBrewCopied] = useState(false)
  /** Mac 오디오 도우미 상태 — 연결되어 있으면 녹음 시 출력이 자동 전환된다 */
  const [audioHelper, setAudioHelper] = useState<HelperStatus | null>(null)
  const micTestStreamRef = useRef<MediaStream | null>(null)
  const micTestAudioContextRef = useRef<AudioContext | null>(null)
  const micTestRafRef = useRef<number | null>(null)
  const sysTestStreamRef = useRef<MediaStream | null>(null)
  const sysTestAudioContextRef = useRef<AudioContext | null>(null)
  const sysTestRafRef = useRef<number | null>(null)
  /** 모달 미터를 위해 도우미로 라우팅을 켜뒀는지 — 닫을 때 원래 출력으로 복귀시킨다 */
  const modalHelperEngagedRef = useRef(false)
  /** 녹음 설정에서 미리 연결해둔 화면 공유 스트림 — 녹음 시작 시 팝업 없이 재사용 */
  const presetShareRef = useRef<MediaStream | null>(null)
  const [presetShareOn, setPresetShareOn] = useState(false)
  const [presetShareError, setPresetShareError] = useState('')

  // ---- 메모 ⋯ 메뉴 / 인라인 수정 ----
  const [menuOpenId, setMenuOpenId] = useState<number | null>(null)
  const [editingBookmarkId, setEditingBookmarkId] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState('')

  const isLive = recorder.status === 'recording' || recorder.status === 'paused'
  const canMemo = isLive && meetingId != null
  const processing = uploading || manualSubmitting || cancellingRecording

  const stopMicTest = useCallback(() => {
    if (micTestRafRef.current != null) {
      window.cancelAnimationFrame(micTestRafRef.current)
      micTestRafRef.current = null
    }
    micTestStreamRef.current?.getTracks().forEach((track) => track.stop())
    micTestStreamRef.current = null
    void micTestAudioContextRef.current?.close().catch(() => {})
    micTestAudioContextRef.current = null
    setMicLevel(0)
  }, [])

  /** 스트림의 입력 레벨을 rAF로 갱신하는 미터 — 마이크/컴퓨터 소리 테스트 공용 */
  const startLevelMeter = useCallback(
    (
      stream: MediaStream,
      ctxRef: MutableRefObject<AudioContext | null>,
      rafRef: MutableRefObject<number | null>,
      onLevel: (updater: (prev: number) => number) => void,
    ) => {
      const AudioContextCtor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AudioContextCtor) {
        setMicTestError('이 브라우저에서는 입력 레벨을 표시할 수 없어요.')
        return
      }

      const audioContext = new AudioContextCtor()
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.72
      const source = audioContext.createMediaStreamSource(stream)
      source.connect(analyser)
      const data = new Uint8Array(analyser.frequencyBinCount)
      ctxRef.current = audioContext

      const tick = () => {
        analyser.getByteTimeDomainData(data)
        let sum = 0
        for (const value of data) {
          const normalized = (value - 128) / 128
          sum += normalized * normalized
        }
        const rms = Math.sqrt(sum / data.length)
        const nextLevel = Math.min(1, Math.max(0, (rms - 0.012) * 9))
        onLevel((prev) => prev * 0.68 + nextLevel * 0.32)
        rafRef.current = window.requestAnimationFrame(tick)
      }

      tick()
    },
    [],
  )

  const startMicTestStream = useCallback(
    async (deviceId?: string) => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setMicTestError('이 브라우저에서는 마이크 테스트를 사용할 수 없어요.')
        return
      }

      stopMicTest()
      setMicTestLoading(true)
      setMicTestError('')

      try {
        const audioConstraint: MediaTrackConstraints | boolean = deviceId
          ? { deviceId: { exact: deviceId } }
          : true
        const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint })
        micTestStreamRef.current = stream
        startLevelMeter(stream, micTestAudioContextRef, micTestRafRef, setMicLevel)

        const devices = await navigator.mediaDevices.enumerateDevices()
        // 가상 오디오 장치(BlackHole 등)는 마이크가 아니므로 목록에서 제외 — 컴퓨터 소리 옵션이 따로 처리
        const inputs = devices.filter(
          (device) => device.kind === 'audioinput' && !isLoopbackDevice(device),
        )
        setMicDevices(inputs)
        if (inputs.length === 0) {
          setMicTestError('사용 가능한 마이크를 찾지 못했어요.')
        }
        const activeDeviceId = deviceId || stream.getAudioTracks()[0]?.getSettings().deviceId || inputs[0]?.deviceId || ''
        setSelectedMicId(activeDeviceId)
      } catch (err) {
        stopMicTest()
        setMicTestError(
          err instanceof Error && err.name === 'NotAllowedError'
            ? '마이크 권한이 차단되어 있어요. 브라우저 권한을 허용한 뒤 다시 시도해주세요.'
            : '마이크를 불러오지 못했어요. 연결 상태와 브라우저 권한을 확인해주세요.',
        )
      } finally {
        setMicTestLoading(false)
      }
    },
    [startLevelMeter, stopMicTest],
  )

  const stopSystemTest = useCallback(() => {
    if (sysTestRafRef.current != null) {
      window.cancelAnimationFrame(sysTestRafRef.current)
      sysTestRafRef.current = null
    }
    sysTestStreamRef.current?.getTracks().forEach((track) => track.stop())
    sysTestStreamRef.current = null
    void sysTestAudioContextRef.current?.close().catch(() => {})
    sysTestAudioContextRef.current = null
    setSysLevel(0)
  }, [])

  /** 모달 미터용으로 켜둔 녹음 라우팅을 원래 출력으로 복귀 */
  const releaseModalHelper = useCallback(() => {
    if (modalHelperEngagedRef.current) {
      modalHelperEngagedRef.current = false
      helperRecordOff()
    }
  }, [])

  /** 미리 연결한 공유 스트림 정리(트랙 중지) */
  const clearPresetShare = useCallback(() => {
    presetShareRef.current?.getTracks().forEach((t) => t.stop())
    presetShareRef.current = null
    setPresetShareOn(false)
    setPresetShareError('')
  }, [])

  /** 공유 스트림 소유권을 레코더로 넘길 때 — 트랙은 중지하지 않고 꺼내온다 */
  const takePresetShare = useCallback((): MediaStream | undefined => {
    const stream = presetShareRef.current
    presetShareRef.current = null
    setPresetShareOn(false)
    setPresetShareError('')
    return stream ?? undefined
  }, [])

  /** 가상 오디오 장치를 찾아 컴퓨터 소리 레벨 미터 시작 — 없으면 안내만 표시 */
  const startSystemTestStream = useCallback(async () => {
    stopSystemTest()
    // 미리 연결해둔 공유 스트림이 살아있으면 그 미터를 그대로 사용
    const presetTrack = presetShareRef.current?.getAudioTracks()[0]
    if (presetShareRef.current && presetTrack && presetTrack.readyState === 'live') {
      startLevelMeter(presetShareRef.current, sysTestAudioContextRef, sysTestRafRef, setSysLevel)
      return
    }
    const helper = await helperStatus()
    setAudioHelper(helper)
    // 도우미가 있으면 모달을 보는 동안 잠깐 녹음 라우팅을 켜서 미터가 실제 레벨을 보여준다
    if (helper?.blackhole && (await helperRecordOn())) {
      modalHelperEngagedRef.current = true
    }
    const loopback = await findLoopbackDevice()
    setLoopbackDevice(
      loopback ? { deviceId: loopback.deviceId, label: loopback.label || '가상 오디오 장치' } : null,
    )
    if (!loopback) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: loopback.deviceId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      })
      sysTestStreamRef.current = stream
      startLevelMeter(stream, sysTestAudioContextRef, sysTestRafRef, setSysLevel)
    } catch {
      /* 레벨 미터 실패는 치명적이지 않음 — 안내 문구는 그대로 표시 */
    }
  }, [startLevelMeter, stopSystemTest])

  /**
   * 화면 공유 미리 연결 — 가이드 팝업으로 순서를 안내하고, 확인 시 곧바로 공유 창을 연다.
   * 성공하면 스트림을 붙잡아두고 미터에 연결 — 녹음 시작 때 팝업 없이 이 스트림을 쓴다.
   */
  const startShareGuide = async () => {
    setPresetShareError('')
    const ok = await confirm({
      title: '컴퓨터 소리 연결',
      message: `확인을 누르면 화면 공유 선택 창이 열려요.\n\n1. [${BROWSER.tab}]에서 회의·영상이 열려 있는 탭 선택\n   (Google Meet도 Meet이 열린 탭을 고르면 돼요)\n2. '오디오도 공유' 스위치 켜기\n3. [공유] 버튼 누르기\n\n⚠️ [창] 공유는 소리가 담기지 않고, Mac에서는 [전체 화면]도 소리가 안 될 수 있어요 — 탭 선택이 가장 확실해요.\n\n연결해두면 녹음 시작 시 팝업 없이 바로 시작되고, 컴퓨터 소리 음량을 미리 확인할 수 있어요.${
        BROWSER.shareAudioOk
          ? ''
          : `\n\n⚠️ ${BROWSER.name}는 화면 공유 소리 캡처를 지원하지 않을 수 있어요 — Chrome 또는 Edge 사용을 권장해요.`
      }`,
      confirmLabel: '확인 — 공유 창 열기',
    })
    if (!ok) return
    const captured = await requestDisplayAudio()
    if (captured.result === 'on' && captured.stream) {
      clearPresetShare()
      presetShareRef.current = captured.stream
      setPresetShareOn(true)
      captured.track?.addEventListener('ended', () => {
        // 브라우저의 '공유 중지' 등으로 연결이 끊긴 경우
        presetShareRef.current = null
        setPresetShareOn(false)
      })
      stopSystemTest()
      startLevelMeter(captured.stream, sysTestAudioContextRef, sysTestRafRef, setSysLevel)
    } else {
      setPresetShareError(
        captured.result === 'no-audio'
          ? `공유는 됐지만 소리가 포함되지 않았어요 — [창] 공유는 소리를 지원하지 않고, Mac은 [전체 화면]도 안 될 수 있어요. [지금 연결하기]로 다시 열어 회의·영상이 있는 [${BROWSER.tab}]을 고르고 '오디오도 공유'를 켜주세요.`
          : '공유가 취소되었어요. [지금 연결하기]로 다시 시도할 수 있어요.',
      )
    }
  }

  /** 소스 선택 직후, 화면 공유 경로 환경이면 미리 연결 가이드를 띄운다 */
  const maybeOfferShareGuide = async () => {
    if (!CAN_DISPLAY_AUDIO) return
    const presetTrack = presetShareRef.current?.getAudioTracks()[0]
    if (presetTrack && presetTrack.readyState === 'live') return // 이미 연결됨
    const helper = await helperStatus()
    if (helper?.blackhole) return // 도우미가 자동 전환 — 공유 연결 불필요
    await startShareGuide()
  }

  const openMicTest = () => {
    if (starting || uploading || isLive) return
    setSelectedMicId(confirmedMicId)
    setMicTestOpen(true)
    void (async () => {
      // 마이크 권한을 먼저 얻어야 enumerateDevices에서 가상 오디오 장치 라벨을 읽을 수 있다
      await startMicTestStream(confirmedMicId || undefined)
      if (recordSource !== 'mic') await startSystemTestStream()
    })()
  }

  const closeMicTest = useCallback(() => {
    setMicTestOpen(false)
    setMicTestError('')
    stopMicTest()
    stopSystemTest()
    releaseModalHelper()
  }, [releaseModalHelper, stopMicTest, stopSystemTest])

  const handleSelectMic = (deviceId: string) => {
    setSelectedMicId(deviceId)
    void startMicTestStream(deviceId)
  }

  const handleSelectSource = (source: RecordSource) => {
    setRecordSource(source)
    if (source !== 'mic') {
      void startSystemTestStream()
      void maybeOfferShareGuide()
    } else {
      stopSystemTest()
      releaseModalHelper()
      clearPresetShare()
    }
  }

  const handleConfirmMic = () => {
    if (recordSource === 'system') {
      // 컴퓨터 소리 전용 — 마이크 선택이 필요 없다
      closeMicTest()
      return
    }
    const device = micDevices.find((item) => item.deviceId === selectedMicId)
    if (!selectedMicId || !device) {
      setMicTestError('녹음에 사용할 마이크를 선택해주세요.')
      return
    }
    const label = device.label || '선택한 마이크'
    setConfirmedMicId(selectedMicId)
    setConfirmedMicLabel(label)
    localStorage.setItem(PREFERRED_MIC_ID_KEY, selectedMicId)
    localStorage.setItem(PREFERRED_MIC_LABEL_KEY, label)
    closeMicTest()
  }

  const selectedSourceOption =
    SOURCE_OPTIONS.find((option) => option.value === recordSource) ?? SOURCE_OPTIONS[0]

  const copyBlackholeCommand = async () => {
    try {
      await navigator.clipboard.writeText(BLACKHOLE_INSTALL_CMD)
      setBrewCopied(true)
      window.setTimeout(() => setBrewCopied(false), 1600)
    } catch {
      /* 클립보드 미지원 브라우저는 무시 — 명령어가 화면에 그대로 보인다 */
    }
  }

  useEffect(() => {
    return () => {
      stopMicTest()
      stopSystemTest()
      releaseModalHelper()
      clearPresetShare()
    }
  }, [clearPresetShare, releaseModalHelper, stopMicTest, stopSystemTest])

  // 녹음/업로드 중 새로고침/탭 닫기 경고
  useEffect(() => {
    if (!isLive && !processing) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = RECORDING_NAVIGATION_MESSAGE
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isLive, processing])

  // 녹음 중에는 취소/종료를 거치지 않은 화면 이동을 막는다.
  useEffect(() => {
    if (!isLive) return

    const showBlockedMessage = () => {
      const now = Date.now()
      if (now - lastNavigationAlertRef.current < 900) return
      lastNavigationAlertRef.current = now
      window.alert(RECORDING_NAVIGATION_MESSAGE)
    }

    const pushRecordingGuard = () => {
      const currentState = window.history.state
      const state =
        currentState && typeof currentState === 'object'
          ? { ...currentState, notieRecordingGuard: true }
          : { notieRecordingGuard: true }
      window.history.pushState(state, '', window.location.href)
    }

    pushRecordingGuard()

    const blockEvent = (event: Event) => {
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      showBlockedMessage()
    }

    const handlePopState = (event: PopStateEvent) => {
      blockEvent(event)
      pushRecordingGuard()
    }

    const handleClickCapture = (event: globalThis.MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null
      const navTarget = target?.closest(RECORDING_NAVIGATION_TARGET_SELECTOR)
      if (!navTarget) return

      const anchor = (navTarget instanceof HTMLAnchorElement
        ? navTarget
        : navTarget.closest('a[href]')) as HTMLAnchorElement | null
      if (anchor) {
        const href = anchor.getAttribute('href')
        if (!href || href.startsWith('#')) return
        const targetUrl = new URL(anchor.href)
        const samePage =
          targetUrl.pathname === window.location.pathname &&
          targetUrl.search === window.location.search &&
          targetUrl.hash === window.location.hash
        if (samePage) return
      }

      blockEvent(event)
    }

    const handleKeyDownCapture = (event: globalThis.KeyboardEvent) => {
      const historyKey =
        event.key === 'BrowserBack' ||
        event.key === 'BrowserForward' ||
        ((event.altKey || event.metaKey) && (event.key === 'ArrowLeft' || event.key === 'ArrowRight'))
      if (!historyKey) return
      blockEvent(event)
    }

    window.addEventListener('popstate', handlePopState, true)
    document.addEventListener('click', handleClickCapture, true)
    document.addEventListener('keydown', handleKeyDownCapture, true)
    return () => {
      window.removeEventListener('popstate', handlePopState, true)
      document.removeEventListener('click', handleClickCapture, true)
      document.removeEventListener('keydown', handleKeyDownCapture, true)
    }
  }, [isLive])

  // ⋯ 메뉴 바깥 클릭 시 닫기
  useEffect(() => {
    if (menuOpenId == null) return
    const onDocMouseDown = () => setMenuOpenId(null)
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [menuOpenId])

  // 메모 textarea 자동 높이 (기본 2줄 ~ 최대 5줄, 초과 시 스크롤 — max-height는 CSS)
  useEffect(() => {
    const el = memoAreaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [memoText])

  // ---- 회의 메타 편집 ----
  const syncMeeting = useCallback(
    (patch: { title?: string; tag?: string; participant_ids?: number[] }) => {
      if (meetingId == null) return
      void api.updateMeeting(meetingId, patch).catch(() => {
        /* 메타 동기화 실패는 치명적이지 않으므로 무시 */
      })
    },
    [meetingId],
  )

  const beginEditTitle = () => {
    setTitleDraft(title)
    setEditingTitle(true)
  }

  const commitTitle = () => {
    if (!editingTitle) return
    setEditingTitle(false)
    const next = titleDraft.trim() || DEFAULT_TITLE
    if (next === title) return
    setTitle(next)
    syncMeeting({ title: next })
  }

  const onTitleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      commitTitle()
    } else if (e.key === 'Escape') {
      setEditingTitle(false)
    }
  }

  const handleTagChange = (next: string | null) => {
    if (next === tag) return
    setTag(next)
    // 태그 제거(null)는 API 계약대로 빈 문자열로 전송
    syncMeeting({ tag: next ?? '' })
  }

  const handleParticipantsChange = (list: Participant[]) => {
    setParticipants(list)
    if (meetingId != null) {
      syncMeeting({ participant_ids: list.map((p) => p.id) })
    }
  }

  const beginEditDate = () => {
    const iso = startedAt || new Date().toISOString()
    setDateDraft(iso.slice(0, 10))
    setHourDraft(Number(iso.slice(11, 13)) || 0)
    setMinuteDraft(Number(iso.slice(14, 16)) || 0)
    setEditingDate(true)
  }

  const commitDate = async () => {
    const dateValue = dateDraft.trim()
    if (!dateValue) return
    if (!isValidDateInput(dateValue)) {
      alert('날짜는 2026-07-08 형식으로 입력해주세요.')
      return
    }
    setEditingDate(false)
    const next = `${dateValue}T${String(hourDraft).padStart(2, '0')}:${String(minuteDraft).padStart(2, '0')}`
    if (next === startedAt.slice(0, 16)) return
    setStartedAt(next)
    if (meetingId == null) return
    try {
      const updated = await api.updateMeeting(meetingId, { started_at: next })
      setStartedAt(updated.started_at)
      setRefreshKey((k) => k + 1)
    } catch (err) {
      alert(err instanceof Error ? err.message : '날짜 변경에 실패했어요')
    }
  }

  // ---- 녹음 시작/종료 ----
  const createMeetingFromCurrentMeta = async () =>
    api.createMeeting({
      title: title.trim() || DEFAULT_TITLE,
      tag: tag ?? undefined,
      started_at: startedAt,
      participant_ids: participants.map((p) => p.id),
    })

  const handleStart = async () => {
    if (starting || isLive) return
    setRecordMode('idle')
    setStarting(true)
    try {
      const outcome = await recorder.start({
        deviceId: confirmedMicId || undefined,
        source: recordSource,
        // 설정에서 미리 연결한 공유 스트림이 있으면 팝업 없이 그대로 사용 (소유권 이전)
        presetSystemStream: recordSource !== 'mic' ? takePresetShare() : undefined,
      })
      if (!outcome.started) {
        // 컴퓨터 소리 전용 모드에서 소리를 얻지 못해 녹음이 시작되지 않음
        if (SYSTEM_AUDIO_ISSUES[outcome.systemAudio]) setSysAudioIssue(outcome.systemAudio)
        setStarting(false)
        return
      }
      // 마이크+컴퓨터 모드에서 컴퓨터 소리만 실패 — 마이크 녹음은 진행 중이므로 안내만
      if (recordSource !== 'mic' && SYSTEM_AUDIO_ISSUES[outcome.systemAudio]) {
        setSysAudioIssue(outcome.systemAudio)
      }
    } catch {
      alert(
        confirmedMicId
          ? '선택한 마이크를 사용할 수 없어요. 녹음 설정에서 다시 선택하거나 브라우저 권한을 확인해주세요.'
          : '마이크를 사용할 수 없어요. 브라우저의 마이크 권한을 확인해주세요.',
      )
      setStarting(false)
      return
    }
    try {
      const meeting = await createMeetingFromCurrentMeta()
      setMeetingId(meeting.id)
      setStartedAt(meeting.started_at)
      setBookmarks([])
      setRefreshKey((k) => k + 1)
    } catch (err) {
      alert(`회의를 생성하지 못했어요: ${(err as Error).message}`)
      void recorder.stop().catch(() => {})
    } finally {
      setStarting(false)
    }
  }

  /** 컴퓨터 소리 캡처 재시도 — 녹음 중이면 이어 붙이고, 시작 전 실패면 처음부터 다시 */
  const handleRetrySystemAudio = async () => {
    if (recorder.status === 'recording' || recorder.status === 'paused') {
      const result = await recorder.retrySystemAudio()
      if (result === 'on' || result === 'off') {
        setSysAudioIssue(null)
        return
      }
      setSysAudioIssue(result)
      return
    }
    setSysAudioIssue(null)
    void handleStart()
  }

  const uploadAndGo = async (blob: Blob, durationSec: number): Promise<void> => {
    if (meetingId == null) return
    try {
      await api.uploadAudio(meetingId, blob, durationSec)
      navigate(`/meetings/${meetingId}`)
    } catch (err) {
      const retry = await confirm({
        title: '업로드에 실패했어요',
        message: `${(err as Error).message}\n다시 시도할까요?`,
        confirmLabel: '다시 시도',
      })
      if (retry) return uploadAndGo(blob, durationSec)
      setUploading(false)
      navigate(`/meetings/${meetingId}`)
    }
  }

  const handleStop = async () => {
    if (meetingId == null || uploading) return
    setUploading(true)
    setSysAudioIssue(null)
    let result: { blob: Blob; durationSec: number }
    try {
      result = await recorder.stop()
    } catch (err) {
      setUploading(false)
      alert(`녹음을 종료하지 못했어요: ${(err as Error).message}`)
      return
    }
    await uploadAndGo(result.blob, result.durationSec)
  }

  const handleCancelRecording = async () => {
    if ((!isLive && meetingId == null) || uploading || cancellingRecording) return
    const ok = await confirm({
      title: '녹음을 취소할까요?',
      message: '현재 녹음과 이 회의에 남긴 메모가 삭제되고 저장되지 않습니다.',
      confirmLabel: '녹음 취소',
      danger: true,
    })
    if (!ok) return

    setCancellingRecording(true)
    setSysAudioIssue(null)
    const currentMeetingId = meetingId
    try {
      await recorder.cancel()
      if (currentMeetingId != null) {
        await api.purgeMeeting(currentMeetingId).catch(async () => {
          await api.deleteMeeting(currentMeetingId).catch(() => {})
        })
      }
      setMeetingId(null)
      setBookmarks([])
      setMemoText('')
      setMenuOpenId(null)
      setEditingBookmarkId(null)
      setEditDraft('')
      setRefreshKey((k) => k + 1)
    } catch (err) {
      alert(err instanceof Error ? err.message : '녹음 취소에 실패했어요')
    } finally {
      setCancellingRecording(false)
    }
  }

  const handleUploadFile = async (file: File) => {
    if (starting || uploading || manualSubmitting) return
    if (!isAudioFile(file)) {
      alert('오디오 파일만 업로드할 수 있어요. (mp3, m4a, wav, webm, ogg, mp4, aac, flac)')
      return
    }
    setUploading(true)
    let createdMeetingId: number | null = null
    try {
      const durationSec = await readAudioDuration(file)
      const meeting = await createMeetingFromCurrentMeta()
      createdMeetingId = meeting.id
      setMeetingId(meeting.id)
      setStartedAt(meeting.started_at)
      setRefreshKey((k) => k + 1)
      await api.uploadAudio(meeting.id, file, durationSec)
      navigate(`/meetings/${meeting.id}`)
    } catch (err) {
      if (createdMeetingId != null) void api.deleteMeeting(createdMeetingId).catch(() => {})
      alert(err instanceof Error ? err.message : '오디오 파일 업로드에 실패했어요')
      setUploading(false)
    }
  }

  const handleUploadInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) void handleUploadFile(file)
    e.target.value = ''
  }

  const handleUploadDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    if (!uploadDragActive) setUploadDragActive(true)
  }

  const handleUploadDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setUploadDragActive(false)
    }
  }

  const handleUploadDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setUploadDragActive(false)
    const file = e.dataTransfer.files?.[0]
    if (file) void handleUploadFile(file)
  }

  const handleUploadZoneClick = () => {
    if (starting || uploading) return
    uploadInputRef.current?.click()
  }

  const handleUploadZoneKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    handleUploadZoneClick()
  }

  const handleManualSubmit = async () => {
    const text = manualText.trim()
    if (!text || starting || uploading || manualSubmitting) return
    setManualSubmitting(true)
    let createdMeetingId: number | null = null
    try {
      const meeting = await createMeetingFromCurrentMeta()
      createdMeetingId = meeting.id
      setMeetingId(meeting.id)
      setStartedAt(meeting.started_at)
      await api.submitManualTranscript(meeting.id, { text, duration_sec: 0 })
      setRefreshKey((k) => k + 1)
      navigate(`/meetings/${meeting.id}`)
    } catch (err) {
      if (createdMeetingId != null) void api.deleteMeeting(createdMeetingId).catch(() => {})
      alert(err instanceof Error ? err.message : '직접 작성한 회의 내용을 요약하지 못했어요')
      setManualSubmitting(false)
    }
  }

  // ---- 북마크(메모/마크) ----
  const handleAddMemo = async () => {
    const text = memoText.trim()
    if (!text || meetingId == null || !canMemo) return
    try {
      const bm = await api.addBookmark(
        meetingId,
        withTime
          ? { time_sec: recorder.elapsedSec, title: text, kind: 'memo' }
          : { time_sec: 0, title: text, kind: 'note' },
      )
      setBookmarks((prev) => sortByTime([...prev, bm]))
      setMemoText('')
      setRefreshKey((k) => k + 1)
    } catch (err) {
      alert(`메모를 저장하지 못했어요: ${(err as Error).message}`)
    }
  }

  // Enter 제출 / Shift+Enter 줄바꿈 (IME 조합 중에는 무시)
  const onMemoKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
    e.preventDefault()
    void handleAddMemo()
  }

  const handleAddMark = async () => {
    if (meetingId == null || !canMemo) return
    const n = bookmarks.filter((b) => b.kind === 'mark').length + 1
    try {
      const bm = await api.addBookmark(meetingId, {
        time_sec: recorder.elapsedSec,
        title: `마크 ${n}`,
        kind: 'mark',
      })
      setBookmarks((prev) => sortByTime([...prev, bm]))
      setRefreshKey((k) => k + 1)
    } catch (err) {
      alert(`마크를 저장하지 못했어요: ${(err as Error).message}`)
    }
  }

  const beginEditBookmark = (b: Bookmark) => {
    setMenuOpenId(null)
    setEditDraft(b.title)
    setEditingBookmarkId(b.id)
  }

  const commitBookmarkEdit = async () => {
    const id = editingBookmarkId
    if (id == null) return
    setEditingBookmarkId(null)
    const text = editDraft.trim()
    const original = bookmarks.find((b) => b.id === id)
    if (!original || !text || text === original.title) return
    try {
      const updated = await api.updateBookmark(id, { title: text })
      setBookmarks((prev) => sortByTime(prev.map((b) => (b.id === id ? updated : b))))
    } catch (err) {
      alert(`메모를 수정하지 못했어요: ${(err as Error).message}`)
    }
  }

  const onEditKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void commitBookmarkEdit()
    } else if (e.key === 'Escape') {
      setEditingBookmarkId(null)
    }
  }

  const handleDeleteBookmark = async (id: number) => {
    setMenuOpenId(null)
    try {
      await api.deleteBookmark(id)
      setBookmarks((prev) => prev.filter((b) => b.id !== id))
    } catch (err) {
      alert(`메모를 삭제하지 못했어요: ${(err as Error).message}`)
    }
  }

  const waveMarks = useMemo(
    () =>
      bookmarks
        .filter((b) => b.kind !== 'note')
        .map((b) => ({ timeSec: b.time_sec, label: formatClock(b.time_sec) })),
    [bookmarks],
  )

  // 시간 메모/마크 그룹 + 일반 메모(note) 그룹 분리
  const timedBookmarks = useMemo(() => bookmarks.filter((b) => b.kind !== 'note'), [bookmarks])
  const noteBookmarks = useMemo(() => bookmarks.filter((b) => b.kind === 'note'), [bookmarks])

  const showRecorder = isLive || (uploading && recorder.status !== 'idle')

  // 메모/마크/일반 메모 공통 행 렌더 (수정/삭제 UX 동일)
  const renderBookmarkItem = (b: Bookmark): ReactNode => (
    <li key={b.id} className="memo-item">
      {b.kind === 'note' ? (
        <span className="badge badge-gray memo-note-badge">📝 메모</span>
      ) : (
        <span className="time-chip">{formatClock(b.time_sec)}</span>
      )}
      {b.kind === 'mark' && <span className="badge badge-blue memo-mark-badge">🔖 마크</span>}
      {editingBookmarkId === b.id ? (
        <input
          className="input memo-edit-input"
          value={editDraft}
          autoFocus
          onChange={(e) => setEditDraft(e.target.value)}
          onBlur={() => void commitBookmarkEdit()}
          onKeyDown={onEditKeyDown}
          aria-label="메모 수정"
        />
      ) : (
        <span className="memo-item-title">{b.title}</span>
      )}
      <div className="memo-item-menu-wrap" onMouseDown={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="btn-icon memo-menu-btn"
          aria-label="메모 메뉴"
          onClick={() => setMenuOpenId(menuOpenId === b.id ? null : b.id)}
        >
          ⋯
        </button>
        {menuOpenId === b.id && (
          <div className="memo-menu">
            <button type="button" onClick={() => beginEditBookmark(b)}>
              ✏️ 수정
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => void handleDeleteBookmark(b.id)}
            >
              🗑️ 삭제
            </button>
          </div>
        )}
      </div>
    </li>
  )

  return (
    <div className="record-page">
      <div className="record-main">
        {/* ---- 헤더: 제목 / 메타 / 참석자 ---- */}
        <header className="record-header">
          <div className="record-title-row">
            {editingTitle ? (
              <input
                className="input record-title-input"
                value={titleDraft}
                autoFocus
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={commitTitle}
                onKeyDown={onTitleKeyDown}
                aria-label="회의 제목"
              />
            ) : (
              <>
                <h1 className="record-title" onClick={beginEditTitle}>
                  {title}
                </h1>
                <button
                  type="button"
                  className="btn-icon"
                  aria-label="제목 수정"
                  onClick={beginEditTitle}
                >
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                  </svg>
                </button>
              </>
            )}
          </div>

          <div className="record-meta">
            {editingDate ? (
              <span className="record-date-edit">
                <input
                  type="date"
                  className="input record-date-input"
                  value={dateDraft}
                  aria-label="회의 날짜"
                  onChange={(e) => setDateDraft(e.target.value)}
                  autoFocus
                />
                <select
                  className="input record-time-select"
                  aria-label="시"
                  value={hourDraft}
                  onChange={(e) => setHourDraft(Number(e.target.value))}
                >
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>
                      {h}시
                    </option>
                  ))}
                </select>
                <select
                  className="input record-time-select"
                  aria-label="분"
                  value={minuteDraft}
                  onChange={(e) => setMinuteDraft(Number(e.target.value))}
                >
                  {Array.from({ length: 12 }, (_, i) => i * 5).map((m) => (
                    <option key={m} value={m}>
                      {String(m).padStart(2, '0')}분
                    </option>
                  ))}
                </select>
                <button type="button" className="btn btn-primary record-date-save" onClick={() => void commitDate()}>
                  저장
                </button>
                <button type="button" className="btn btn-ghost record-date-save" onClick={() => setEditingDate(false)}>
                  취소
                </button>
              </span>
            ) : (
              <button type="button" className="record-meta-item record-date-btn" onClick={beginEditDate}>
                📅 {formatKoreanDateTime(startedAt)} ✎
              </button>
            )}
            <span className="record-meta-item">
              ⏱️ 회의 시간 <b>{formatClock(recorder.elapsedSec)}</b>
            </span>
            <TagPicker value={tag} onChange={handleTagChange} />
          </div>

          <div className="record-participants">
            <AvatarStack participants={participants} />
            <span className="record-participants-count">참석자 {participants.length}명</span>
            <button
              type="button"
              className="btn btn-soft record-add-btn"
              onClick={() => setPickerOpen(true)}
            >
              + 추가
            </button>
          </div>
        </header>

        <div className="record-content-row">
          <div className="record-content-main">
            {/* ---- 레코더 카드 ---- */}
            <section className="card recorder-card">
              {!showRecorder ? (
                recordMode === 'manual' ? (
                  <div className="manual-writing-panel">
                    <div className="manual-writing-head">
                      <span className="manual-writing-icon" aria-hidden="true">
                        📝
                      </span>
                      <div>
                        <h2>회의 내용 입력</h2>
                        <p>녹음 없이 회의 내용을 직접 작성하면 바로 AI 요약을 시작할 수 있어요.</p>
                      </div>
                    </div>
                    <textarea
                      className="input manual-writing-textarea"
                      value={manualText}
                      onChange={(e) => setManualText(e.target.value)}
                      placeholder={'여기에 회의 내용을 직접 작성하세요.\n결정사항, 할 일, 논의 내용을 자유롭게 적어도 됩니다.'}
                      spellCheck={false}
                      autoFocus
                    />
                    <div className="manual-writing-actions">
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => {
                          setRecordMode('idle')
                          setManualText('')
                        }}
                        disabled={manualSubmitting}
                      >
                        돌아가기
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => void handleManualSubmit()}
                        disabled={!manualText.trim() || manualSubmitting}
                      >
                        {manualSubmitting ? '저장 중...' : '회의록 저장'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="recorder-idle">
                    <div className="record-start-options">
                      <article className="record-start-option record-start-option-audio">
                        <div className="record-start-option-icon" aria-hidden="true">
                          🎙️
                        </div>
                        <h2>녹음으로 회의 시작</h2>
                        <p>실시간 녹음과 메모를 함께 기록합니다.</p>
                        <button
                          type="button"
                          className="btn btn-primary btn-lg record-start-btn"
                          onClick={() => void handleStart()}
                          disabled={starting}
                        >
                          <span className="record-start-dot" /> 녹음 시작
                        </button>
                        <button
                          type="button"
                          className="btn record-mic-test-btn"
                          onClick={openMicTest}
                          disabled={starting || uploading}
                        >
                          <span aria-hidden="true">🎙️</span>
                          녹음 설정 · 테스트
                        </button>
                        {recordSource !== 'mic' && (
                          <span className="record-sysaudio-note">
                            {recordSource === 'system' ? '🔊 컴퓨터 소리만 녹음' : '🎙️🔊 마이크 + 컴퓨터 소리 녹음'}
                            {presetShareOn && ' · 공유 연결됨 ✓'}
                          </span>
                        )}
                      </article>

                      <article className="record-start-option record-start-option-manual">
                        <div className="record-start-option-icon manual" aria-hidden="true">
                          📝
                        </div>
                        <h2>직접 작성으로 시작</h2>
                        <p>녹음 없이 회의 내용만 직접 작성합니다.</p>
                        <button
                          type="button"
                          className="btn btn-lg manual-start-btn"
                          onClick={() => setRecordMode('manual')}
                          disabled={starting}
                        >
                          바로 작성하기
                        </button>
                      </article>
                    </div>

                    <div
                      className={`record-upload-strip${uploadDragActive ? ' drag-over' : ''}`}
                      role="button"
                      tabIndex={starting || uploading ? -1 : 0}
                      aria-label="오디오 파일 업로드"
                      aria-disabled={starting || uploading}
                      onClick={handleUploadZoneClick}
                      onKeyDown={handleUploadZoneKeyDown}
                      onDragOver={handleUploadDragOver}
                      onDragLeave={handleUploadDragLeave}
                      onDrop={handleUploadDrop}
                    >
                      <div className="record-upload-copy">
                        <div className="record-upload-title-row">
                          <span className="record-upload-mini-icon" aria-hidden="true">
                            ☁
                          </span>
                          <span className="record-upload-text">오디오 파일 업로드</span>
                        </div>
                        <span className="record-upload-hint">
                          파일을 끌어오거나 클릭하여 업로드하세요
                        </span>
                      </div>
                      <input
                        ref={uploadInputRef}
                        type="file"
                        className="record-upload-input"
                        accept={ACCEPT_AUDIO}
                        onClick={(e) => e.stopPropagation()}
                        onChange={handleUploadInputChange}
                        aria-hidden="true"
                        tabIndex={-1}
                      />
                    </div>
                  </div>
                )
              ) : (
                <>
                  <div
                    className={`recorder-status${recorder.status === 'paused' ? ' paused' : ''}`}
                  >
                    <span
                      className={`rec-dot${recorder.status === 'paused' ? ' paused' : ''}`}
                    />
                    {recorder.status === 'paused' ? '일시정지됨' : '녹음 중'}
                  </div>

                  <div className="recorder-source-toggles">
                    {recordSource !== 'system' && (
                      <button
                        type="button"
                        className={`source-toggle${recorder.micMuted ? ' muted' : ''}`}
                        onClick={() => recorder.setMicMuted(!recorder.micMuted)}
                        title={recorder.micMuted ? '마이크 다시 켜기' : '마이크 음소거'}
                      >
                        {recorder.micMuted ? '🚫 마이크 꺼짐' : '🎙️ 마이크'}
                      </button>
                    )}
                    {recorder.systemAudio === 'on' && (
                      <button
                        type="button"
                        className={`source-toggle${recorder.systemMuted ? ' muted' : ''}${
                          !recorder.systemMuted && recorder.systemSignal === 'silent' ? ' silent' : ''
                        }`}
                        onClick={() => recorder.setSystemMuted(!recorder.systemMuted)}
                        title={
                          recorder.systemMuted
                            ? '컴퓨터 소리 다시 켜기'
                            : recorder.systemSignal === 'silent'
                              ? "컴퓨터 소리가 계속 무음이에요. 컴퓨터에서 소리가 나고 있다면 — 화면 공유로 녹음 중이면 공유 창에서 '오디오 공유'를 켰는지, 가상 오디오 장치로 녹음 중이면 시스템 출력이 다중 출력 장치로 설정됐는지 확인해주세요."
                              : '컴퓨터 소리 끄기'
                        }
                      >
                        {recorder.systemMuted
                          ? '🚫 컴퓨터 소리 꺼짐'
                          : recorder.systemSignal === 'silent'
                            ? '🔇 컴퓨터 소리 무음 감지'
                            : '🔊 컴퓨터 소리'}
                      </button>
                    )}
                    {recorder.systemAudio === 'ended' && (
                      <button
                        type="button"
                        className="source-toggle warn"
                        onClick={() => void handleRetrySystemAudio()}
                      >
                        🔇 컴퓨터 소리 끊김 — 다시 연결
                      </button>
                    )}
                  </div>

                  <div className="recorder-timer">{formatClock(recorder.elapsedSec)}</div>

                  <Waveform
                    analyser={recorder.analyser}
                    active={recorder.status === 'recording'}
                    marks={waveMarks}
                    elapsedSec={recorder.elapsedSec}
                  />

                  <div className="recorder-controls">
                    {recorder.status === 'paused' ? (
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={recorder.resume}
                        disabled={cancellingRecording}
                      >
                        ▶ 재개
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={recorder.pause}
                        disabled={cancellingRecording}
                      >
                        ⏸ 일시정지
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn record-stop-btn"
                      onClick={() => void handleStop()}
                      disabled={uploading || cancellingRecording}
                    >
                      ■ 종료
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost record-cancel-btn"
                      onClick={() => void handleCancelRecording()}
                      disabled={uploading || cancellingRecording}
                    >
                      {cancellingRecording ? '취소 중...' : '취소'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-soft"
                      onClick={() => void handleAddMark()}
                      disabled={!canMemo || cancellingRecording}
                    >
                      🔖 마크 추가
                    </button>
                  </div>
                </>
              )}
            </section>

            {/* ---- 메모 카드 ---- */}
            {recordMode !== 'manual' && (
            <section className="card memo-card">
              <div className="memo-header">
                <h2 className="memo-title">메모</h2>
                <span className="memo-count">{bookmarks.length}개</span>
              </div>

              <div className="memo-input-area">
                <textarea
                  ref={memoAreaRef}
                  className="input memo-textarea"
                  placeholder="회의 중 메모를 입력하세요... (Enter 제출, Shift+Enter 줄바꿈)"
                  rows={2}
                  value={memoText}
                  onChange={(e) => setMemoText(e.target.value)}
                  onKeyDown={onMemoKeyDown}
                  disabled={!canMemo}
                />
                <div className="memo-input-footer">
                  <label className="memo-time-toggle">
                    <input
                      type="checkbox"
                      checked={withTime}
                      onChange={(e) => setWithTime(e.target.checked)}
                      disabled={!canMemo}
                    />
                    ⏱ 시간 기록
                  </label>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void handleAddMemo()}
                    disabled={!canMemo || !memoText.trim()}
                  >
                    + 메모 추가
                  </button>
                </div>
              </div>

              {!canMemo && bookmarks.length === 0 ? (
                <p className="memo-empty">녹음을 시작하면 메모를 남길 수 있어요.</p>
              ) : bookmarks.length === 0 ? (
                <p className="memo-empty">아직 메모가 없어요. Enter로 빠르게 추가해보세요.</p>
              ) : (
                <>
                  {timedBookmarks.length > 0 && (
                    <ul className="memo-list">{timedBookmarks.map(renderBookmarkItem)}</ul>
                  )}
                  {noteBookmarks.length > 0 && (
                    <div className="memo-note-group">
                      <h3 className="memo-group-title">일반 메모</h3>
                      <ul className="memo-list">{noteBookmarks.map(renderBookmarkItem)}</ul>
                    </div>
                  )}
                </>
              )}
            </section>
            )}
          </div>

          {/* ---- 우측 최근 회의 패널 ---- */}
          <aside className="record-side">
            <RecentMeetingsPanel refreshKey={refreshKey} recordingActive={isLive || uploading} />
          </aside>
        </div>
      </div>

      <ParticipantPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        selected={participants}
        onChange={handleParticipantsChange}
      />

      {processing && (
        <div className="upload-overlay">
          <span className="spinner" />
          <p>
            {cancellingRecording
              ? '현재 녹음을 취소하고 기록을 정리하고 있어요...'
              : manualSubmitting
              ? '작성한 회의 내용으로 AI 요약을 시작하고 있어요...'
              : '음성 파일을 업로드하고 분석을 시작하고 있어요...'}
          </p>
        </div>
      )}

      <Modal open={micTestOpen} title="녹음 설정" width={520} onClose={closeMicTest}>
        <div className="mic-test-modal">
          <p className="mic-test-desc">
            {IS_MOBILE_DEVICE
              ? '녹음에 사용할 마이크를 확인해주세요.'
              : '무엇을 녹음할지 고르고, 장치를 확인해주세요.'}
          </p>
          {micTestError && <div className="mic-test-error">{micTestError}</div>}

          {!IS_MOBILE_DEVICE && (
          <div className="mic-modal-section">
            <h3 className="mic-modal-section-title">녹음 소스</h3>
            <div className="record-source-grid" role="radiogroup" aria-label="녹음 소스">
              {SOURCE_OPTIONS.map((option) => {
                const checked = recordSource === option.value
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    className={`record-source-tile${checked ? ' selected' : ''}`}
                    onClick={() => handleSelectSource(option.value)}
                  >
                    <span className="record-source-tile-icon" aria-hidden="true">
                      {option.icon}
                    </span>
                    <strong>{option.title}</strong>
                  </button>
                )
              })}
            </div>
            <p className="record-source-desc">{selectedSourceOption.desc}</p>
          </div>
          )}

          {recordSource !== 'mic' && CAN_DISPLAY_AUDIO && (
            <div className="sys-source-status ok">
              {presetShareOn ? (
                <div className="sys-source-row">
                  <span className="sys-source-copy">
                    <strong>✅ 컴퓨터 소리 연결됨 — 녹음 시작 시 팝업 없이 바로 시작돼요</strong>
                    <span>
                      컴퓨터에서 소리를 재생하면 오른쪽 미터가 움직여요. 연결은 녹음을
                      시작하거나 이 페이지를 벗어날 때까지 유지되고, 브라우저의 [공유 중지]로도
                      끊을 수 있어요.
                    </span>
                  </span>
                  <span
                    className="mic-level-meter"
                    aria-label={`컴퓨터 소리 레벨 ${Math.round(sysLevel * 100)}%`}
                  >
                    {Array.from({ length: 18 }).map((_, i) => (
                      <span key={i} className={i < Math.round(sysLevel * 18) ? 'active' : ''} />
                    ))}
                  </span>
                </div>
              ) : audioHelper?.blackhole ? (
                <div className="sys-source-row">
                  <span className="sys-source-copy">
                    <strong>🎛️ 오디오 도우미 연결됨 — 팝업 없이 자동으로 녹음돼요</strong>
                    <span>
                      녹음을 시작하면 지금 듣고 있는 출력({audioHelper.output})에 BlackHole이
                      잠깐 결합되어 컴퓨터 소리가 그대로 녹음되고, 종료하면 원래 출력으로 자동
                      복귀해요. 에어팟·헤드폰을 껴도 소리는 계속 그쪽으로 들리고, 스피커를
                      음소거해 둔 상태여도 컴퓨터 소리는 원음 그대로 녹음돼요. 컴퓨터에서
                      소리를 재생하면 오른쪽 미터가 움직여요.
                    </span>
                  </span>
                  <span
                    className="mic-level-meter"
                    aria-label={`컴퓨터 소리 레벨 ${Math.round(sysLevel * 100)}%`}
                  >
                    {Array.from({ length: 18 }).map((_, i) => (
                      <span key={i} className={i < Math.round(sysLevel * 18) ? 'active' : ''} />
                    ))}
                  </span>
                </div>
              ) : (
                <>
                  <span className="sys-source-copy">
                    <strong>🔊 녹음 시작 전에 컴퓨터 소리를 연결해두세요</strong>
                    <span>
                      [지금 연결하기]를 누르면 화면 공유 창이 열려요 — Google Meet 등
                      회의·영상이 열려 있는 [{BROWSER.tab}]을 고르고 '오디오도 공유'를 켜면
                      컴퓨터 소리 음량을 미리 확인할 수 있어요. 탭 공유는 스피커를 음소거해도
                      녹음돼요. ⚠️ [창] 공유는 소리가 안 담기고, Mac은 [전체 화면]도 안 될 수
                      있으니 탭을 선택해주세요.
                      {loopbackDevice &&
                        ` 공유를 취소하면 감지된 가상 오디오 장치(${loopbackDevice.label})로 자동 전환돼요.`}
                    </span>
                  </span>
                  {presetShareError && (
                    <span className="preset-share-error">{presetShareError}</span>
                  )}
                  <button
                    type="button"
                    className="btn btn-soft sys-recheck-btn"
                    onClick={() => void startShareGuide()}
                  >
                    🔗 지금 연결하기
                  </button>
                </>
              )}
            </div>
          )}

          {recordSource !== 'mic' && !CAN_DISPLAY_AUDIO && (
            <div className={`sys-source-status${loopbackDevice ? ' ok' : ''}`}>
              {loopbackDevice ? (
                <div className="sys-source-row">
                  <span className="sys-source-copy">
                    <strong>✅ 가상 오디오 장치 사용: {loopbackDevice.label}</strong>
                    <span>
                      녹음 시작 시 팝업 없이 컴퓨터 소리가 바로 녹음돼요. 컴퓨터에서 소리를
                      재생하면 오른쪽 미터가 움직여요. 소리를 재생해도 미터가 멈춰 있으면
                      시스템 사운드 출력이 {loopbackDevice.label}이(가) 포함된 다중 출력
                      장치로 설정되어 있는지 확인해주세요 — 장치만 설치하면 소리가 무음으로
                      녹음돼요. 다중 출력 장치를 직접 만들 때는 {loopbackDevice.label}을(를)
                      목록 맨 위(메인)로 두어야 스피커를 음소거해도 녹음이 유지돼요. Notie
                      오디오 도우미를 설치하면 이 전환이 녹음 시작·종료에 맞춰 자동으로 돼요.
                    </span>
                  </span>
                  <span
                    className="mic-level-meter"
                    aria-label={`컴퓨터 소리 레벨 ${Math.round(sysLevel * 100)}%`}
                  >
                    {Array.from({ length: 18 }).map((_, i) => (
                      <span key={i} className={i < Math.round(sysLevel * 18) ? 'active' : ''} />
                    ))}
                  </span>
                </div>
              ) : (
                <>
                  <span className="sys-source-copy">
                    <strong>⚠️ 이 컴퓨터에 가상 오디오 장치(BlackHole)가 없어요</strong>
                    <span>
                      {IS_SAFARI
                        ? 'Safari는 화면 공유 소리 녹음을 지원하지 않아서, 컴퓨터 소리를 녹음하려면 BlackHole 설치가 꼭 필요해요. (또는 Chrome 사용)'
                        : '이 브라우저는 화면 공유 소리 녹음을 지원하지 않아요. 무료 가상 오디오 장치 BlackHole을 설치하면 녹음할 수 있어요.'}
                    </span>
                  </span>
                  {IS_MAC && (
                    <>
                      <ol className="sys-install-steps">
                        <li>
                          터미널에서 <code>{BLACKHOLE_INSTALL_CMD}</code>
                          <button
                            type="button"
                            className="btn sys-copy-btn"
                            onClick={() => void copyBlackholeCommand()}
                          >
                            {brewCopied ? '복사됨 ✓' : '복사'}
                          </button>{' '}
                          실행 — 또는{' '}
                          <a href={BLACKHOLE_DOWNLOAD_URL} target="_blank" rel="noreferrer">
                            공식 사이트
                          </a>
                          에서 다운로드해 설치
                        </li>
                        <li>
                          [오디오 MIDI 설정] 앱 → 왼쪽 아래 ‘+’ → [다중 출력 장치 생성] → 스피커와
                          BlackHole 2ch를 모두 체크
                        </li>
                        <li>메뉴 막대 사운드(또는 시스템 설정 › 사운드)에서 만든 다중 출력 장치를 출력으로 선택</li>
                      </ol>
                      <button
                        type="button"
                        className="btn btn-soft sys-recheck-btn"
                        onClick={() => void startSystemTestStream()}
                      >
                        🔄 설치 확인
                      </button>
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {recordSource !== 'system' && (
            <div className="mic-modal-section">
              <h3 className="mic-modal-section-title">사용할 마이크</h3>
              <div className="mic-device-list">
              {micDevices.length === 0 && !micTestLoading ? (
                <div className="mic-device-empty">표시할 마이크가 없어요.</div>
              ) : (
                micDevices.map((device, index) => {
                  const checked = selectedMicId === device.deviceId
                  const levelSegments = 18
                  const activeSegments = checked ? Math.round(micLevel * levelSegments) : 0
                  return (
                    <button
                      key={device.deviceId || `mic-${index}`}
                      type="button"
                      className={`mic-device-row${checked ? ' selected' : ''}`}
                      onClick={() => handleSelectMic(device.deviceId)}
                    >
                      <span className="mic-radio" aria-hidden="true">
                        <span />
                      </span>
                      <span className="mic-device-copy">
                        <strong>{device.label || (index === 0 ? '기본 마이크' : `마이크 ${index + 1}`)}</strong>
                        <span>{device.label && index === 0 ? '기본 입력 장치' : '오디오 입력 장치'}</span>
                      </span>
                      {checked && (
                        <span className="mic-level-meter" aria-label={`마이크 입력 레벨 ${Math.round(micLevel * 100)}%`}>
                          {Array.from({ length: levelSegments }).map((_, segmentIndex) => (
                            <span key={segmentIndex} className={segmentIndex < activeSegments ? 'active' : ''} />
                          ))}
                        </span>
                      )}
                    </button>
                  )
                })
              )}
              </div>
            </div>
          )}

          <div className="mic-test-footer">
            <span>
              {micTestLoading
                ? '장치를 확인하고 있어요...'
                : recordSource === 'system'
                  ? '확인을 누르면 컴퓨터 소리만 녹음해요.'
                  : confirmedMicLabel
                    ? `현재 녹음 마이크: ${confirmedMicLabel}`
                    : '확인을 누르면 선택한 마이크로 녹음합니다.'}
            </span>
            <div className="mic-test-actions">
              <button type="button" className="btn btn-ghost" onClick={closeMicTest}>
                닫기
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleConfirmMic}
                disabled={micTestLoading || (recordSource !== 'system' && !selectedMicId)}
              >
                확인
              </button>
            </div>
          </div>
        </div>
      </Modal>

      <Modal
        open={sysAudioIssue != null}
        title={(sysAudioIssue && SYSTEM_AUDIO_ISSUES[sysAudioIssue]?.title) || '컴퓨터 소리 녹음'}
        width={480}
        onClose={() => setSysAudioIssue(null)}
      >
        <div className="sysaudio-issue-modal">
          <p className="sysaudio-issue-body">
            {sysAudioIssue ? SYSTEM_AUDIO_ISSUES[sysAudioIssue]?.body : ''}
          </p>
          <div className="sysaudio-issue-actions">
            {sysAudioIssue === 'system-denied' && IS_MAC && (
              <button
                type="button"
                className="btn btn-soft"
                onClick={() => {
                  window.location.href = MAC_SCREEN_SETTINGS_URL
                }}
              >
                ⚙️ 시스템 설정 열기
              </button>
            )}
            <span className="sysaudio-issue-spacer" />
            <button type="button" className="btn btn-ghost" onClick={() => setSysAudioIssue(null)}>
              마이크만 녹음
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void handleRetrySystemAudio()}
            >
              다시 시도
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
