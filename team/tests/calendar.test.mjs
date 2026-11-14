import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { busyFromIcs, normalizeUrl, isPublicAddress, fetchIcs, cipherFromKey, providerOf } from '../calendar.mjs';
import { openStore } from '../store.mjs';
import { createApp, configuration, createCalendarSync } from '../server.mjs';
import { addDays, todayKST } from '../src/board.mjs';

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:test
BEGIN:VTIMEZONE
TZID:Asia/Seoul
BEGIN:STANDARD
TZOFFSETFROM:+0900
TZOFFSETTO:+0900
TZNAME:KST
DTSTART:19700101T000000
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:a
SUMMARY:비밀 회의
LOCATION:본사
DTSTART:20261201T100000Z
DTEND:20261201T120000Z
END:VEVENT
BEGIN:VEVENT
UID:w
SUMMARY:주간회의
DTSTART;TZID=Asia/Seoul:20261102T190000
DTEND;TZID=Asia/Seoul:20261102T200000
RRULE:FREQ=WEEKLY;BYDAY=MO
EXDATE;TZID=Asia/Seoul:20261207T190000
END:VEVENT
BEGIN:VEVENT
UID:w
RECURRENCE-ID;TZID=Asia/Seoul:20261214T190000
DTSTART;TZID=Asia/Seoul:20261215T180000
DTEND;TZID=Asia/Seoul:20261215T210000
END:VEVENT
BEGIN:VEVENT
UID:d
DTSTART;VALUE=DATE:20261203
DTEND;VALUE=DATE:20261205
END:VEVENT
BEGIN:VEVENT
UID:t
DTSTART:20261202T100000Z
DTEND:20261202T110000Z
TRANSP:TRANSPARENT
END:VEVENT
BEGIN:VEVENT
UID:c
DTSTART:20261216T100000Z
DTEND:20261216T110000Z
STATUS:CANCELLED
END:VEVENT
BEGIN:VEVENT
UID:late
DTSTART;TZID=Asia/Seoul:20261209T230000
DTEND;TZID=Asia/Seoul:20261210T010000
END:VEVENT
END:VCALENDAR`;

test('busy times: UTC to Korea time, weekly repeats, skipped and moved occurrences, all-day, overnight, free and cancelled', () => {
  const busy = busyFromIcs(ICS, '2026-11-30', '2026-12-20');
  assert.deepEqual(busy, [
    { date: '2026-11-30', start: '19:00', end: '20:00' },
    { date: '2026-12-01', start: '19:00', end: '21:00' },
    { date: '2026-12-03', start: '00:00', end: '24:00' },
    { date: '2026-12-04', start: '00:00', end: '24:00' },
    { date: '2026-12-09', start: '23:00', end: '24:00' },
    { date: '2026-12-10', start: '00:00', end: '01:00' },
    { date: '2026-12-15', start: '18:00', end: '21:00' },
  ]);
  assert.equal(JSON.stringify(busy).includes('비밀'), false);
  assert.equal(JSON.stringify(busy).includes('본사'), false);
});

test('only public web addresses are accepted', () => {
  assert.equal(normalizeUrl('webcal://p01-caldav.icloud.com/published/2/abc'), 'https://p01-caldav.icloud.com/published/2/abc');
  for (const bad of ['http://127.0.0.1/x.ics', 'https://[::1]/a', 'https://localhost/a', 'https://intranet/a', 'file:///etc/passwd', 'https://user:pw@calendar.google.com/a', 'https://calendar.google.com:8443/a', 'ftp://x.com/a']) {
    assert.throws(() => normalizeUrl(bad), Error, bad);
  }
  assert.equal(isPublicAddress('10.0.0.1'), false);
  assert.equal(isPublicAddress('169.254.169.254'), false);
  assert.equal(isPublicAddress('172.17.0.1'), false);
  assert.equal(isPublicAddress('::ffff:192.168.0.1'), false);
  assert.equal(isPublicAddress('fd00::1'), false);
  assert.equal(isPublicAddress('142.250.207.110'), true);
  assert.equal(providerOf('https://calendar.google.com/calendar/ical/x/private-y/basic.ics'), '구글');
  assert.equal(providerOf('https://p01-caldav.icloud.com/published/2/x'), '아이폰(iCloud)');
  assert.equal(providerOf('https://outlook.office365.com/owa/calendar/x/calendar.ics'), '아웃룩');
});

const body = (text) => new Response(text).body;
const publicLookup = async () => [{ address: '142.250.207.110', family: 4 }];

test('download refuses hosts that resolve inside the network, and redirects into it', async () => {
  const privateLookup = async () => [{ address: '10.1.2.3', family: 4 }];
  await assert.rejects(fetchIcs('https://evil.example.com/a.ics', { lookup: privateLookup, fetcher: async () => assert.fail('must not fetch') }), /공개 인터넷/);
  const lookup = async (h) => (h === 'good.example.com' ? publicLookup() : privateLookup());
  const fetcher = async () => ({ status: 302, headers: new Headers({ location: 'https://inside.example.com/x.ics' }), ok: false });
  await assert.rejects(fetchIcs('https://good.example.com/a.ics', { lookup, fetcher }), /공개 인터넷/);
  const page = async () => ({ status: 200, ok: true, headers: new Headers(), body: body('<html>login</html>') });
  await assert.rejects(fetchIcs('https://good.example.com/a.ics', { lookup: publicLookup, fetcher: page }), /캘린더 파일이 아니에요/);
  const ok = async () => ({ status: 200, ok: true, headers: new Headers(), body: body(ICS) });
  const r = await fetchIcs('webcal://good.example.com/a.ics', { lookup: publicLookup, fetcher: ok });
  assert.match(r.text, /BEGIN:VCALENDAR/);
});

test('the secret address is encrypted at rest', () => {
  const c = cipherFromKey(randomBytes(32).toString('base64'));
  const blob = c.encrypt('https://calendar.google.com/calendar/ical/me/private-abc/basic.ics');
  assert.equal(blob.includes('private-abc'), false);
  assert.equal(c.decrypt(blob), 'https://calendar.google.com/calendar/ical/me/private-abc/basic.ics');
  assert.equal(cipherFromKey('short'), null);
});

test('calendar busy counts as "안 됨" until the person overrides it; it also makes them known', () => {
  const s = openStore(':memory:');
  try {
    const t = todayKST();
    const D = addDays(t, 3);
    const a = s.createTeam({ teamName: '팀', name: '나' });
    const me = s.byKey(a.key);
    let data = s.boardData(a.key, a.teamId, t, D);
    assert.equal(data.members[0].updatedAt, null);
    s.saveCalendar(me.id, a.teamId, { urlEnc: 'x', provider: '구글', busy: [{ date: D, start: '19:00', end: '20:00' }] });
    data = s.boardData(a.key, a.teamId, t, D);
    assert.ok(data.members[0].updatedAt);
    assert.equal(data.busy.length, 1);
    s.setDays(a.key, a.teamId, [{ date: D, kind: 'free', allDay: true }]);
    assert.equal(s.boardData(a.key, a.teamId, D, D).marks[0].kind, 'free');
    s.calendarFailed(me.id, '오류');
    assert.equal(s.boardData(a.key, a.teamId, t, D).busy.length, 0);
    s.removeCalendar(me.id);
    assert.equal(s.calendarOf(me.id), null);
  } finally {
    s.close();
  }
});

test('a version-2 database is upgraded without losing marks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mig-'));
  try {
    const path = join(dir, 'db.sqlite');
    const s = openStore(path);
    const a = s.createTeam({ teamName: '팀', name: '나' });
    const D = addDays(todayKST(), 2);
    s.setDays(a.key, a.teamId, [{ date: D, kind: 'blocked', allDay: true }]);
    s.close();
    // Recreate the old CHECK (no 'free') and mark the file as version 2.
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA foreign_keys=OFF; BEGIN;
      CREATE TABLE m2(member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE, team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        date TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('blocked','preferred')), t_start TEXT NOT NULL, t_end TEXT NOT NULL, gathering_id TEXT, PRIMARY KEY(member_id, date));
      INSERT INTO m2 SELECT * FROM marks; DROP TABLE marks; ALTER TABLE m2 RENAME TO marks; COMMIT; PRAGMA user_version=2;`);
    db.close();
    const s2 = openStore(path);
    assert.equal(s2.boardData(a.key, a.teamId, D, D).marks.length, 1);
    s2.setDays(a.key, a.teamId, [{ date: addDays(D, 1), kind: 'free', allDay: true }]);
    assert.equal(s2.db.prepare('PRAGMA user_version').get().user_version, 3);
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP: connect reads busy times, board shows them only to me and marks the slot as 안 됨', async () => {
  const s = openStore(':memory:');
  const t = todayKST();
  const D = addDays(t, 5);
  const ymd = D.replace(/-/g, '');
  const ics = `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:x\nSUMMARY:치과\nDTSTART:${ymd}T100000Z\nDTEND:${ymd}T110000Z\nEND:VEVENT\nEND:VCALENDAR`;
  const c = configuration({ APP_ORIGIN: 'http://127.0.0.1:41234', CAL_KEY: randomBytes(32).toString('base64') });
  const calendarSync = createCalendarSync(c, s, { lookup: publicLookup, fetcher: async () => ({ status: 200, ok: true, headers: new Headers(), body: body(ics) }) });
  const app = createApp(c, s, { calendarSync });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.address().port;
  const post = (path, data, cookie) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Team-Request': '1', Origin: c.origin, Cookie: cookie }, body: JSON.stringify(data) });
  try {
    const a = s.createTeam({ teamName: '팀', name: '나' });
    const b = s.join(s.getTeam(a.teamId).invite, '동료');
    const mine = `dn_${a.teamId}=${a.key}`;
    const bad = await post(`/team/api/teams/${a.teamId}/calendar/connect`, { url: 'http://10.0.0.5/cal.ics' }, mine);
    assert.equal(bad.status, 400);
    const ok = await post(`/team/api/teams/${a.teamId}/calendar/connect`, { url: 'https://calendar.google.com/calendar/ical/me/private-x/basic.ics' }, mine);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).provider, '구글');
    const stored = s.db.prepare('SELECT url_enc, busy FROM calendars').get();
    assert.equal(stored.url_enc.includes('private-x'), false);
    assert.equal(stored.busy.includes('치과'), false);
    const board = await (await fetch(`${base}/team/api/teams/${a.teamId}?from=${t}&days=7&slot=dinner`, { headers: { Cookie: mine } })).json();
    assert.equal(board.calendar.linked.provider, '구글');
    assert.deepEqual(board.myBusy, [{ date: D, start: '19:00', end: '20:00' }]);
    assert.equal(board.days.find((d) => d.date === D).no, 1);
    const other = await (await fetch(`${base}/team/api/teams/${a.teamId}?from=${t}&days=7`, { headers: { Cookie: `dn_${a.teamId}=${b.key}` } })).json();
    assert.deepEqual(other.myBusy, []);
    assert.equal(JSON.stringify(other).includes('19:00'), false);
    const off = await post(`/team/api/teams/${a.teamId}/calendar/disconnect`, {}, mine);
    assert.equal(off.status, 200);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM calendars').get().n, 0);
  } finally {
    app.closeAllConnections();
    await new Promise((r) => app.close(r));
    s.close();
  }
});
