import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createKakao } from '../kakao.mjs';
import { openStore } from '../store.mjs';
import { createApp, configuration, createCalendarSync } from '../server.mjs';
import { addDays, todayKST } from '../src/board.mjs';

const KEYS = { kakaoRestKey: 'a'.repeat(32), kakaoClientSecret: 'S'.repeat(30) };
const res = (status, d) => ({ ok: status < 400, status, json: async () => d });

// A stand-in for kauth/kapi.kakao.com that records what was asked.
function fakeKakao({ events = [], scope = 'talk_calendar', eventStatus = 200, eventBody } = {}) {
  const calls = [];
  const fetcher = async (url, opt = {}) => {
    calls.push({ url: String(url), opt });
    const u = new URL(url);
    if (u.pathname === '/oauth/token') {
      const p = new URLSearchParams(opt.body);
      if (p.get('client_secret') !== KEYS.kakaoClientSecret) return res(401, { error: 'invalid_client' });
      if (p.get('grant_type') === 'authorization_code' && p.get('code') !== 'good') return res(400, { error: 'invalid_grant' });
      return res(200, { access_token: 'acc-' + calls.length, refresh_token: 'ref', expires_in: 21599, refresh_token_expires_in: 5000000, scope });
    }
    if (u.pathname === '/v2/api/calendar/events') {
      if (eventStatus !== 200) return res(eventStatus, eventBody);
      if (u.searchParams.get('page') === '2') return res(200, { events: events.slice(1), has_next: false });
      return res(200, { events: events.slice(0, 1), has_next: events.length > 1, after_url: 'https://kapi.kakao.com/v2/api/calendar/events?page=2' });
    }
    if (u.pathname === '/v1/user/unlink') return res(200, { id: 1 });
    return res(404, {});
  };
  return { calls, fetcher };
}

test('톡캘린더 events become Korea-time busy blocks; titles are dropped; next pages followed only on kapi', async () => {
  const D = '2026-12-03';
  const events = [
    { title: '비밀 면접', time: { start_at: '2026-12-03T10:00:00Z', end_at: '2026-12-03T11:30:00Z', all_day: false } }, // 19:00–20:30 KST
    { title: '휴가', time: { start_at: '2026-12-04T00:00:00Z', end_at: '2026-12-06T00:00:00Z', all_day: true } },
  ];
  const k = fakeKakao({ events });
  const kakao = createKakao({ keys: () => KEYS, redirectUri: 'https://x.test/team/auth/kakao/callback', fetcher: k.fetcher });
  const t = await kakao.exchange('good');
  const busy = await kakao.busy(t, D, addDays(D, 5));
  assert.deepEqual(busy, [
    { date: '2026-12-03', start: '19:00', end: '20:30' },
    { date: '2026-12-04', start: '00:00', end: '24:00' },
    { date: '2026-12-05', start: '00:00', end: '24:00' },
  ]);
  assert.equal(JSON.stringify(busy).includes('면접'), false);
  const ev = k.calls.find((c) => c.url.includes('/calendar/events'));
  assert.equal(ev.opt.headers.Authorization, 'Bearer ' + t.access);

  // A next-page link to some other host is ignored.
  const evil = fakeKakao({ events });
  const orig = evil.fetcher;
  const k2 = createKakao({ keys: () => KEYS, redirectUri: 'r', fetcher: async (url, o) => {
    const r = await orig(url, o);
    if (String(url).includes('/calendar/events')) { const d = await r.json(); return res(200, { ...d, after_url: 'https://evil.test/x' }); }
    return r;
  } });
  await k2.busy(t, D, D);
  assert.equal(evil.calls.some((c) => c.url.includes('evil')), false);
});

test('Kakao refuses: no calendar consent, permission not approved yet, expired refresh', async () => {
  const noScope = createKakao({ keys: () => KEYS, redirectUri: 'r', fetcher: fakeKakao({ scope: 'profile_nickname' }).fetcher });
  await assert.rejects(noScope.exchange('good'), /동의하지 않아/);
  const notApproved = createKakao({ keys: () => KEYS, redirectUri: 'r', fetcher: fakeKakao({ eventStatus: 403, eventBody: { code: -3 } }).fetcher });
  await assert.rejects(notApproved.busy({ access: 'x' }, '2026-12-01', '2026-12-02'), /승인되지 않았어요/);
  const k = createKakao({ keys: () => KEYS, redirectUri: 'r', fetcher: fakeKakao().fetcher });
  await assert.rejects(k.fresh({ access: 'a', accessExp: 0, refresh: 'r', refreshExp: 1 }), /만료/);
  const renewed = await k.fresh({ access: 'old', accessExp: 0, refresh: 'r', refreshExp: Date.now() + 1e9 });
  assert.notEqual(renewed.access, 'old');
  assert.equal(renewed.refresh, 'ref');
  assert.equal(createKakao({ keys: () => ({}), redirectUri: 'r' }).ready(), false);
});

