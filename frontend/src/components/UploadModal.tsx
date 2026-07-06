import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent, KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import type { Participant } from '../types'
import { formatClock } from '../utils'
import Modal from './Modal'
import ParticipantPicker from './ParticipantPicker'
import './UploadModal.css'

const ACCEPT = 'audio/*,.mp3,.m4a,.wav,.webm,.ogg'
const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.wav', '.webm', '.ogg']
const FALLBACK_TITLE = '업로드한 회의'

export interface UploadModalProps {
  open: boolean
  onClose: () => void
}

function isAudioFile(file: File): boolean {
  if (file.type.startsWith('audio/')) return true
  const lower = file.name.toLowerCase()
  return AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/** "회의녹음.m4a" → "회의녹음" */
function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, '').trim()
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`
  return `${bytes}B`
}

/** HTMLAudioElement로 오디오 길이(초)를 미리 읽는다. 실패하거나 Infinity면 0. */
function readAudioDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const audio = new Audio()
    const done = (sec: number) => {
      URL.revokeObjectURL(url)
      resolve(sec)
    }
    audio.preload = 'metadata'
    audio.onloadedmetadata = () => {
      const d = audio.duration
      done(Number.isFinite(d) && d > 0 ? d : 0)
    }
    audio.onerror = () => done(0)
    audio.src = url
  })
}

export function UploadModal({ open, onClose }: UploadModalProps) {
  const navigate = useNavigate()

  const [file, setFile] = useState<File | null>(null)
  const [duration, setDuration] = useState(0)
  const [title, setTitle] = useState('')
  const [tag, setTag] = useState('')
  const [participants, setParticipants] = useState<Participant[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')

  const fileInputRef = useRef<HTMLInputElement>(null)
  /** 파일을 빠르게 바꿨을 때 이전 duration 읽기 결과를 무시하기 위한 시퀀스 */
  const fileSeqRef = useRef(0)

  // 모달을 열 때마다 폼 초기화
  useEffect(() => {
    if (!open) return
    setFile(null)
    setDuration(0)
    setTitle('')
    setTag('')
    setParticipants([])
    setPickerOpen(false)
    setDragOver(false)
    setUploading(false)
    setError('')
  }, [open])

  // 업로드 중이거나 참석자 팝업이 위에 떠 있으면 닫기(ESC/오버레이/X) 무시
  const handleClose = () => {
    if (uploading || pickerOpen) return
    onClose()
  }

  // ---- 파일 선택 (클릭/드롭 공용) ----
  const handleFile = (f: File) => {
    if (uploading) return
    if (!isAudioFile(f)) {
      setError('오디오 파일만 업로드할 수 있어요. (mp3, m4a, wav, webm, ogg)')
      return
    }
    setError('')
    setFile(f)
    setTitle(stripExtension(f.name) || FALLBACK_TITLE)
    setDuration(0)
    const seq = ++fileSeqRef.current
    void readAudioDuration(f).then((sec) => {
      if (fileSeqRef.current === seq) setDuration(sec)
    })
  }

  const onInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f) handleFile(f)
    e.target.value = '' // 같은 파일을 다시 선택할 수 있도록 리셋
  }

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    if (!dragOver) setDragOver(true)
  }

  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false)
  }

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files?.[0]
    if (f) handleFile(f)
  }

  const openFileDialog = () => {
    if (!uploading) fileInputRef.current?.click()
  }

  const onDropzoneKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      openFileDialog()
    }
  }

  // ---- 업로드 ----
  const handleUpload = async () => {
    if (!file || uploading) return
    setUploading(true)
    setError('')
    const finalTitle = title.trim() || stripExtension(file.name) || FALLBACK_TITLE
    const trimmedTag = tag.trim()
    try {
      const meeting = await api.createMeeting({
        title: finalTitle,
        tag: trimmedTag || undefined,
        participant_ids: participants.map((p) => p.id),
      })
      try {
        await api.uploadAudio(meeting.id, file, duration)
      } catch (err) {
        // 오디오 없이 남은 회의는 정리 (실패해도 무시)
        void api.deleteMeeting(meeting.id).catch(() => {})
        throw err
      }
      onClose()
      navigate(`/meetings/${meeting.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '업로드에 실패했어요')
      setUploading(false)
    }
  }

  const removeParticipant = (id: number) => {
    setParticipants((prev) => prev.filter((p) => p.id !== id))
  }

  return (
    <Modal open={open} title="오디오 파일 업로드" width={520} onClose={handleClose}>
      {error && <div className="upload-error">{error}</div>}

      {/* 파일 선택 영역 (클릭 + 드래그&드롭) */}
      <div
        className={`upload-dropzone${dragOver ? ' drag-over' : ''}`}
        role="button"
        tabIndex={0}
        aria-label="오디오 파일 선택"
        onClick={openFileDialog}
        onKeyDown={onDropzoneKeyDown}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {file ? (
          <>
            <div className="upload-dropzone-emoji">🎵</div>
            <div className="upload-file-name" title={file.name}>
              {file.name}
            </div>
            <div className="upload-file-meta">
              {formatBytes(file.size)}
              {duration > 0 && ` · ${formatClock(duration)}`}
            </div>
            <span className="upload-file-change">다른 파일 선택</span>
          </>
        ) : (
          <>
            <div className="upload-dropzone-emoji">🎧</div>
            <div className="upload-dropzone-text">
              클릭하거나 오디오 파일을 끌어다 놓으세요
            </div>
            <div className="upload-dropzone-hint">mp3 · m4a · wav · webm · ogg</div>
          </>
        )}
      </div>
      <input
        ref={fileInputRef}
        className="upload-file-input"
        type="file"
        accept={ACCEPT}
        onChange={onInputChange}
        aria-hidden="true"
        tabIndex={-1}
      />

      <div className="upload-field">
        <label className="field-label" htmlFor="upload-title">
          회의 제목
        </label>
        <input
          id="upload-title"
          className="input"
          placeholder="회의 제목"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={uploading}
        />
      </div>

      <div className="upload-field">
        <label className="field-label" htmlFor="upload-tag">
          태그 (선택)
        </label>
        <input
          id="upload-tag"
          className="input"
          placeholder="예: 주간회의"
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          disabled={uploading}
        />
      </div>

      <div className="upload-field">
        <span className="field-label">참석자</span>
        <div className="upload-participants">
          {participants.map((p) => (
            <span
              key={p.id}
              className="upload-p-chip"
              style={{ borderColor: p.color, color: p.color }}
            >
              <span>{p.name}</span>
              {p.role && <span className="upload-p-role">{p.role}</span>}
              <button
                type="button"
                className="upload-p-remove"
                aria-label={`${p.name} 제외`}
                onClick={() => removeParticipant(p.id)}
                disabled={uploading}
              >
                ×
              </button>
            </span>
          ))}
          <button
            type="button"
            className="btn btn-soft upload-p-add"
            onClick={() => setPickerOpen(true)}
            disabled={uploading}
          >
            + 참석자 선택
          </button>
        </div>
      </div>

      <div className="upload-footer">
        <button type="button" className="btn btn-ghost" onClick={handleClose} disabled={uploading}>
          취소
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void handleUpload()}
          disabled={!file || uploading}
        >
          {uploading ? (
            <>
              <span className="spinner upload-btn-spinner" /> 업로드 중...
            </>
          ) : (
            '⬆ 업로드'
          )}
        </button>
      </div>

      <ParticipantPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        selected={participants}
        onChange={setParticipants}
      />
    </Modal>
  )
}

export default UploadModal
