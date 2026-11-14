import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { validDate, validTime, addDays, todayKST, TYPES } from './src/board.mjs';

export const hash = (s) => createHash('sha256').update(s).digest('hex');
export const token = (bytes = 24) => randomBytes(bytes).toString('base64url');

export class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
const fail = (message, status) => {
  throw new AppError(message, status);
};

const MAX_MEMBERS = 100;
const MAX_CHANGES = 62;
const DAY_MS = 86400000;

function text(v, max, label) {
  if (typeof v !== 'string' || !v.trim()) fail(`${label}을(를) 입력해 주세요.`);
  const t = v.trim().replace(/\s+/g, ' ');
  if (t.length > max) fail(`${label}은(는) ${max}자 이내로 입력해 주세요.`);
  return t;
}

function range(input) {
  if (input.allDay) return { start: '00:00', end: '24:00' };
  if (!validTime(input.start) || !validTime(input.end, true) || input.start >= input.end) {
    fail('종료 시간은 시작 시간보다 늦어야 합니다.');
  }
  return { start: input.start, end: input.end };
}

const SCHEMA = `
PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS teams(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  invite TEXT NOT NULL UNIQUE,
  hide_names INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  active_at INTEGER NOT NULL,
  chat_hash TEXT,            -- reserved: KakaoTalk share webhook chat id (phase 3)
  source TEXT                -- reserved: where the team came from
);
CREATE TABLE IF NOT EXISTS members(
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','member')),
  key_hash TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER,        -- last time this member saved or confirmed their days
  kakao_id TEXT              -- reserved: Kakao login (phase 2)
);
CREATE INDEX IF NOT EXISTS members_team ON members(team_id);
CREATE TABLE IF NOT EXISTS marks(
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('blocked','preferred')),
  t_start TEXT NOT NULL,
  t_end TEXT NOT NULL,
  gathering_id TEXT,         -- set when the mark came from answering "어려워요"
  PRIMARY KEY(member_id, date)
);
CREATE INDEX IF NOT EXISTS marks_team_date ON marks(team_id, date);
CREATE TABLE IF NOT EXISTS gatherings(
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  proposer_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  place TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  t_start TEXT NOT NULL,
  t_end TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open','confirmed')),
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER
);
CREATE INDEX IF NOT EXISTS gatherings_team ON gatherings(team_id, date);
CREATE TABLE IF NOT EXISTS responses(
  gathering_id TEXT NOT NULL REFERENCES gatherings(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  value TEXT NOT NULL CHECK(value IN ('yes','no')),
  at INTEGER NOT NULL,
  PRIMARY KEY(gathering_id, member_id)
);
PRAGMA user_version=2;`;

