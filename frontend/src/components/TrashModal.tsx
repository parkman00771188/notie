import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { Meeting, Tag } from '../types'
import { formatClock, formatRelativeDate } from '../utils'
import { useConfirm } from './confirm'
import Modal from './Modal'
import './TrashModal.css'

/** 휴지통 항목: Meeting + 삭제 시각(deleted_at) */
type TrashMeeting = Meeting & { deleted_at?: string | null }

export interface TrashModalProps {
  open: boolean
  onClose: () => void
  /** 복원·완전 삭제 성공 시 부모 목록을 새로고침하는 콜백 */
  onChanged?: () => void
}

export function TrashModal({ open, onClose, onChanged }: TrashModalProps) {
  const confirm = useConfirm()
  const [items, setItems] = useState<TrashMeeting[] | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [busyAll, setBusyAll] = useState(false)
  const [error, setError] = useState('')
  const [tags, setTags] = useState<Tag[]>([])

  // 태그 색 매칭용 (실패해도 기본색으로 표시)
  useEffect(() => {
    if (!open) return
    api
      .listTags()
      .then(setTags)
      .catch(() => {})
  }, [open])

  const load = useCallback(() => {
    setError('')
    setItems(null)
    api
      .listTrash()
      .then((list) => setItems(list))
      .catch((err) => {
        setItems([])
        setError(err instanceof Error ? err.message : '휴지통을 불러오지 못했어요')
      })
  }, [])

  // 열릴 때마다 휴지통 목록 로드
  useEffect(() => {
    if (open) load()
  }, [open, load])

  const handleRestore = async (m: TrashMeeting) => {
    if (busyId != null || busyAll) return
    setBusyId(m.id)
    setError('')
    try {
      await api.restoreMeeting(m.id)
      setItems((prev) => (prev ? prev.filter((x) => x.id !== m.id) : prev))
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : '복원에 실패했어요')
    } finally {
      setBusyId(null)
    }
  }

  const handlePurge = async (m: TrashMeeting) => {
    if (busyId != null || busyAll) return
    const ok = await confirm({
      title: `'${m.title}' 회의를 완전 삭제할까요?`,
      message: '녹음 파일과 기록이 영구적으로 삭제돼요. 복구할 수 없어요.',
      confirmLabel: '완전 삭제',
      danger: true,
    })
    if (!ok) return
    setBusyId(m.id)
    setError('')
    try {
      await api.purgeMeeting(m.id)
      setItems((prev) => (prev ? prev.filter((x) => x.id !== m.id) : prev))
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : '완전 삭제에 실패했어요')
    } finally {
      setBusyId(null)
    }
  }

  const handlePurgeAll = async () => {
    if (busyId != null || busyAll || list.length === 0) return
    const ok = await confirm({
      title: `휴지통의 회의 ${list.length}개를 모두 완전 삭제할까요?`,
      message: '녹음 파일과 기록이 영구적으로 삭제돼요. 이 작업은 되돌릴 수 없어요.',
      confirmLabel: '전체 삭제',
      danger: true,
    })
    if (!ok) return

    setBusyAll(true)
    setError('')
    let deletedCount = 0
    try {
      for (const m of list) {
        await api.purgeMeeting(m.id)
        deletedCount += 1
      }
      setItems([])
      onChanged?.()
    } catch (err) {
      if (deletedCount > 0) onChanged?.()
      setError(
        err instanceof Error
          ? `전체 삭제 중 일부 항목을 삭제하지 못했어요: ${err.message}`
          : '전체 삭제 중 일부 항목을 삭제하지 못했어요',
      )
      load()
    } finally {
      setBusyAll(false)
    }
  }

  const loading = items === null
  const list = items ?? []

  return (
    <Modal open={open} title="휴지통" width={640} onClose={onClose}>
      {error && <div className="trash-error">{error}</div>}

      {loading ? (
        <div className="trash-loading">
          <span className="spinner" />
        </div>
      ) : list.length === 0 ? (
        <div className="empty-state trash-empty">
          <div className="emoji">🗑</div>
          <p>휴지통이 비어 있어요</p>
        </div>
      ) : (
        <>
          <div className="trash-toolbar">
            <span className="muted">휴지통 {list.length}개</span>
            <button
              type="button"
              className="btn btn-danger trash-clear-all"
              onClick={() => void handlePurgeAll()}
              disabled={busyAll || busyId != null}
            >
              {busyAll ? '삭제 중...' : '전체 삭제'}
            </button>
          </div>

          <div className="trash-list">
            {list.map((m) => {
              const busy = busyId === m.id
              return (
                <div key={m.id} className="trash-row">
                  <div className="trash-row-main">
                    <div className="trash-row-titleline">
                      <span className="trash-row-title" title={m.title}>
                        {m.title}
                      </span>
                      {m.tag &&
                        (() => {
                          const c = tags.find((t) => t.name === m.tag)?.color ?? '#16a34a'
                          return (
                            <span
                              className="tag-pill trash-row-tag"
                              style={{
                                color: c,
                                borderColor: c,
                                background: `color-mix(in srgb, ${c} 10%, transparent)`,
                              }}
                            >
                              #{m.tag}
                            </span>
                          )
                        })()}
                    </div>
                    <span className="trash-row-meta">
                      삭제 {formatRelativeDate(m.deleted_at)} · 원래 {formatRelativeDate(m.started_at)} ·{' '}
                      {m.status === 'scheduled' ? '예정' : formatClock(m.duration_sec)}
                    </span>
                  </div>
                  <div className="trash-row-actions">
                    <button
                      type="button"
                      className="btn btn-soft"
                      onClick={() => void handleRestore(m)}
                      disabled={busy || busyAll}
                    >
                      복원
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger"
                      onClick={() => void handlePurge(m)}
                      disabled={busy || busyAll}
                    >
                      완전 삭제
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      <p className="muted trash-hint">완전 삭제한 회의는 복구할 수 없어요.</p>
    </Modal>
  )
}

export default TrashModal
