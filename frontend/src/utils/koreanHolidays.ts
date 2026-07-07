export interface KoreanHoliday {
  name: string
  substitute?: boolean
}

type HolidayRow = [date: string, name: string, substitute?: boolean]

const LUNAR_AND_SUBSTITUTE_HOLIDAYS: Record<number, HolidayRow[]> = {
  2025: [
    ['2025-01-28', '설날 연휴'],
    ['2025-01-29', '설날'],
    ['2025-01-30', '설날 연휴'],
    ['2025-03-03', '대체공휴일', true],
    ['2025-05-05', '부처님오신날'],
    ['2025-05-06', '대체공휴일', true],
    ['2025-10-05', '추석 연휴'],
    ['2025-10-06', '추석'],
    ['2025-10-07', '추석 연휴'],
    ['2025-10-08', '대체공휴일', true],
  ],
  2026: [
    ['2026-02-16', '설날 연휴'],
    ['2026-02-17', '설날'],
    ['2026-02-18', '설날 연휴'],
    ['2026-03-02', '대체공휴일', true],
    ['2026-05-24', '부처님오신날'],
    ['2026-05-25', '대체공휴일', true],
    ['2026-08-17', '대체공휴일', true],
    ['2026-09-24', '추석 연휴'],
    ['2026-09-25', '추석'],
    ['2026-09-26', '추석 연휴'],
    ['2026-10-05', '대체공휴일', true],
  ],
  2027: [
    ['2027-02-06', '설날 연휴'],
    ['2027-02-07', '설날'],
    ['2027-02-08', '설날 연휴'],
    ['2027-02-09', '대체공휴일', true],
    ['2027-05-03', '대체공휴일', true],
    ['2027-05-13', '부처님오신날'],
    ['2027-07-19', '대체공휴일', true],
    ['2027-08-16', '대체공휴일', true],
    ['2027-09-14', '추석 연휴'],
    ['2027-09-15', '추석'],
    ['2027-09-16', '추석 연휴'],
    ['2027-10-04', '대체공휴일', true],
    ['2027-10-11', '대체공휴일', true],
    ['2027-12-27', '대체공휴일', true],
  ],
  2028: [
    ['2028-01-26', '설날 연휴'],
    ['2028-01-27', '설날'],
    ['2028-01-28', '설날 연휴'],
    ['2028-05-02', '부처님오신날'],
    ['2028-10-02', '추석 연휴'],
    ['2028-10-03', '추석'],
    ['2028-10-04', '추석 연휴'],
    ['2028-10-05', '대체공휴일', true],
  ],
  2029: [
    ['2029-02-12', '설날 연휴'],
    ['2029-02-13', '설날'],
    ['2029-02-14', '설날 연휴'],
    ['2029-05-07', '대체공휴일', true],
    ['2029-05-20', '부처님오신날'],
    ['2029-05-21', '대체공휴일', true],
    ['2029-09-21', '추석 연휴'],
    ['2029-09-22', '추석'],
    ['2029-09-23', '추석 연휴'],
    ['2029-09-24', '대체공휴일', true],
  ],
  2030: [
    ['2030-02-02', '설날 연휴'],
    ['2030-02-03', '설날'],
    ['2030-02-04', '설날 연휴'],
    ['2030-02-05', '대체공휴일', true],
    ['2030-05-06', '대체공휴일', true],
    ['2030-05-09', '부처님오신날'],
    ['2030-09-11', '추석 연휴'],
    ['2030-09-12', '추석'],
    ['2030-09-13', '추석 연휴'],
  ],
}

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (year: number, month: number, day: number) => `${year}-${pad(month)}-${pad(day)}`

function fixedHolidayRows(year: number): HolidayRow[] {
  const rows: HolidayRow[] = [
    [ymd(year, 1, 1), '새해'],
    [ymd(year, 3, 1), '삼일절'],
    [ymd(year, 5, 5), '어린이날'],
    [ymd(year, 6, 6), '현충일'],
    [ymd(year, 8, 15), '광복절'],
    [ymd(year, 10, 3), '개천절'],
    [ymd(year, 10, 9), '한글날'],
    [ymd(year, 12, 25), '기독탄신일'],
  ]
  if (year >= 2026) {
    rows.push([ymd(year, 5, 1), '노동절'])
    rows.push([ymd(year, 7, 17), '제헌절'])
  }
  return rows
}

function addHoliday(map: Map<string, KoreanHoliday[]>, date: string, holiday: KoreanHoliday) {
  const list = map.get(date)
  if (list) list.push(holiday)
  else map.set(date, [holiday])
}

export function getKoreanHolidaysForYear(year: number): Map<string, KoreanHoliday[]> {
  const map = new Map<string, KoreanHoliday[]>()
  for (const [date, name, substitute] of fixedHolidayRows(year)) {
    addHoliday(map, date, { name, substitute })
  }
  for (const [date, name, substitute] of LUNAR_AND_SUBSTITUTE_HOLIDAYS[year] ?? []) {
    addHoliday(map, date, { name, substitute })
  }
  return map
}

export function holidayNames(holidays: KoreanHoliday[]): string {
  return holidays.map((h) => h.name).join(' · ')
}
