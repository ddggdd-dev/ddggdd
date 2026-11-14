import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../store.mjs';
import { createApp, configuration, icsFor, googleLink } from '../server.mjs';
import { resolveSlot, summarizeDays, rankDays, memberStatus, validDate, addDays, todayKST } from '../src/board.mjs';

const TODAY = todayKST();
const D1 = addDays(TODAY, 3);
const D2 = addDays(TODAY, 4);
const D3 = addDays(TODAY, 5);

function setup() {
  const s = openStore(':memory:');
  const a = s.createTeam({ teamName: '개발팀', name: '성식' });
  const team = s.getTeam(a.teamId);
  const b = s.join(team.invite, '민지');
  const c = s.join(team.invite, '준호');
  return { s, a, b, c, team, teamId: a.teamId };
}

// ---------- pure board logic ----------
test('members who never saved are unknown, not available', () => {
  const slot = resolveSlot('dinner');
  assert.equal(memberStatus({ updatedAt: null }, null, slot), 'unknown');
  assert.equal(memberStatus({ updatedAt: 1 }, null, slot), 'yes');
});

test('blocked overlaps the slot; lunch-only block does not block dinner', () => {
  const dinner = resolveSlot('dinner');
  const lunchBlock = { kind: 'blocked', start: '11:00', end: '14:00' };
  const eveningBlock = { kind: 'blocked', start: '19:00', end: '20:00' };
  assert.equal(memberStatus({ updatedAt: 1 }, lunchBlock, dinner), 'yes');
  assert.equal(memberStatus({ updatedAt: 1 }, eveningBlock, dinner), 'no');
});

test('with time undecided, a partial block is only a hint', () => {
  const day = resolveSlot('day');
  assert.equal(memberStatus({ updatedAt: 1 }, { kind: 'blocked', start: '10:00', end: '12:00' }, day), 'part');
  assert.equal(memberStatus({ updatedAt: 1 }, { kind: 'blocked', start: '00:00', end: '24:00' }, day), 'no');
});

test('preferred counts only when it covers the whole slot; ranking order', () => {
  const slot = resolveSlot('dinner');
  assert.equal(memberStatus({ updatedAt: 1 }, { kind: 'preferred', start: '18:00', end: '19:00' }, slot), 'yes');
  assert.equal(memberStatus({ updatedAt: 1 }, { kind: 'preferred', start: '00:00', end: '24:00' }, slot), 'prefer');
  const members = [{ id: 'a', updatedAt: 1 }, { id: 'b', updatedAt: 1 }, { id: 'c', updatedAt: null }];
  const marks = [
    { member: 'a', date: D1, kind: 'blocked', start: '00:00', end: '24:00' },
    { member: 'b', date: D3, kind: 'preferred', start: '00:00', end: '24:00' },
  ];
  const days = summarizeDays([D1, D2, D3], members, marks, slot);
  const ranked = rankDays(days, TODAY, { weekends: true }).map((d) => d.date);
  assert.deepEqual(ranked, [D3, D2, D1]);
  assert.equal(days[0].unknown.length, 1);
  assert.equal(validDate('2026-02-30'), false);
  // Weekends and today are left out of recommendations unless asked.
  const week = Array.from({ length: 7 }, (_, i) => addDays(TODAY, i));
  const all = summarizeDays(week, members, [], slot);
  const picked = rankDays(all, TODAY).map((d) => new Date(d.date + 'T00:00:00Z').getUTCDay());
  assert.ok(picked.every((w) => w !== 0 && w !== 6));
  assert.ok(!rankDays(all, TODAY, { weekends: true }).some((d) => d.date === TODAY));
  assert.equal(resolveSlot('custom', '20:00', '19:00'), null);
});

