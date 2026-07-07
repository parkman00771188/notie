import { useNavigate, useParams } from 'react-router-dom'
import { MeetingDetailView } from '../components/MeetingDetailView'
import './MeetingDetailPage.css'

/** /meetings/:id — 본문은 MeetingDetailView가 담당하는 얇은 래퍼 */
export default function MeetingDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()

  return (
    <div className="page detail-page">
      <MeetingDetailView meetingId={Number(id)} onBack={() => navigate('/meetings')} />
    </div>
  )
}
