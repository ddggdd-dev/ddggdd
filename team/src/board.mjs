// Pure board logic shared by the server and the browser.
// A "mark" is one member's note for one date: blocked (안 되는 날) or preferred (좋은 날).
// Times are "HH:MM" strings; "24:00" closes an all-day range.

export const SLOTS = {
  dinner: { label: '저녁', start: '18:00', end: '22:00' },
  lunch: { label: '점심', start: '11:30', end: '13:30' },
  allday: { label: '하루 종일', start: '00:00', end: '24:00' },
  day: { label: '시간 미정', start: '00:00', end: '24:00' },
};

export const TYPES = ['회식', '송년회', '워크숍', '점심', '기타'];

export function validDate(v) {
  if (typeof v !== 'string' || !/^20\d\d-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export function validTime(v, allowEnd = false) {
  return typeof v === 'string' && (/^([01]\d|2[0-3]):[0-5]\d$/.test(v) || (allowEnd && v === '24:00'));
}

export function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function todayKST(now = Date.now()) {
  return new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// Resolve the time window the board is judged against.
export function resolveSlot(slot, start, end) {
  if (slot === 'custom') {
    if (!validTime(start) || !validTime(end, true) || start >= end) return null;
    return { key: 'custom', start, end, dayLevel: false };
  }
  const s = SLOTS[slot] || SLOTS.dinner;
  return { key: SLOTS[slot] ? slot : 'dinner', start: s.start, end: s.end, dayLevel: slot === 'day' };
}

const overlaps = (m, s) => m.start < s.end && m.end > s.start;
const covers = (m, s) => m.start <= s.start && m.end >= s.end;

// One member on one date, judged against the slot.
// unknown: never saved anything and no linked calendar, so we do not assume they are free.
// part: blocked for part of the day while the time is still undecided (shown as a hint only).
// A manual mark always wins over the linked calendar; without one, calendar busy time counts as blocked.
export function memberStatus(member, mark, slot, busy = []) {
  if (!member.updatedAt) return 'unknown';
  if (!mark) {
    if (!busy.length) return 'yes';
    if (slot.dayLevel) return busy.some((b) => b.start === '00:00' && b.end === '24:00') ? 'no' : 'part';
    return busy.some((b) => overlaps(b, slot)) ? 'no' : 'yes';
  }
  if (mark.kind === 'free') return 'yes';
  if (mark.kind === 'blocked') {
    if (slot.dayLevel) return mark.start === '00:00' && mark.end === '24:00' ? 'no' : 'part';
    return overlaps(mark, slot) ? 'no' : 'yes';
  }
  if (mark.kind === 'preferred') return slot.dayLevel || covers(mark, slot) ? 'prefer' : 'yes';
  return 'yes';
}

// marks: [{member, date, kind, start, end}]; busy: [{member, date, start, end}]; members: [{id, name, updatedAt}]
export function summarizeDays(dates, members, marks, slot, busy = []) {
  const byKey = new Map(marks.map((m) => [m.member + '|' + m.date, m]));
  const busyByKey = new Map();
  for (const b of busy) {
    const k = b.member + '|' + b.date;
    if (!busyByKey.has(k)) busyByKey.set(k, []);
    busyByKey.get(k).push(b);
  }
  return dates.map((date) => {
    const out = { date, total: members.length, yes: [], prefer: [], no: [], part: [], unknown: [] };
    for (const member of members) {
      const k = member.id + '|' + date;
      const status = memberStatus(member, byKey.get(k), slot, busyByKey.get(k));
      out[status].push(member.id);
      if (status === 'prefer') out.yes.push(member.id);
    }
    return out;
  });
}

const isWeekend = (date) => [0, 6].includes(new Date(date + 'T00:00:00Z').getUTCDay());

// Fewest blocked first, then fewest unknown, then most available, then most preferred, then earliest.
// Recommendations start tomorrow; weekends only when asked (company teams rarely meet then).
export function rankDays(days, today, { weekends = false } = {}) {
  return days
    .filter((d) => d.date > today && d.total > 0 && (weekends || !isWeekend(d.date)))
    .slice()
    .sort((a, b) =>
      a.no.length - b.no.length ||
      a.unknown.length - b.unknown.length ||
      b.yes.length - a.yes.length ||
      b.prefer.length - a.prefer.length ||
      a.date.localeCompare(b.date));
}