test('HTTP: one tap → Kakao → back to the board with busy times; state is single-use and tied to the member', async () => {
  const s = openStore(':memory:');
  const D = addDays(todayKST(), 4);
  const k = fakeKakao({ events: [{ title: '병원', time: { start_at: `${D}T09:30:00Z`, end_at: `${D}T11:00:00Z`, all_day: false } }] });
  const c = configuration({ APP_ORIGIN: 'http://127.0.0.1:41235', CAL_KEY: randomBytes(32).toString('base64') });
  const kakao = createKakao({ keys: () => KEYS, redirectUri: c.origin + '/team/auth/kakao/callback', fetcher: k.fetcher });
  const calendarSync = createCalendarSync(c, s, { kakao });
  const app = createApp(c, s, { calendarSync, settings: null });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.address().port;
  const get = (p, cookie) => fetch(base + p, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
  try {
    const a = s.createTeam({ teamName: '팀', name: '나' });
    const b = s.join(s.getTeam(a.teamId).invite, '동료');
    const mine = `dn_${a.teamId}=${a.key}`;
    const board0 = await (await get(`/team/api/teams/${a.teamId}`, mine)).json();
    assert.equal(board0.calendar.kakao, true);

    assert.match((await get(`/team/auth/kakao/start?team=${a.teamId}`)).headers.get('location'), /e=link/);
    const start = await get(`/team/auth/kakao/start?team=${a.teamId}`, mine);
    const loc = new URL(start.headers.get('location'));
    assert.equal(loc.origin, 'https://kauth.kakao.com');
    assert.equal(loc.searchParams.get('scope'), 'talk_calendar');
    assert.equal(loc.searchParams.get('redirect_uri'), c.origin + '/team/auth/kakao/callback');
    const state = loc.searchParams.get('state');

    // Someone else's browser can't finish my link.
    const other = await get(`/team/auth/kakao/callback?code=good&state=${state}`, `dn_${a.teamId}=${b.key}`);
    assert.match(other.headers.get('location'), /cal=fail/);
    // The state was used up by that attempt.
    assert.match((await get(`/team/auth/kakao/callback?code=good&state=${state}`, mine)).headers.get('location'), /e=kakao/);

    const st2 = new URL((await get(`/team/auth/kakao/start?team=${a.teamId}`, mine)).headers.get('location')).searchParams.get('state');
    const back = await get(`/team/auth/kakao/callback?code=good&state=${st2}`, mine);
    assert.equal(back.headers.get('location'), `/team/b/${a.teamId}?cal=kakao&n=1`);

    const row = s.db.prepare('SELECT url_enc, busy, provider FROM calendars').get();
    assert.equal(row.provider, '톡캘린더');
    assert.equal(row.url_enc.includes('acc-'), false);
    assert.equal(row.busy.includes('병원'), false);
    const board = await (await get(`/team/api/teams/${a.teamId}?from=${D}&days=1&slot=dinner`, mine)).json();
    assert.deepEqual(board.myBusy, [{ date: D, start: '18:30', end: '20:00' }]);

    // Background refresh reuses the stored tokens.
    await calendarSync.refreshOne(s.calendarOf(a.memberId ?? s.byKey(a.key).id));
    // Denied consent comes back as a friendly toast code.
    const st3 = new URL((await get(`/team/auth/kakao/start?team=${a.teamId}`, mine)).headers.get('location')).searchParams.get('state');
    assert.match((await get(`/team/auth/kakao/callback?error=access_denied&state=${st3}`, mine)).headers.get('location'), /cal=denied/);

    // Disconnect unlinks at Kakao and forgets everything.
    const dis = await fetch(`${base}/team/api/teams/${a.teamId}/calendar/disconnect`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Team-Request': '1', Origin: c.origin, Cookie: mine }, body: '{}' });
    assert.equal(dis.status, 200);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM calendars').get().n, 0);
    assert.ok(k.calls.some((x) => x.url.endsWith('/v1/user/unlink')));
  } finally {
    app.close();
  }
});