export function openStore(path, { now = () => Date.now() } = {}) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  const q = (sql) => db.prepare(sql);

  const transaction = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };

  const memberRow = (row) => row && {
    id: row.id, teamId: row.team_id, name: row.name, role: row.role,
    updatedAt: row.updated_at || null, active: !!row.active,
  };
  const teamRow = (row) => row && {
    id: row.id, name: row.name, invite: row.invite, hideNames: !!row.hide_names,
  };
  const gatheringRow = (row) => row && {
    id: row.id, teamId: row.team_id, proposerId: row.proposer_id, title: row.title, type: row.type,
    place: row.place, date: row.date, start: row.t_start, end: row.t_end, status: row.status,
    createdAt: row.created_at, confirmedAt: row.confirmed_at,
  };

  const getTeam = (id) => teamRow(q('SELECT * FROM teams WHERE id=?').get(id));
  const touchTeam = (id) => q('UPDATE teams SET active_at=? WHERE id=?').run(now(), id);

  // The member behind a cookie key, only if still active.
  function byKey(key) {
    if (typeof key !== 'string' || key.length < 20 || key.length > 100) return null;
    const row = q('SELECT * FROM members WHERE key_hash=? AND active=1').get(hash(key));
    return memberRow(row) || null;
  }

  function requireMember(key, teamId) {
    const m = byKey(key);
    if (!m || (teamId && m.teamId !== teamId)) fail('이 팀에 참여한 기기에서만 볼 수 있어요. 초대 링크로 먼저 참여해 주세요.', 403);
    return m;
  }

  function requireOwner(key, teamId) {
    const m = requireMember(key, teamId);
    if (m.role !== 'owner') fail('팀을 만든 사람만 할 수 있어요.', 403);
    return m;
  }

  function addMember(teamId, name, role) {
    const count = q('SELECT COUNT(*) AS n FROM members WHERE team_id=? AND active=1').get(teamId).n;
    if (count >= MAX_MEMBERS) fail(`한 팀은 ${MAX_MEMBERS}명까지 참여할 수 있어요.`);
    const key = token(32);
    const id = token(12);
    q('INSERT INTO members(id,team_id,name,role,key_hash,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, teamId, text(name, 20, '이름'), role, hash(key), now());
    touchTeam(teamId);
    return { memberId: id, key };
  }

  function createTeam({ teamName, name }) {
    const tName = text(teamName, 30, '팀 이름');
    return transaction(() => {
      const id = token(9);
      q('INSERT INTO teams(id,name,invite,created_at,active_at) VALUES(?,?,?,?,?)')
        .run(id, tName, token(18), now(), now());
      const m = addMember(id, name, 'owner');
      return { teamId: id, ...m };
    });
  }

  function inviteInfo(invite) {
    if (typeof invite !== 'string' || invite.length > 64) fail('초대 링크를 확인해 주세요.', 404);
    const row = q('SELECT * FROM teams WHERE invite=?').get(invite);
    if (!row) fail('초대 링크가 바뀌었거나 없는 팀이에요. 팀 사람에게 새 링크를 받아 주세요.', 404);
    const n = q('SELECT COUNT(*) AS n FROM members WHERE team_id=? AND active=1').get(row.id).n;
    return { team: teamRow(row), memberCount: n };
  }

  function join(invite, name) {
    return transaction(() => {
      const { team } = inviteInfo(invite);
      const m = addMember(team.id, name, 'member');
      return { teamId: team.id, ...m };
    });
  }

  function members(teamId) {
    return q('SELECT * FROM members WHERE team_id=? AND active=1 ORDER BY created_at').all(teamId).map(memberRow);
  }

  function marksBetween(teamId, from, to) {
    return q('SELECT * FROM marks WHERE team_id=? AND date>=? AND date<=?').all(teamId, from, to)
      .map((r) => ({ member: r.member_id, date: r.date, kind: r.kind, start: r.t_start, end: r.t_end, gatheringId: r.gathering_id }));
  }

  // changes: [{date, kind: 'blocked'|'preferred'|null, allDay?, start?, end?}]
  function setDays(key, teamId, changes) {
    const me = requireMember(key, teamId);
    if (!Array.isArray(changes) || !changes.length || changes.length > MAX_CHANGES) fail('한 번에 1~62일까지 바꿀 수 있어요.');
    const floor = addDays(todayKST(now()), -1);
    return transaction(() => {
      for (const c of changes) {
        if (!c || !validDate(c.date)) fail('날짜를 확인해 주세요.');
        if (c.date < floor) fail('지난 날짜는 바꿀 수 없어요.');
        if (c.kind === null || c.kind === undefined || c.kind === 'clear') {
          q('DELETE FROM marks WHERE member_id=? AND date=?').run(me.id, c.date);
          continue;
        }
        if (!['blocked', 'preferred'].includes(c.kind)) fail('지원하지 않는 표시예요.');
        const r = range(c);
        q(`INSERT INTO marks(member_id,team_id,date,kind,t_start,t_end) VALUES(?,?,?,?,?,?)
           ON CONFLICT(member_id,date) DO UPDATE SET kind=excluded.kind,t_start=excluded.t_start,t_end=excluded.t_end,gathering_id=NULL`)
          .run(me.id, teamId, c.date, c.kind, r.start, r.end);
      }
      q('UPDATE members SET updated_at=? WHERE id=?').run(now(), me.id);
      touchTeam(teamId);
      return { ok: true };
    });
  }

  // "바뀐 것 없어요": keeps the record fresh without editing it.
  function touch(key, teamId) {
    const me = requireMember(key, teamId);
    q('UPDATE members SET updated_at=? WHERE id=?').run(now(), me.id);
    return { ok: true };
  }

  function settings(key, teamId, body) {
    requireOwner(key, teamId);
    if (body.name !== undefined) q('UPDATE teams SET name=? WHERE id=?').run(text(body.name, 30, '팀 이름'), teamId);
    if (body.hideNames !== undefined) q('UPDATE teams SET hide_names=? WHERE id=?').run(body.hideNames ? 1 : 0, teamId);
    return { ok: true };
  }

  function rename(key, teamId, name) {
    const me = requireMember(key, teamId);
    q('UPDATE members SET name=? WHERE id=?').run(text(name, 20, '이름'), me.id);
    return { ok: true };
  }

  function removeMember(key, teamId, memberId) {
    const me = requireOwner(key, teamId);
    if (memberId === me.id) fail('본인은 내보낼 수 없어요.');
    const target = memberRow(q('SELECT * FROM members WHERE id=? AND team_id=? AND active=1').get(memberId, teamId));
    if (!target) fail('팀원을 찾을 수 없어요.', 404);
    return transaction(() => {
      q('UPDATE members SET active=0, key_hash=? WHERE id=?').run('removed:' + token(16), memberId);
      q('DELETE FROM marks WHERE member_id=?').run(memberId);
      return { ok: true };
    });
  }

  function resetInvite(key, teamId) {
    requireOwner(key, teamId);
    const invite = token(18);
    q('UPDATE teams SET invite=? WHERE id=?').run(invite, teamId);
    return { invite };
  }

  function createGathering(key, teamId, body) {
    const me = requireMember(key, teamId);
    if (!validDate(body.date)) fail('날짜를 확인해 주세요.');
    if (body.date < todayKST(now())) fail('오늘 이후 날짜를 골라 주세요.');
    const r = range(body);
    const id = token(15);
    q(`INSERT INTO gatherings(id,team_id,proposer_id,title,type,place,date,t_start,t_end,status,created_at)
       VALUES(?,?,?,?,?,?,?,?,?, 'open', ?)`)
      .run(id, teamId, me.id, text(body.title, 40, '모임 이름'), TYPES.includes(body.type) ? body.type : '기타',
        typeof body.place === 'string' ? body.place.trim().slice(0, 60) : '', body.date, r.start, r.end, now());
    // The proposer is going, by definition.
    q('INSERT INTO responses VALUES(?,?,?,?)').run(id, me.id, 'yes', now());
    touchTeam(teamId);
    return { id };
  }

  function getGatheringRow(id) {
    if (typeof id !== 'string' || id.length > 40) fail('모임을 찾을 수 없어요.', 404);
    const g = gatheringRow(q('SELECT * FROM gatherings WHERE id=?').get(id));
    if (!g) fail('모임을 찾을 수 없어요. 삭제되었을 수 있어요.', 404);
    return g;
  }

  function gathering(key, id) {
    const g = getGatheringRow(id);
    const me = requireMember(key, g.teamId);
    const team = getTeam(g.teamId);
    const people = members(g.teamId);
    const resp = new Map(q('SELECT * FROM responses WHERE gathering_id=?').all(id).map((r) => [r.member_id, r.value]));
    // Board knowledge for members who have not answered yet.
    const mark = new Map(marksBetween(g.teamId, g.date, g.date).map((m) => [m.member, m]));
    const list = people.map((p) => {
      const m = mark.get(p.id);
      const hint = m && m.kind === 'blocked' && m.start < g.end && m.end > g.start ? 'no' : p.updatedAt ? 'yes' : 'unknown';
      return { id: p.id, name: p.name, response: resp.get(p.id) || null, boardHint: hint };
    });
    const counts = {
      yes: list.filter((x) => x.response === 'yes').length,
      no: list.filter((x) => x.response === 'no').length,
      waiting: list.filter((x) => !x.response).length,
    };
    const visible = team.hideNames && me.role !== 'owner' && me.id !== g.proposerId
      ? list.map((x) => (x.id === me.id || x.response === 'yes' ? x : { ...x, name: null, id: null }))
      : list;
    return {
      gathering: { ...g, proposerName: people.find((p) => p.id === g.proposerId)?.name || '팀원' },
      team: { id: team.id, name: team.name, invite: team.invite, hideNames: team.hideNames },
      me: { id: me.id, response: resp.get(me.id) || null, canManage: me.role === 'owner' || me.id === g.proposerId },
      people: visible,
      counts,
    };
  }

  function respond(key, id, value) {
    const g = getGatheringRow(id);
    const me = requireMember(key, g.teamId);
    if (!['yes', 'no'].includes(value)) fail('참석 또는 어려워요를 골라 주세요.');
    if (g.status === 'confirmed') fail('이미 확정된 모임이에요. 바뀐 점은 만든 사람에게 알려 주세요.', 409);
    return transaction(() => {
      q('INSERT INTO responses VALUES(?,?,?,?) ON CONFLICT(gathering_id,member_id) DO UPDATE SET value=excluded.value, at=excluded.at')
        .run(id, me.id, value, now());
      const existing = q('SELECT * FROM marks WHERE member_id=? AND date=?').get(me.id, g.date);
      if (value === 'no') {
        // "어려워요" also teaches the board, unless a broader block already exists.
        const coveredAlready = existing && existing.kind === 'blocked' && existing.t_start <= g.start && existing.t_end >= g.end;
        if (!coveredAlready) {
          q(`INSERT INTO marks(member_id,team_id,date,kind,t_start,t_end,gathering_id) VALUES(?,?,?,?,?,?,?)
             ON CONFLICT(member_id,date) DO UPDATE SET kind='blocked',t_start=excluded.t_start,t_end=excluded.t_end,gathering_id=excluded.gathering_id`)
            .run(me.id, g.teamId, g.date, 'blocked', g.start, g.end, g.id);
        }
      } else if (existing && existing.gathering_id === g.id) {
        q('DELETE FROM marks WHERE member_id=? AND date=?').run(me.id, g.date);
      }
      q('UPDATE members SET updated_at=? WHERE id=?').run(now(), me.id);
      return { ok: true };
    });
  }

  function manage(key, id) {
    const g = getGatheringRow(id);
    const me = requireMember(key, g.teamId);
    if (me.role !== 'owner' && me.id !== g.proposerId) fail('모임을 만든 사람이나 팀장만 할 수 있어요.', 403);
    return g;
  }

  function confirm(key, id) {
    const g = manage(key, id);
    if (g.status === 'confirmed') fail('이미 확정된 모임이에요.', 409);
    q("UPDATE gatherings SET status='confirmed', confirmed_at=? WHERE id=?").run(now(), id);
    return { ok: true };
  }

  function removeGathering(key, id) {
    const g = manage(key, id);
    return transaction(() => {
      q('DELETE FROM marks WHERE gathering_id=?').run(g.id);
      q('DELETE FROM gatherings WHERE id=?').run(g.id);
      return { ok: true };
    });
  }

  // Everything the board screen needs; summaries are computed by the caller with board.mjs.
  function boardData(key, teamId, from, to) {
    const me = requireMember(key, teamId);
    const team = getTeam(teamId);
    const gatherings = q('SELECT * FROM gatherings WHERE team_id=? AND date>=? ORDER BY date').all(teamId, addDays(todayKST(now()), -30))
      .map(gatheringRow);
    return { me, team, members: members(teamId), marks: marksBetween(teamId, from, to), gatherings };
  }

  function gatheringPreview(id) {
    const row = q('SELECT g.*, t.name AS team_name, t.invite AS invite FROM gatherings g JOIN teams t ON t.id=g.team_id WHERE g.id=?').get(id);
    return row ? { ...gatheringRow(row), teamName: row.team_name, invite: row.invite } : null;
  }

  // Retention: past marks after 90 days, teams nobody used for 180 days.
  function clean() {
    const cutoff = addDays(todayKST(now()), -90);
    q('DELETE FROM marks WHERE date<?').run(cutoff);
    q('DELETE FROM teams WHERE active_at<?').run(now() - 180 * DAY_MS);
  }

  return {
    db, transaction, byKey, requireMember, createTeam, inviteInfo, join, members, setDays, touch, settings, rename,
    removeMember, resetInvite, createGathering, gathering, respond, confirm, removeGathering, boardData,
    gatheringPreview, getTeam, clean, close: () => db.close(),
  };
}
