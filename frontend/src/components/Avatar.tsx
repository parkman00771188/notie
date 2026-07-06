import type { Participant } from '../types'
import './components.css'

const DEFAULT_COLOR = '#2563eb'

export interface AvatarProps {
  name: string
  color?: string
  size?: number
}

export function Avatar({ name, color = DEFAULT_COLOR, size = 32 }: AvatarProps) {
  const initial = (name ?? '').trim().charAt(0).toUpperCase() || '?'
  return (
    <span
      className="avatar"
      title={name}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(10, Math.round(size * 0.42)),
        color,
        background: `color-mix(in srgb, ${color} 14%, #ffffff)`,
      }}
    >
      {initial}
    </span>
  )
}

export interface AvatarStackProps {
  participants: Participant[]
  max?: number
}

export function AvatarStack({ participants, max = 4 }: AvatarStackProps) {
  const shown = participants.slice(0, max)
  const rest = participants.length - shown.length
  return (
    <span className="avatar-stack">
      {shown.map((p) => (
        <Avatar key={p.id} name={p.name} color={p.color} size={28} />
      ))}
      {rest > 0 && (
        <span
          className="avatar avatar-more"
          style={{ width: 28, height: 28, fontSize: 11.5 }}
          title={`외 ${rest}명`}
        >
          +{rest}
        </span>
      )}
    </span>
  )
}

export default Avatar