// ---------- store ----------
test('team creation, invite join and per-team isolation', () => {
  const { s, a, b, teamId } = setup();
  try {
    assert.equal(s.byKey(a.key).role, 'owner');
    assert.equal(s.byKey(b.key).role, 'member');
    const other = s.createTeam({ teamName: '풋살', name: '다른 사람' });
    assert.throws(() => s.boardData(other.key, teamId, TODAY, D3), /참여한 기기/);
    assert.throws(() => s.boardData('x'.repeat(40), teamId, TODAY, D3), /참여한 기기/);
    assert.throws(() => s.join('wrong-invite-token', '누구'), /초대 링크/);
    assert.throws(() => s.createTeam({ teamName: ' ', name: 'a' }), /팀 이름/);
  } finally {
    s.close();
  }
});

test('marking days updates freshness; past dates rejected; clear removes', () => {
  const { s, b, teamId } = setup();
  try {
    assert.equal(s.byKey(b.key).updatedAt, null);
    s.setDays(b.key, teamId, [{ date: D1, kind: 'blocked', allDay: true }, { date: D2, kind: 'blocked', start: '18:00', end: '22:00' }]);
    assert.ok(s.byKey(b.key).updatedAt);
    let marks = s.boardData(b.key, teamId, TODAY, D3).marks;
    assert.equal(marks.length, 2);
    s.setDays(b.key, teamId, [{ date: D1, kind: null }]);
    marks = s.boardData(b.key, teamId, TODAY, D3).marks;
    assert.equal(marks.length, 1);
    assert.throws(() => s.setDays(b.key, teamId, [{ date: addDays(TODAY, -5), kind: 'blocked', allDay: true }]), /지난 날짜/);
    assert.throws(() => s.setDays(b.key, teamId, [{ date: D1, kind: 'blocked', start: '22:00', end: '21:00' }]), /종료 시간/);
    assert.throws(() => s.setDays(b.key, teamId, []), /1~62/);
  } finally {
    s.close();
  }
});

test('owner-only actions; removed member loses access; new invite retires old one', () => {
  const { s, a, b, c, teamId, team } = setup();
  try {
    assert.throws(() => s.settings(b.key, teamId, { hideNames: true }), /만든 사람/);
    assert.throws(() => s.removeMember(b.key, teamId, s.byKey(c.key).id), /만든 사람/);
    assert.throws(() => s.removeMember(a.key, teamId, s.byKey(a.key).id), /본인/);
    s.removeMember(a.key, teamId, s.byKey(c.key).id);
    assert.equal(s.byKey(c.key), null);
    assert.throws(() => s.setDays(c.key, teamId, [{ date: D1, kind: 'blocked', allDay: true }]), /참여한 기기/);
    const { invite } = s.resetInvite(a.key, teamId);
    assert.notEqual(invite, team.invite);
    assert.throws(() => s.join(team.invite, '늦은 사람'), /초대 링크/);
    assert.ok(s.join(invite, '새 사람').key);
  } finally {
    s.close();
  }
});

test('gathering: "어려워요" teaches the board, "참석" undoes it, confirm locks answers', () => {
  const { s, a, b, teamId } = setup();
  try {
    const { id } = s.createGathering(a.key, teamId, { date: D2, title: '송년회', type: '송년회', start: '18:30', end: '21:30' });
    let g = s.gathering(b.key, id);
    assert.equal(g.counts.yes, 1); // proposer counts as going
    s.respond(b.key, id, 'no');
    let mark = s.boardData(b.key, teamId, D2, D2).marks.find((m) => m.date === D2);
    assert.equal(mark.kind, 'blocked');
    assert.equal(mark.gatheringId, id);
    s.respond(b.key, id, 'yes');
    assert.equal(s.boardData(b.key, teamId, D2, D2).marks.length, 0);
    assert.throws(() => s.confirm(b.key, id), /만든 사람/);
    s.confirm(a.key, id);
    assert.throws(() => s.respond(b.key, id, 'no'), /확정/);
    g = s.gathering(a.key, id);
    assert.equal(g.gathering.status, 'confirmed');
    assert.throws(() => s.createGathering(a.key, teamId, { date: addDays(TODAY, -1), title: 'x', allDay: true }), /오늘 이후/);
  } finally {
    s.close();
  }
});

