// Reads a person's own calendar through its iCal subscription address and keeps only busy times.
// Event titles, places and attendees are never returned or stored.
import ICAL from 'ical.js';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { addDays } from './src/board.mjs';

export class CalendarError extends Error {}
const fail = (m) => { throw new CalendarError(m); };

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_OCCURRENCES = 20000;
const KST_MS = 9 * 3600 * 1000;

// ---------- secret address at rest ----------
export function cipherFromKey(base64Key) {
  const key = base64Key ? Buffer.from(base64Key, 'base64') : null;
  if (!key || key.length !== 32) return null;
  return {
    encrypt(text) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
    },
    decrypt(blob) {
      const raw = Buffer.from(blob, 'base64');
      const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    },
  };
}

// ---------- which calendar is this ----------
export function providerOf(url) {
  const h = new URL(url).hostname;
  if (h.endsWith('google.com')) return '구글';
  if (h.endsWith('icloud.com')) return '아이폰(iCloud)';
  if (/outlook\.|office365\.com$|live\.com$/.test(h)) return '아웃룩';
  if (h.endsWith('kakao.com')) return '톡캘린더';
  if (h.endsWith('naver.com')) return '네이버';
  return '캘린더';
}

export function normalizeUrl(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 2000) fail('캘린더 주소를 붙여 넣어 주세요.');
  let s = input.trim();
  if (/^webcals?:\/\//i.test(s)) s = s.replace(/^webcals?:\/\//i, 'https://');
  let u;
  try { u = new URL(s); } catch { fail('주소 형식이 아니에요. https:// 또는 webcal:// 로 시작하는 주소를 넣어 주세요.'); }
  if (!['https:', 'http:'].includes(u.protocol)) fail('https:// 또는 webcal:// 로 시작하는 주소만 쓸 수 있어요.');
  if (u.username || u.password) fail('아이디나 비밀번호가 들어간 주소는 쓸 수 없어요.');
  if (u.port && !['80', '443'].includes(u.port)) fail('일반 웹 주소만 쓸 수 있어요.');
  if (isIP(u.hostname.replace(/^\[|\]$/g, ''))) fail('숫자 IP 주소는 쓸 수 없어요. 캘린더 서비스가 준 주소를 그대로 넣어 주세요.');
  if (!u.hostname.includes('.') || /\.(local|internal|localhost)$/i.test(u.hostname)) fail('공개 인터넷 주소만 쓸 수 있어요.');
  return u.toString();
}

// Private, loopback, link-local, carrier-grade NAT and other non-public ranges.
export function isPublicAddress(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 192 && b === 0) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::' || v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('ff')) return false;
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicAddress(mapped[1]);
  return true;
}

async function assertPublicHost(hostname, lookup) {
  let addrs;
  try {
    addrs = await lookup(hostname, { all: true });
  } catch {
    fail('캘린더 주소의 서버를 찾지 못했어요. 주소를 다시 확인해 주세요.');
  }
  if (!addrs.length || !addrs.every((a) => isPublicAddress(a.address))) fail('공개 인터넷 주소만 쓸 수 있어요.');
}

// ---------- download ----------
export async function fetchIcs(url, { fetcher = fetch, lookup = dnsLookup } = {}) {
  let current = normalizeUrl(url);
  for (let hop = 0; hop < 4; hop++) {
    const u = new URL(current);
    await assertPublicHost(u.hostname, lookup);
    let res;
    try {
      res = await fetcher(current, { redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { Accept: 'text/calendar, */*' } });
    } catch {
      fail('캘린더를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.');
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const next = res.headers.get('location');
      if (!next) fail('캘린더 주소가 다른 곳으로 넘어가는데, 갈 곳이 없어요.');
      current = normalizeUrl(new URL(next, current).toString());
      continue;
    }
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      fail('캘린더를 열 수 없어요. 주소가 바뀌었거나(재설정) 공개 설정이 꺼져 있을 수 있어요.');
    }
    if (!res.ok) fail(`캘린더 서버가 응답하지 않아요 (${res.status}). 잠시 후 다시 시도해 주세요.`);
    const reader = res.body?.getReader();
    if (!reader) fail('캘린더 내용이 비어 있어요.');
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) {
        await reader.cancel();
        fail('캘린더가 너무 커요 (5MB 초과). 일정이 적은 캘린더 주소를 넣어 주세요.');
      }
      chunks.push(value);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!/BEGIN:VCALENDAR/.test(text)) fail('캘린더 파일이 아니에요. 웹에서 보는 주소 말고 "iCal" 또는 ".ics" 구독 주소를 넣어 주세요.');
    return { text, finalUrl: current };
  }
  fail('주소가 너무 여러 번 다른 곳으로 넘어가요.');
}

// ---------- busy times ----------
const pad = (n) => String(n).padStart(2, '0');

