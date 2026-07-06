import type { MeetingStatus } from '../types'
import { STATUS_LABEL, STATUS_TONE } from '../utils'
import './components.css'

export interface StatusBadgeProps {
  status: MeetingStatus
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const tone = STATUS_TONE[status]
  const pulsing = status === 'recording' || status === 'transcribing' || status === 'summarizing'
  return (
    <span className={`badge badge-${tone}`}>
      <span className={`badge-dot${pulsing ? ' badge-dot-pulse' : ''}`} />
      {STATUS_LABEL[status]}
    </span>
  )
}

export default StatusBadge