test('an existing all-day block is kept when answering "어려워요"; deleting a gathering removes only its marks', () => {
  const { s, a, b, c, teamId } = setup();
  try {
    s.setDays(b.key, teamId, [{ date: D2, kind: 'blocked', allDay: true }]);
    const { id } = s.createGathering(a.key, teamId, { date: D2, title: '회식', type: '회식', start: '18:00', end: '21:00' });
    s.respond(b.key, id, 'no');
    s.respond(c.key, id, 'no');
    s.removeGathering(a.key, id);
    const marks = s.boardData(a.key, teamId, D2, D2).marks;
    assert.equal(marks.length, 1);
    assert.equal(marks[0].member, s.byKey(b.key).id);
    assert.equal(marks[0].end, '24:00');
  } finally {
    s.close();
  }
});

test('hide names: members see counts for "어려워요" but the owner sees names', () => {
  const { s, a, b, c, teamId } = setup();
  try {
    s.settings(a.key, teamId, { hideNames: true });
    const { id } = s.createGathering(b.key, teamId, { date: D1, title: '점심', type: '점심', start: '12:00', end: '13:00' });
    s.respond(c.key, id, 'no');
    // Another plain member (not proposer, not owner) cannot see who declined.
    const d = s.join(s.getTeam(teamId).invite, '다른 팀원');
    const seen = s.gathering(d.key, id).people.find((p) => p.response === 'no');
    assert.equal(seen.name, null);
    assert.equal(s.gathering(a.key, id).people.find((p) => p.response === 'no').name, '준호');
  } finally {
    s.close();
  }
});

test('data survives a restart; retention removes old marks and idle teams', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-'));
  try {
    const path = join(dir, 'db.sqlite');
    let s = openStore(path);
    const a = s.createTeam({ teamName: '팀', name: '나' });
    s.setDays(a.key, a.teamId, [{ date: D1, kind: 'blocked', allDay: true }]);
    s.close();
    s = openStore(path);
    assert.equal(s.boardData(a.key, a.teamId, TODAY, D3).marks.length, 1);
    s.close();
    const later = Date.now() + 200 * 86400000;
    s = openStore(path, { now: () => later });
    s.clean();
    assert.equal(s.getTeam(a.teamId), undefined);
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- calendar output ----------
test('calendar file and Google link use Korea time', () => {
  const g = { id: 'abc123def456', title: '송년회, 1차', place: '강남; 2층', date: '2026-12-11', start: '19:00', end: '22:00', teamName: '개발팀' };
  const ics = icsFor(g, 'https://ddggdd.tech');
  assert.match(ics, /DTSTART:20261211T100000Z/);
  assert.match(ics, /DTEND:20261211T130000Z/);
  assert.match(ics, /SUMMARY:송년회\\, 1차/);
  assert.match(ics, /LOCATION:강남\\; 2층/);
  const allDay = icsFor({ ...g, start: '00:00', end: '24:00' }, 'https://ddggdd.tech');
  assert.match(allDay, /DTSTART;VALUE=DATE:20261211/);
  assert.match(allDay, /DTEND;VALUE=DATE:20261212/);
  assert.match(googleLink(g), /dates=20261211T100000Z%2F20261211T130000Z/);
});

// ---------- HTTP ----------
async function httpSetup(env = {}) {
  const s = openStore(':memory:');
  const c = configuration({ APP_ORIGIN: 'http://127.0.0.1:41234', ...env });
  const app = createApp(c, s);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.address().port;
  const post = (path, data, cookie = '', origin = c.origin) => fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Team-Request': '1', Origin: origin, Cookie: cookie },
    body: JSON.stringify(data),
    redirect: 'manual',
  });
  return { s, c, base, post, close: async () => { app.closeAllConnections(); await new Promise((r) => app.close(r)); s.close(); } };
}
const cookieOf = (res) => res.headers.get('set-cookie').split(';')[0];

