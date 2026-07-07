"""회의록 PDF 내보내기 — export_doc(docx)과 같은 [회의록] 양식 레이아웃.

fpdf2로 로컬에서 직접 생성한다(외부 프로그램 불필요). 한글은 Windows의
맑은 고딕(TTF)을 임베드하며, 폰트를 찾지 못하면 한국어 RuntimeError를 낸다.

구성: 회의록 제목 → 회의일시/회의명/참석자 표 → [회의내용] 섹션 바 + 본문
      (1. 내용/핵심 내용/결정 사항/추가 확인 필요/타임라인) → [특이사항] 빈 박스
"""

from pathlib import Path

from .export_doc import _fmt_clock, _fmt_datetime, format_participants_grouped

FONT = "Malgun"
LABEL_BG = (231, 230, 230)

# 맑은 고딕 우선, 없으면 다른 한글 폰트 폴백
_FONT_CANDIDATES = [
    (r"C:\Windows\Fonts\malgun.ttf", r"C:\Windows\Fonts\malgunbd.ttf"),
    (r"C:\Windows\Fonts\gulim.ttc", None),
]


def _register_fonts(pdf) -> None:
    for regular, bold in _FONT_CANDIDATES:
        if Path(regular).is_file():
            pdf.add_font(FONT, "", regular)
            pdf.add_font(FONT, "B", bold if bold and Path(bold).is_file() else regular)
            return
    raise RuntimeError(
        "PDF 생성에 사용할 한글 폰트를 찾지 못했습니다 (맑은 고딕). Word(.docx)로 내보내주세요."
    )


def _section_bar(pdf, text: str) -> None:
    pdf.set_font(FONT, "B", 11)
    pdf.set_fill_color(*LABEL_BG)
    pdf.cell(0, 9, text, border=1, fill=True, new_x="LMARGIN", new_y="NEXT")
    pdf.ln(2.5)


def _heading(pdf, text: str) -> None:
    pdf.ln(1.5)
    pdf.set_font(FONT, "B", 11)
    pdf.multi_cell(0, 6.5, text, new_x="LMARGIN", new_y="NEXT")
    pdf.ln(0.5)


def _line(pdf, text: str, indent: float = 0.0, size: float = 10) -> None:
    pdf.set_font(FONT, "", size)
    if indent:
        pdf.set_x(pdf.l_margin + indent)
    # markdown=True → **굵게** 인라인 지원
    pdf.multi_cell(0, 6, text, new_x="LMARGIN", new_y="NEXT", markdown=True)


def _markdown(pdf, md: str) -> None:
    """discussion 마크다운(### 소제목 / - 불릿 / 문단) 렌더."""
    for raw in md.splitlines():
        text = raw.strip()
        if not text:
            continue
        if text.startswith("### "):
            _heading(pdf, text[4:])
        elif text.startswith("## "):
            _heading(pdf, text[3:])
        elif text.startswith("- [x] ") or text.startswith("- [X] "):
            _line(pdf, f"▣ {text[6:]}", indent=3)
        elif text.startswith("- [ ] "):
            _line(pdf, f"□ {text[6:]}", indent=3)
        elif text.startswith("- "):
            _line(pdf, f"• {text[2:]}", indent=3)
        else:
            _line(pdf, text)


def build_minutes_pdf(
    meeting: dict,
    participants: list[dict],
    bookmarks: list[dict],
    summary: dict | None,
) -> bytes:
    from fpdf import FPDF
    from fpdf.fonts import FontFace

    pdf = FPDF(format="A4")
    pdf.set_margins(18, 16, 18)
    pdf.set_auto_page_break(True, margin=16)
    _register_fonts(pdf)
    pdf.add_page()

    # 제목
    pdf.set_font(FONT, "B", 20)
    pdf.cell(0, 12, "회의록", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(3)

    # ---- 표: 회의일시/회의명 + 참석자 ----
    tag = str(meeting.get("tag") or "").strip()
    meeting_name = str(meeting.get("title") or "")
    if tag:
        meeting_name += f"  (#{tag})"

    label_style = FontFace(emphasis="BOLD", fill_color=LABEL_BG)
    pdf.set_font(FONT, "", 10)
    with pdf.table(
        col_widths=(24, 62, 20, 68),
        text_align="LEFT",
        line_height=7,
        padding=1.5,
    ) as table:
        row = table.row()
        row.cell("회의일시", style=label_style, align="CENTER")
        row.cell(_fmt_datetime(meeting.get("started_at")))
        row.cell("회의명", style=label_style, align="CENTER")
        row.cell(meeting_name)
        row = table.row()
        row.cell("참석자", style=label_style, align="CENTER")
        row.cell(format_participants_grouped(participants) or "-", colspan=3)

    pdf.ln(5)

    # ---- 회의내용 ----
    _section_bar(pdf, "회의내용")

    summary = summary or {}
    section_no = 1

    discussion = str(summary.get("discussion") or "").strip()
    if discussion:
        _heading(pdf, f"{section_no}. 내용")
        section_no += 1
        _markdown(pdf, discussion)

    key_points = summary.get("key_points") or []
    if key_points:
        _heading(pdf, f"{section_no}. 핵심 내용")
        section_no += 1
        for item in key_points:
            _line(pdf, f"• {item}", indent=3)

    _heading(pdf, f"{section_no}. 결정 사항")
    section_no += 1
    decisions = summary.get("decisions") or []
    if decisions:
        for item in decisions:
            _line(pdf, f"▣ {item}", indent=3)
    else:
        _line(pdf, "명확히 확정된 결정사항은 없음", indent=3)

    followups = summary.get("followups") or []
    if followups:
        _heading(pdf, f"{section_no}. 추가 확인 필요 사항")
        section_no += 1
        for item in followups:
            _line(pdf, f"□ {item}", indent=3)

    timed = [b for b in bookmarks if b.get("kind") != "note"]
    if timed:
        _heading(pdf, f"{section_no}. 타임라인")
        section_no += 1
        for b in sorted(timed, key=lambda x: float(x.get("time_sec") or 0)):
            _line(
                pdf,
                f"**{_fmt_clock(b.get('time_sec'))}** — {str(b.get('title') or '').strip()}",
                indent=3,
            )

    if not discussion and not key_points and not decisions:
        _line(pdf, "요약이 아직 생성되지 않았습니다.")

    # ---- 특이사항 (빈 박스 — 출력 후 직접 작성) ----
    pdf.ln(5)
    _section_bar(pdf, "특이사항")
    pdf.cell(0, 24, "", border=1, new_x="LMARGIN", new_y="NEXT")

    return bytes(pdf.output())