// Wall-clock parts of an ICAL.Time in Korea time. Floating or unknown zones are read as Korea time.
function toKstMs(t) {
  const tzid = t.zone && t.zone.tzid;
  if (t.isDate || !t.zone || tzid === 'floating' || (tzid !== 'UTC' && !ICAL.TimezoneService.has(tzid))) {
    return Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute) ;
  }
  const u = t.convertToZone(ICAL.Timezone.utcTimezone);
  return Date.UTC(u.year, u.month - 1, u.day, u.hour, u.minute) + KST_MS;
}

function addSegments(out, startMs, endMs, allDay) {
  if (!(endMs > startMs)) {
    if (allDay) endMs = startMs + 86400000;
    else return;
  }
  let cursor = startMs;
  while (cursor < endMs) {
    const d = new Date(cursor);
    const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    const dayEnd = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
    const segEnd = Math.min(endMs, dayEnd);
    const start = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    const e = new Date(segEnd);
    const end = segEnd === dayEnd ? '24:00' : `${pad(e.getUTCHours())}:${pad(e.getUTCMinutes())}`;
    if (start < end) out.push({ date, start, end });
    cursor = segEnd;
  }
}

function mergeByDate(list) {
  const byDate = new Map();
  for (const b of list) {
    if (!byDate.has(b.date)) byDate.set(b.date, []);
    byDate.get(b.date).push(b);
  }
  const out = [];
  for (const [date, items] of [...byDate.entries()].sort()) {
    items.sort((a, b) => a.start.localeCompare(b.start));
    const merged = [];
    for (const it of items) {
      const last = merged.at(-1);
      if (last && it.start <= last.end) {
        if (it.end > last.end) last.end = it.end;
      } else {
        merged.push({ date, start: it.start, end: it.end });
      }
    }
    out.push(...merged);
  }
  return out;
}

const skip = (comp) => {
  const status = (comp.getFirstPropertyValue('status') || '').toString().toUpperCase();
  const transp = (comp.getFirstPropertyValue('transp') || '').toString().toUpperCase();
  return status === 'CANCELLED' || transp === 'TRANSPARENT';
};

// Returns merged busy blocks [{date, start, end}] between fromDate and toDate (inclusive), Korea time.
export function busyFromIcs(text, fromDate, toDate) {
  let root;
  try {
    root = new ICAL.Component(ICAL.parse(text));
  } catch {
    fail('캘린더 파일을 읽지 못했어요. 주소를 다시 확인해 주세요.');
  }
  for (const tz of root.getAllSubcomponents('vtimezone')) {
    try {
      const zone = new ICAL.Timezone(tz);
      if (zone.tzid && !ICAL.TimezoneService.has(zone.tzid)) ICAL.TimezoneService.register(zone);
    } catch {}
  }
  const fromMs = Date.UTC(...fromDate.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
  const toMs = Date.UTC(...addDays(toDate, 1).split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
  const windowStart = ICAL.Time.fromDateString(addDays(fromDate, -1));
  const windowEnd = ICAL.Time.fromDateString(addDays(toDate, 2));

  const events = root.getAllSubcomponents('vevent').map((c) => new ICAL.Event(c));
  const masters = new Map();
  const exceptions = [];
  for (const ev of events) {
    if (ev.isRecurrenceException()) exceptions.push(ev);
    else masters.set(ev.uid + '|' + masters.size, ev);
  }
  for (const ex of exceptions) {
    const master = [...masters.values()].find((m) => m.uid === ex.uid);
    if (master) {
      try { master.relateException(ex); } catch {}
    } else {
      masters.set(ex.uid + '|x' + masters.size, ex);
    }
  }

  const raw = [];
  const take = (startTime, endTime, comp) => {
    if (!startTime || skip(comp)) return;
    const allDay = startTime.isDate;
    const s = toKstMs(startTime);
    let e = endTime ? toKstMs(endTime) : s + (allDay ? 86400000 : 0);
    if (e <= s && allDay) e = s + 86400000;
    if (e <= fromMs || s >= toMs) return;
    addSegments(raw, Math.max(s, fromMs), Math.min(e, toMs), allDay);
  };

  for (const ev of masters.values()) {
    try {
      if (ev.isRecurring()) {
        const it = ev.iterator();
        let n = 0;
        let next;
        while ((next = it.next()) && n++ < MAX_OCCURRENCES) {
          if (next.compare(windowEnd) > 0) break;
          if (next.compare(windowStart) < 0) continue;
          const d = ev.getOccurrenceDetails(next);
          take(d.startDate, d.endDate, d.item.component);
        }
      } else {
        take(ev.startDate, ev.endDate, ev.component);
      }
    } catch {
      // One broken event should not hide the rest of the calendar.
    }
  }
  return mergeByDate(raw);
}