test('HTTP: create, join, board, cross-origin refusal, source files hidden', async () => {
  const t = await httpSetup();
  try {
    const bad = await t.post('/team/api/teams', { teamName: '팀', name: '나' }, '', 'https://evil.test');
    assert.equal(bad.status, 403);
    const created = await t.post('/team/api/teams', { teamName: '개발팀', name: '성식' });
    assert.equal(created.status, 200);
    assert.match(created.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
    const owner = cookieOf(created);
    const { teamId } = await created.json();
    const anon = await fetch(`${t.base}/team/api/teams/${teamId}`);
    assert.equal(anon.status, 403);
    const board = await (await fetch(`${t.base}/team/api/teams/${teamId}?slot=dinner&days=14`, { headers: { Cookie: owner } })).json();
    assert.equal(board.days.length, 14);
    assert.equal(board.me.role, 'owner');
    const invite = board.team.inviteUrl.split('/j/')[1];
    const joined = await t.post(`/team/api/invite/${invite}/join`, { name: '민지' });
    assert.equal(joined.status, 200);
    const member = cookieOf(joined);
    const setRes = await t.post(`/team/api/teams/${teamId}/days`, { changes: [{ date: D1, kind: 'blocked', allDay: true }] }, member);
    assert.equal(setRes.status, 200);
    const after = await (await fetch(`${t.base}/team/api/teams/${teamId}?from=${TODAY}&days=7`, { headers: { Cookie: owner } })).json();
    const d1 = after.days.find((d) => d.date === D1);
    assert.equal(d1.no, 1);
    assert.deepEqual(d1.names.no, ['민지']);
    const me = await (await fetch(`${t.base}/team/api/me`, { headers: { Cookie: owner + '; ' + member } })).json();
    assert.equal(me.teams.length, 1); // two cookies for the same team name collapse: one per cookie name
    assert.equal((await fetch(t.base + '/team/server.mjs')).status, 404);
    assert.equal((await fetch(t.base + '/team/assets/../server.mjs')).status, 404);
    const html = await fetch(t.base + '/team/');
    assert.match(html.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.doesNotMatch(html.headers.get('content-security-policy'), /kakaocdn/);
  } finally {
    await t.close();
  }
});

test('HTTP: personal link moves the member to another browser; invite page shows escaped preview', async () => {
  const t = await httpSetup({ KAKAO_JS_KEY: '0123456789abcdef0123456789abcdef' });
  try {
    const r = t.s.createTeam({ teamName: '<b>팀</b>', name: '성식' });
    const team = t.s.getTeam(r.teamId);
    const { id } = t.s.createGathering(r.key, r.teamId, { date: D1, title: '송년회 "1차"', type: '송년회', start: '19:00', end: '22:00' });
    const moved = await fetch(`${t.base}/team/m/${r.key}`, { redirect: 'manual' });
    assert.equal(moved.status, 302);
    assert.equal(moved.headers.get('location'), `/team/b/${r.teamId}`);
    assert.match(moved.headers.get('set-cookie'), new RegExp(`dn_${r.teamId}=`));
    const page = await fetch(`${t.base}/team/j/${team.invite}?g=${id}`);
    const html = await page.text();
    assert.match(html, /<meta property="og:title" content="송년회 &quot;1차&quot;/);
    assert.match(html, /&lt;b&gt;팀&lt;\/b&gt;/);
    assert.doesNotMatch(html, /<b>팀<\/b>/);
    assert.match(page.headers.get('content-security-policy'), /t1\.kakaocdn\.net/);
    const ics = await fetch(`${t.base}/team/g/${id}.ics`);
    assert.match(ics.headers.get('content-type'), /text\/calendar/);
    assert.match(await ics.text(), /BEGIN:VEVENT/);
    const bogus = await fetch(`${t.base}/team/m/${'a'.repeat(43)}`, { redirect: 'manual' });
    assert.equal(bogus.headers.get('location'), '/team/?e=link');
  } finally {
    await t.close();
  }
});
