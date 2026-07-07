import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { AvatarStack } from '../components/Avatar'
import { useConfirm } from '../components/confirm'
import { MeetingDetailView } from '../components/MeetingDetailView'
import Modal from '../components/Modal'
import { ParticipantPicker } from '../components/ParticipantPicker'
import { TagPicker } from '../components/TagPicker'
import type { Meeting, Participant, Tag } from '../types'
import {
  getKoreanHolidaysForYear,
  holidayNames,
  type KoreanHoliday,
} from '../utils/koreanHolidays'
import { formatKoreanDateTime } from '../utils'
import './CalendarPage.css'

const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토']
const FALLBACK_EVENT_COLOR = '#ea580c'

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function toDate(value: string | Date): Date | null {
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

function dateKey(value: string | Date): string {
  const d = toDate(value)
  if (!d) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function inputDate(value: Date): string {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
}

function inputTime(value: Date): string {
  return `${pad(value.getHours())}:${pad(value.getMinutes())}`
}

function timeLabel(value: string): string {
  const d = toDate(value)
  if (!d) return ''
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function monthTitle(value: Date): string {
  return `${value.getFullYear()}년 ${value.getMonth() + 1}월`
}

function dayTitle(value: Date | null): string {
  if (!value) return ''
  return `${value.getFullYear()}년 ${value.getMonth() + 1}월 ${value.getDate()}일 (${DAY_NAMES[value.getDay()]})`
}

function addMonths(value: Date, amount: number): Date {
  return new Date(value.getFullYear(), value.getMonth() + amount, 1)
}

function addDays(value: Date, amount: number): Date {
  const d = new Date(value)
  d.setDate(d.getDate() + amount)
  return d
}

function buildMonthDays(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const start = new Date(first)
  start.setDate(first.getDate() - first.getDay())
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    return d
  })
}

function defaultScheduleTime(): Date {
  const d = new Date()
  d.setSeconds(0, 0)
  d.setMinutes(Math.ceil(d.getMinutes() / 10) * 10)
  return d
}

function eventColor(meeting: Meeting, tags: Tag[]): string {
  if (!meeting.tag) return FALLBACK_EVENT_COLOR
  return tags.find((t) => t.name === meeting.tag)?.color ?? FALLBACK_EVENT_COLOR
}

function compactEventTitle(meeting: Meeting): string {
  return meeting.tag ? `#${meeting.tag} ${meeting.title}` : meeting.title
}

function participantLine(meeting: Meeting): string {
  const [first, ...rest] = meeting.participants
  if (!first) return '참석자 없음'
  return rest.length > 0 ? `${first.name} 외 ${rest.length}명` : first.name
}

function renderParticipantStack(meeting: Meeting) {
  if (meeting.participants.length === 0) {
    return <span className="day-planner-participants-empty">참석자 없음</span>
  }
  return (
    <span className="day-planner-participant-stack" title={participantLine(meeting)}>
      <AvatarStack participants={meeting.participants} max={2} />
    </span>
  )
}

export default function CalendarPage() {
  const navigate = useNavigate()
  const confirm = useConfirm()
  const [currentMonth, setCurrentMonth] = useState(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), 1)
  })
  const [meetings, setMeetings] = useState<Meeting[] | null>(null)
  const [tags, setTags] = useState<Tag[]>([])
  const [reloadKey, setReloadKey] = useState(0)
  const [detailId, setDetailId] = useState<number | null>(null)
  const [selectedDay, setSelectedDay] = useState<Date | null>(null)

  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [scheduleTitle, setScheduleTitle] = useState('')
  const [scheduleDate, setScheduleDate] = useState(() => inputDate(new Date()))
  const [scheduleTime, setScheduleTime] = useState(() => inputTime(defaultScheduleTime()))
  const [scheduleTag, setScheduleTag] = useState<string | null>(null)
  const [scheduleParticipants, setScheduleParticipants] = useState<Participant[]>([])
  const [participantPickerOpen, setParticipantPickerOpen] = useState(false)
  const [scheduleError, setScheduleError] = useState('')
  const [savingSchedule, setSavingSchedule] = useState(false)
  const [editingScheduleId, setEditingScheduleId] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    api
      .listMeetings()
      .then((list) => {
        if (alive) setMeetings(list)
      })
      .catch(() => {
        if (alive) setMeetings([])
      })
    api
      .listTags()
      .then((list) => {
        if (alive) setTags(list)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [reloadKey])

  const days = useMemo(() => buildMonthDays(currentMonth), [currentMonth])
  const todayKey = dateKey(new Date())
  const monthKey = `${currentMonth.getFullYear()}-${currentMonth.getMonth()}`

  const holidaysByDay = useMemo(() => {
    const map = new Map<string, KoreanHoliday[]>()
    const years = new Set(days.map((day) => day.getFullYear()))
    for (const year of years) {
      for (const [key, holidays] of getKoreanHolidaysForYear(year)) {
        map.set(key, holidays)
      }
    }
    return map
  }, [days])

  const meetingsByDay = useMemo(() => {
    const map = new Map<string, Meeting[]>()
    for (const meeting of meetings ?? []) {
      const key = dateKey(meeting.started_at)
      if (!key) continue
      const list = map.get(key)
      if (list) list.push(meeting)
      else map.set(key, [meeting])
    }
    for (const list of map.values()) {
      list.sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime())
    }
    return map
  }, [meetings])

  const selectedDayItems = useMemo(() => {
    if (!selectedDay) return []
    return meetingsByDay.get(dateKey(selectedDay)) ?? []
  }, [meetingsByDay, selectedDay])

  const selectedDaySchedules = useMemo(
    () => selectedDayItems.filter((meeting) => meeting.status === 'scheduled'),
    [selectedDayItems],
  )

  const selectedDayRecords = useMemo(
    () => selectedDayItems.filter((meeting) => meeting.status !== 'scheduled'),
    [selectedDayItems],
  )

  const selectedDayHolidays = useMemo(() => {
    if (!selectedDay) return []
    return holidaysByDay.get(dateKey(selectedDay)) ?? []
  }, [holidaysByDay, selectedDay])

  const openSchedule = (date?: Date) => {
    const base = date ?? defaultScheduleTime()
    setEditingScheduleId(null)
    setScheduleTitle('')
    setScheduleDate(inputDate(base))
    setScheduleTime(date ? '09:00' : inputTime(base))
    setScheduleTag(null)
    setScheduleParticipants([])
    setScheduleError('')
    setScheduleOpen(true)
  }

  const openScheduleFromDay = (date: Date) => {
    setSelectedDay(date)
    openSchedule(date)
  }

  const openScheduleEdit = (meeting: Meeting) => {
    const startedAt = toDate(meeting.started_at) ?? defaultScheduleTime()
    setEditingScheduleId(meeting.id)
    setScheduleTitle(meeting.title)
    setScheduleDate(inputDate(startedAt))
    setScheduleTime(inputTime(startedAt))
    setScheduleTag(meeting.tag)
    setScheduleParticipants(meeting.participants)
    setScheduleError('')
    setParticipantPickerOpen(false)
    setScheduleOpen(true)
  }

  const moveSelectedDay = (date: Date) => {
    setSelectedDay(date)
    setCurrentMonth(new Date(date.getFullYear(), date.getMonth(), 1))
  }

  const openMeetingDetail = (meeting: Meeting) => {
    if (meeting.status === 'scheduled') return
    setDetailId(meeting.id)
  }

  const handleDeleteSchedule = async (meeting: Meeting) => {
    const ok = await confirm({
      title: `'${meeting.title}' 일정을 삭제할까요?`,
      message: '삭제한 일정은 휴지통으로 이동돼요.',
      confirmLabel: '삭제',
      danger: true,
    })
    if (!ok) return
    try {
      await api.deleteMeeting(meeting.id)
      setMeetings((prev) => (prev ? prev.filter((item) => item.id !== meeting.id) : prev))
    } catch (err) {
      alert(err instanceof Error ? err.message : '일정을 삭제하지 못했어요.')
    }
  }

  const closeSchedule = () => {
    if (savingSchedule) return
    setParticipantPickerOpen(false)
    setScheduleOpen(false)
    setEditingScheduleId(null)
  }

  const handleSaveSchedule = async (e: FormEvent) => {
    e.preventDefault()
    const title = scheduleTitle.trim()
    if (!title) {
      setScheduleError('일정 제목을 입력해주세요.')
      return
    }
    if (!scheduleDate || !scheduleTime) {
      setScheduleError('일정 날짜와 시간을 선택해주세요.')
      return
    }

    setSavingSchedule(true)
    setScheduleError('')
    try {
      const payload = {
        title,
        tag: scheduleTag ?? '',
        started_at: `${scheduleDate}T${scheduleTime}`,
        participant_ids: scheduleParticipants.map((p) => p.id),
      }
      const saved =
        editingScheduleId === null
          ? await api.createSchedule({
              ...payload,
              tag: scheduleTag ?? undefined,
            })
          : await api.updateMeeting(editingScheduleId, payload)
      setMeetings((prev) => {
        if (!prev) return [saved]
        if (editingScheduleId === null) return [saved, ...prev]
        return prev.map((item) => (item.id === saved.id ? saved : item))
      })
      const d = toDate(saved.started_at)
      if (d) {
        setCurrentMonth(new Date(d.getFullYear(), d.getMonth(), 1))
        if (selectedDay) setSelectedDay(d)
      }
      setScheduleOpen(false)
      setEditingScheduleId(null)
    } catch (err) {
      setScheduleError(err instanceof Error ? err.message : '일정을 저장하지 못했어요.')
    } finally {
      setSavingSchedule(false)
    }
  }

  return (
    <div className="page calendar-page">
      <div className="calendar-page-head">
        <div>
          <h1 className="page-title">캘린더</h1>
          <p className="calendar-sub">
            진행한 회의와 예정된 회의 일정을 한 달 단위로 확인합니다.
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => openSchedule()}>
          + 일정 등록
        </button>
      </div>

      <div className="calendar-toolbar">
        <div className="calendar-month-nav" aria-label="월 이동">
          <button
            type="button"
            className="btn btn-ghost calendar-nav-btn"
            onClick={() => setCurrentMonth((m) => addMonths(m, -1))}
            aria-label="이전 달"
          >
            ‹
          </button>
          <strong className="calendar-month-title">{monthTitle(currentMonth)}</strong>
          <button
            type="button"
            className="btn btn-ghost calendar-nav-btn"
            onClick={() => setCurrentMonth((m) => addMonths(m, 1))}
            aria-label="다음 달"
          >
            ›
          </button>
        </div>
        <div className="calendar-toolbar-right">
          <button
            type="button"
            className="btn btn-soft"
            onClick={() => {
              const now = new Date()
              setCurrentMonth(new Date(now.getFullYear(), now.getMonth(), 1))
            }}
          >
            오늘
          </button>
        </div>
      </div>

      <div className="card calendar-shell">
        {meetings === null ? (
          <div className="calendar-loading">
            <span className="spinner" />
          </div>
        ) : (
          <div className="calendar-scroll">
            <div className="calendar-grid" data-month={monthKey}>
              {DAY_NAMES.map((day) => (
                <div key={day} className="calendar-weekday">
                  {day}
                </div>
              ))}

              {days.map((day) => {
                const key = dateKey(day)
                const items = meetingsByDay.get(key) ?? []
                const outside = day.getMonth() !== currentMonth.getMonth()
                const isToday = key === todayKey
                const weekday = day.getDay()
                const holidayItems = holidaysByDay.get(key) ?? []
                const holidayLabel = holidayNames(holidayItems)
                return (
                  <div
                    key={key}
                    className={`calendar-day${outside ? ' outside' : ''}${isToday ? ' today' : ''}${weekday === 0 ? ' sunday' : ''}${weekday === 6 ? ' saturday' : ''}${holidayItems.length > 0 ? ' holiday' : ''}${items.length > 2 ? ' has-more' : ''}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`${dayTitle(day)} 일정 보기`}
                    onClick={() => setSelectedDay(day)}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setSelectedDay(day)
                      }
                    }}
                  >
                    <div className="calendar-day-head">
                      <span className="calendar-day-number">{day.getDate()}</span>
                      {items.length > 2 && (
                        <span
                          className="calendar-day-more-badge"
                          aria-label={`${items.length - 2}개 더 있음`}
                        >
                          +{items.length - 2}개
                        </span>
                      )}
                    </div>
                    {holidayItems.length > 0 && (
                      <div className="calendar-holiday-label" title={holidayLabel}>
                        {holidayLabel}
                      </div>
                    )}
                    <div className="calendar-events">
                      {items.slice(0, 2).map((meeting) => {
                        const isScheduled = meeting.status === 'scheduled'
                        return (
                          <button
                            key={meeting.id}
                            type="button"
                            className={`calendar-event-pill${isScheduled ? ' scheduled' : ' recorded'}`}
                            title={compactEventTitle(meeting)}
                            aria-disabled={isScheduled}
                            onClick={(e) => {
                              e.stopPropagation()
                              openMeetingDetail(meeting)
                            }}
                          >
                            <span className="calendar-event-kind">
                              {isScheduled ? '일정' : '회의'}
                            </span>
                            <span className="calendar-event-time">{timeLabel(meeting.started_at)}</span>
                            <span className="calendar-event-title">{compactEventTitle(meeting)}</span>
                            {meeting.locked && <span className="calendar-event-lock">🔒</span>}
                          </button>
                        )
                      })}
                      {items.length > 2 && (
                        <span className="calendar-more">+{items.length - 2}개 더 있음</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      <Modal
        open={selectedDay !== null}
        title={
          selectedDay ? (
            <span className="day-planner-title-nav">
              <button
                type="button"
                className="day-planner-title-nav-btn"
                aria-label="이전 날짜"
                onClick={(e) => {
                  e.stopPropagation()
                  moveSelectedDay(addDays(selectedDay, -1))
                }}
              >
                ‹
              </button>
              <span>{dayTitle(selectedDay)}</span>
              <button
                type="button"
                className="day-planner-title-nav-btn"
                aria-label="다음 날짜"
                onClick={(e) => {
                  e.stopPropagation()
                  moveSelectedDay(addDays(selectedDay, 1))
                }}
              >
                ›
              </button>
            </span>
          ) : (
            ''
          )
        }
        width={1040}
        onClose={() => setSelectedDay(null)}
      >
        {selectedDay && (
          <div className="day-planner">
            {selectedDayHolidays.length > 0 && (
              <div className="day-modal-holidays">
                {selectedDayHolidays.map((holiday, index) => (
                  <span
                    key={`${holiday.name}-${index}`}
                    className={`day-modal-holiday-chip${holiday.substitute ? ' substitute' : ''}`}
                  >
                    {holiday.name}
                  </span>
                ))}
              </div>
            )}

            <div className="day-planner-columns">
              <section className="day-planner-panel">
                <div className="day-planner-panel-head">
                  <h3>
                    <span className="day-planner-section-icon schedule">▣</span>
                    일정
                    <span className="day-planner-count">{selectedDaySchedules.length}</span>
                  </h3>
                </div>

                <div className="day-planner-list">
                  {selectedDaySchedules.length === 0 ? (
                    <div className="day-planner-empty">등록된 일정이 없어요.</div>
                  ) : (
                    selectedDaySchedules.map((meeting) => {
                      const color = eventColor(meeting, tags)
                      return (
                        <div
                          key={meeting.id}
                          className="day-planner-card schedule"
                          role="button"
                          tabIndex={0}
                          onClick={() => openScheduleEdit(meeting)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              openScheduleEdit(meeting)
                            }
                          }}
                        >
                          <div className="day-planner-card-time">{timeLabel(meeting.started_at)}</div>
                          <div className="day-planner-card-main">
                            <strong className="day-planner-card-title">{meeting.title}</strong>
                            <div className="day-planner-meta-line">
                              {meeting.tag && (
                                <span
                                  className="tag-pill day-modal-tag"
                                  style={{
                                    color,
                                    borderColor: color,
                                    background: `color-mix(in srgb, ${color} 10%, transparent)`,
                                  }}
                                >
                                  #{meeting.tag}
                                </span>
                              )}
                              {renderParticipantStack(meeting)}
                            </div>
                          </div>
                          <div className="day-planner-card-actions">
                            <span className="day-planner-status schedule">• 예정</span>
                            <button
                              type="button"
                              className="day-planner-delete"
                              aria-label={`${meeting.title} 일정 삭제`}
                              title="일정 삭제"
                              onClick={(e) => {
                                e.stopPropagation()
                                void handleDeleteSchedule(meeting)
                              }}
                            >
                              🗑
                            </button>
                          </div>
                        </div>
                      )
                    })
                  )}
                </div>

                <button
                  type="button"
                  className="day-planner-add-row"
                  onClick={() => openScheduleFromDay(selectedDay)}
                >
                  + 일정 추가
                </button>
              </section>

              <section className="day-planner-panel">
                <div className="day-planner-panel-head">
                  <h3>
                    <span className="day-planner-section-icon record">▤</span>
                    회의 기록
                    <span className="day-planner-count">{selectedDayRecords.length}</span>
                  </h3>
                </div>

                <div className="day-planner-list">
                  {selectedDayRecords.length === 0 ? (
                    <div className="day-planner-empty">기록된 회의가 없어요.</div>
                  ) : (
                    selectedDayRecords.map((meeting) => {
                      const color = eventColor(meeting, tags)
                      return (
                        <button
                          key={meeting.id}
                          type="button"
                          className="day-planner-card record"
                          onClick={() => openMeetingDetail(meeting)}
                        >
                          <div className="day-planner-card-time record-time">
                            {formatKoreanDateTime(meeting.started_at)}
                          </div>
                          <div className="day-planner-card-main">
                            <strong className="day-planner-card-title">
                              {meeting.title}
                              {meeting.locked && (
                                <span
                                  className="lock-pill lock-pill-icon"
                                  title="잠금됨"
                                  aria-label="잠금됨"
                                >
                                  🔒
                                </span>
                              )}
                            </strong>
                            <div className="day-planner-meta-line">
                              {meeting.tag && (
                                <span
                                  className="tag-pill day-modal-tag"
                                  style={{
                                    color,
                                    borderColor: color,
                                    background: `color-mix(in srgb, ${color} 10%, transparent)`,
                                  }}
                                >
                                  #{meeting.tag}
                                </span>
                              )}
                              {renderParticipantStack(meeting)}
                            </div>
                          </div>
                        </button>
                      )
                    })
                  )}
                </div>

                <button
                  type="button"
                  className="day-planner-add-row"
                  onClick={() => {
                    setSelectedDay(null)
                    navigate('/record')
                  }}
                >
                  + 회의 기록 추가
                </button>
              </section>
            </div>

            <p className="day-planner-timezone">ⓘ 모든 시간은 Asia/Seoul 기준입니다.</p>
          </div>
        )}
      </Modal>

      <Modal open={detailId !== null} title="회의 내용" width={960} onClose={() => setDetailId(null)}>
        {detailId !== null && (
          <MeetingDetailView
            meetingId={detailId}
            onBack={() => setDetailId(null)}
            onDeleted={() => {
              setDetailId(null)
              setReloadKey((k) => k + 1)
            }}
            onChanged={() => setReloadKey((k) => k + 1)}
          />
        )}
      </Modal>

      <Modal
        open={scheduleOpen}
        title={editingScheduleId === null ? '회의 일정 등록' : '회의 일정 수정'}
        width={640}
        onClose={closeSchedule}
      >
        <form className="schedule-form" onSubmit={handleSaveSchedule}>
          {scheduleError && <div className="schedule-error">{scheduleError}</div>}

          <label className="schedule-field">
            <span className="field-label">일정 제목</span>
            <input
              className="input"
              placeholder="회의 제목"
              value={scheduleTitle}
              autoFocus
              onChange={(e) => {
                setScheduleTitle(e.target.value)
                if (scheduleError) setScheduleError('')
              }}
            />
          </label>

          <div className="schedule-field-grid">
            <label className="schedule-field">
              <span className="field-label">날짜</span>
              <input
                className="input"
                type="date"
                value={scheduleDate}
                onChange={(e) => setScheduleDate(e.target.value)}
              />
            </label>
            <label className="schedule-field">
              <span className="field-label">시간</span>
              <input
                className="input"
                type="time"
                value={scheduleTime}
                onChange={(e) => setScheduleTime(e.target.value)}
              />
            </label>
          </div>

          <div className="schedule-field">
            <span className="field-label">태그</span>
            <TagPicker value={scheduleTag} onChange={setScheduleTag} />
          </div>

          <div className="schedule-participants-head">
            <div>
              <span className="field-label">참석자</span>
              <p className="muted">선택한 참석자는 일정 상세에도 함께 표시됩니다.</p>
            </div>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setParticipantPickerOpen(true)}
            >
              참석자 선택
            </button>
          </div>

          {scheduleParticipants.length > 0 && (
            <div className="schedule-participants-list">
              <AvatarStack participants={scheduleParticipants} max={6} />
              <span className="muted">{scheduleParticipants.length}명 선택됨</span>
            </div>
          )}

          <div className="schedule-preview">
            <div className="schedule-preview-label">캘린더 표시</div>
            <span
              className="calendar-event-pill schedule-preview-pill"
              style={{
                color:
                  scheduleTag == null
                    ? FALLBACK_EVENT_COLOR
                    : tags.find((t) => t.name === scheduleTag)?.color ?? FALLBACK_EVENT_COLOR,
                borderColor:
                  scheduleTag == null
                    ? FALLBACK_EVENT_COLOR
                    : tags.find((t) => t.name === scheduleTag)?.color ?? FALLBACK_EVENT_COLOR,
              }}
            >
              {scheduleTime && <span className="calendar-event-time">{scheduleTime}</span>}
              <span className="calendar-event-title">
                {scheduleTag ? `#${scheduleTag} ` : ''}
                {scheduleTitle.trim() || '새 회의 일정'}
              </span>
            </span>
          </div>

          <div className="schedule-actions">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={closeSchedule}
              disabled={savingSchedule}
            >
              취소
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={savingSchedule || !scheduleTitle.trim()}
            >
              {savingSchedule
                ? editingScheduleId === null
                  ? '등록 중...'
                  : '저장 중...'
                : editingScheduleId === null
                  ? '등록'
                  : '저장'}
            </button>
          </div>
        </form>

        <ParticipantPicker
          open={participantPickerOpen}
          onClose={() => setParticipantPickerOpen(false)}
          selected={scheduleParticipants}
          onChange={setScheduleParticipants}
        />
      </Modal>
    </div>
  )
}
