import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, AppError } from './store.mjs';
import { resolveSlot, summarizeDays, rankDays, validDate, addDays, todayKST, SLOTS } from './src/board.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const BASE = '/team';
const COOKIE_PREFIX = 'dn_';
const KAKAO_SDK = 'https://t1.kakaocdn.net/kakao_js_sdk/2.8.2/kakao.min.js';

export function configuration(env = process.env) {
  const origin = env.APP_ORIGIN || 'https://ddggdd.tech';
  const url = new URL(origin);
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.origin !== origin || (!local && url.protocol !== 'https:')) {
    throw Error('APP_ORIGIN must be an HTTPS origin without a path');
  }
  return {
    origin,
    secure: url.protocol === 'https:',
    port: Number(env.PORT || 8080),
    dbPath: env.DATA_PATH || '/data/team.sqlite',
    kakaoJsKey: /^[0-9a-f]{32}$/i.test(env.KAKAO_JS_KEY || '') ? env.KAKAO_JS_KEY : '',
    appName: env.APP_NAME || '되는날',
  };
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
export function dateLabel(date) {
  const d = new Date(date + 'T00:00:00Z');
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일(${WEEK[d.getUTCDay()]})`;
}
export function timeLabel(start, end) {
  if (start === '00:00' && end === '24:00') return '하루 종일';
  return `${start}~${end}`;
}

// Calendar times are Korea time (UTC+9, no daylight saving).
function utcStamp(date, time) {
  const [h, m] = time.split(':').map(Number);
  const d = new Date(Date.UTC(...date.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))), h - 9, m));
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
const allDay = (g) => g.start === '00:00' && g.end === '24:00';
const compact = (date) => date.replace(/-/g, '');

export function icsFor(g, origin) {
  const fold = (s) => s.replace(/[\\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
  const when = allDay(g)
    ? [`DTSTART;VALUE=DATE:${compact(g.date)}`, `DTEND;VALUE=DATE:${compact(addDays(g.date, 1))}`]
    : [`DTSTART:${utcStamp(g.date, g.start)}`, `DTEND:${g.end === '24:00' ? utcStamp(addDays(g.date, 1), '00:00') : utcStamp(g.date, g.end)}`];
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ddongko//doenal//KO', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', `UID:${g.id}@${new URL(origin).hostname}`, `DTSTAMP:${utcStamp(todayKST(), '09:00')}`, ...when,
    `SUMMARY:${fold(g.title)}`, ...(g.place ? [`LOCATION:${fold(g.place)}`] : []),
    `DESCRIPTION:${fold(`${g.teamName || ''} 모임`)}`, 'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

export function googleLink(g) {
  const dates = allDay(g)
    ? `${compact(g.date)}/${compact(addDays(g.date, 1))}`
    : `${utcStamp(g.date, g.start)}/${g.end === '24:00' ? utcStamp(addDays(g.date, 1), '00:00') : utcStamp(g.date, g.end)}`;
  const qs = new URLSearchParams({ action: 'TEMPLATE', text: g.title, dates, location: g.place || '', ctz: 'Asia/Seoul' });
  return 'https://calendar.google.com/calendar/render?' + qs;
}

export function createApp(config, store, { publicDir = resolve(ROOT, 'public') } = {}) {
  const budgets = new Map();
  function rate(key, max) {
    const n = Date.now();
    let r = budgets.get(key);
    if (!r || r.until < n) r = { n: 0, until: n + 60000 };
    if (++r.n > max) throw new AppError('요청이 많아요. 잠시 후 다시 시도해 주세요.', 429);
    budgets.set(key, r);
    if (budgets.size > 10000) for (const [k, v] of budgets) if (v.until < n) budgets.delete(k);
  }

  const cookie = (name, value, maxAge) =>
    `${name}=${value}; Path=${BASE}/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.secure ? '; Secure' : ''}`;
  const memberCookie = (teamId, key) => cookie(COOKIE_PREFIX + teamId, key, 400 * 86400);

  const json = (res, status, data, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(data));
  };
  const redirect = (res, url, headers = {}) => {
    res.writeHead(302, { Location: url, ...headers });
    res.end();
  };

  async function body(req) {
    if (req.headers.origin !== config.origin || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '') || req.headers['x-team-request'] !== '1') {
      throw new AppError('요청 출처를 확인하지 못했어요.', 403);
    }
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 16384) throw new AppError('입력 내용이 너무 커요.', 413);
    }
    try {
      const d = JSON.parse(raw || '{}');
      if (!d || typeof d !== 'object' || Array.isArray(d)) throw Error();
      return d;
    } catch {
      throw new AppError('입력 내용을 확인해 주세요.');
    }
  }

  const csp = [
    "default-src 'self'",
    `script-src 'self'${config.kakaoJsKey ? ' https://t1.kakaocdn.net' : ''}`,
    "style-src 'self'",
    `img-src 'self' data:${config.kakaoJsKey ? ' https://*.kakaocdn.net' : ''}`,
    `connect-src 'self'${config.kakaoJsKey ? ' https://*.kakao.com' : ''}`,
    "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
  ].join('; ');

  let template = null;
  async function page(res, meta) {
    if (!template || process.env.NODE_ENV !== 'production') template = await readFile(resolve(publicDir, 'index.html'), 'utf8');
    const title = esc(meta.title);
    const desc = esc(meta.description);
    const tags = `<title>${title}</title>
<meta property="og:type" content="website"><meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}"><meta name="description" content="${desc}">
<meta property="og:url" content="${esc(meta.url)}"><meta property="og:site_name" content="${esc(config.appName)}">
<meta name="team-config" content="${esc(JSON.stringify({ kakaoJsKey: config.kakaoJsKey, appName: config.appName }))}">
${config.kakaoJsKey ? `<script src="${KAKAO_SDK}" defer></script>` : ''}`;
    const html = template.replace(/<title>[\s\S]*?<\/title>/, tags);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  function teamsFromCookies(c) {
    const out = [];
    for (const [k, v] of Object.entries(c)) {
      if (!k.startsWith(COOKIE_PREFIX)) continue;
      const m = store.byKey(v);
      if (m && COOKIE_PREFIX + m.teamId === k) {
        const t = store.getTeam(m.teamId);
        if (t) out.push({ id: t.id, name: t.name, role: m.role, me: m.name });
      }
    }
    return out;
  }

  function boardPayload(key, teamId, params) {
    const today = todayKST();
    const from = validDate(params.get('from')) ? params.get('from') : today;
    const days = Math.min(Math.max(Number(params.get('days')) || 28, 7), 62);
    const to = addDays(from, days - 1);
    const slot = resolveSlot(params.get('slot') || 'dinner', params.get('start'), params.get('end')) || resolveSlot('dinner');
    const data = store.boardData(key, teamId, from, to);
    const dates = Array.from({ length: days }, (_, i) => addDays(from, i));
    const summary = summarizeDays(dates, data.members, data.marks, slot);
    const hidden = data.team.hideNames && data.me.role !== 'owner';
    const names = new Map(data.members.map((m) => [m.id, m.name]));
    const show = (ids) => (hidden ? null : ids.map((id) => names.get(id)));
    const day = (d) => ({
      date: d.date, total: d.total, yes: d.yes.length, prefer: d.prefer.length, no: d.no.length, part: d.part.length,
      unknown: d.unknown.length,
      names: { yes: show(d.yes.filter((id) => !d.prefer.includes(id))), prefer: show(d.prefer), no: show(d.no), part: show(d.part), unknown: data.members.filter((m) => d.unknown.includes(m.id)).map((m) => m.name) },
    });
    return {
      today, from, to, slot,
      team: { id: data.team.id, name: data.team.name, hideNames: data.team.hideNames, inviteUrl: `${config.origin}${BASE}/j/${data.team.invite}` },
      me: { id: data.me.id, name: data.me.name, role: data.me.role, updatedAt: data.me.updatedAt, personalUrl: `${config.origin}${BASE}/m/${key}` },
      members: data.members.map((m) => ({ id: m.id, name: m.name, role: m.role, updatedAt: m.updatedAt })),
      myMarks: data.marks.filter((m) => m.member === data.me.id).map(({ member, ...m }) => m),
      days: summary.map(day),
      weekends: params.get('weekends') === '1',
      best: rankDays(summary, today, { weekends: params.get('weekends') === '1' }).slice(0, 3).map(day),
      gatherings: data.gatherings.map((g) => ({ id: g.id, title: g.title, type: g.type, date: g.date, start: g.start, end: g.end, status: g.status, place: g.place })),
    };
  }

  function gatheringPayload(key, id) {
    const data = store.gathering(key, id);
    const g = { ...data.gathering, teamName: data.team.name };
    return {
      ...data,
      team: { id: data.team.id, name: data.team.name },
      shareUrl: `${config.origin}${BASE}/j/${data.team.invite}?g=${g.id}`,
      icsUrl: `${BASE}/g/${g.id}.ics`,
      googleUrl: googleLink(g),
    };
  }

  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', csp);
    try {
      const u = new URL(req.url, config.origin);
      const path = u.pathname;
      const method = req.method;
      const c = parseCookies(req);
      const keyFor = (teamId) => c[COOKIE_PREFIX + teamId];
      let m;

      if (path === '/healthz' && method === 'GET') return json(res, 200, { ok: true });
      if (path === BASE && method === 'GET') return redirect(res, BASE + '/');

      // ---------- pages ----------
      if (method === 'GET' && (m = path.match(/^\/team\/m\/([A-Za-z0-9_-]{20,100})$/))) {
        // Personal link: lets the same person continue on another phone or browser.
        rate('m:' + req.socket.remoteAddress, 30);
        const member = store.byKey(m[1]);
        if (!member) return redirect(res, BASE + '/?e=link');
        return redirect(res, `${BASE}/b/${member.teamId}`, { 'Set-Cookie': memberCookie(member.teamId, m[1]) });
      }
      if (method === 'GET' && (m = path.match(/^\/team\/g\/([A-Za-z0-9_-]{10,40})\.ics$/))) {
        const g = store.gatheringPreview(m[1]);
        if (!g) throw new AppError('모임을 찾을 수 없어요.', 404);
        res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'inline; filename="moim.ics"' });
        return res.end(icsFor(g, config.origin));
      }
      if (method === 'GET' && (m = path.match(/^\/team\/j\/([A-Za-z0-9_-]{10,64})$/))) {
        let meta = { title: `${config.appName} · 팀 초대`, description: '초대 링크가 바뀌었을 수 있어요.' };
        try {
          const info = store.inviteInfo(m[1]);
          const g = u.searchParams.get('g') && store.gatheringPreview(u.searchParams.get('g'));
          meta = g && g.teamId === info.team.id
            ? { title: `${g.title} · ${dateLabel(g.date)} ${timeLabel(g.start, g.end)}`, description: `${info.team.name} · ${g.status === 'confirmed' ? '날짜가 확정됐어요. 내 캘린더에 추가하세요.' : '이날 괜찮은지 참석 / 어려워요만 눌러 주세요.'}` }
            : { title: `${info.team.name} · 되는 날 보드`, description: '안 되는 날만 한 번 적어 두면, 모임 날짜가 바로 보여요.' };
        } catch {}
        return page(res, { ...meta, url: config.origin + path });
      }
      if (method === 'GET' && (path === BASE + '/' || /^\/team\/(b|g)\/[A-Za-z0-9_-]{6,40}$/.test(path))) {
        return page(res, { title: `${config.appName} · 우리 팀 되는 날 보드`, description: '투표 없이, 열면 다 되는 날이 보여요.', url: config.origin + path });
      }

      // ---------- API ----------
      if (path.startsWith(BASE + '/api/')) {
        const api = path.slice((BASE + '/api').length);
        if (method === 'GET') {
          rate('r:' + req.socket.remoteAddress, 300);
          if (api === '/me') return json(res, 200, { teams: teamsFromCookies(c), slots: SLOTS });
          if ((m = api.match(/^\/invite\/([A-Za-z0-9_-]{10,64})$/))) {
            const info = store.inviteInfo(m[1]);
            const gid = u.searchParams.get('g');
            const g = gid && store.gatheringPreview(gid);
            const already = store.byKey(keyFor(info.team.id));
            return json(res, 200, {
              team: { name: info.team.name, memberCount: info.memberCount },
              gathering: g && g.teamId === info.team.id ? { id: g.id, title: g.title, date: g.date, start: g.start, end: g.end, status: g.status } : null,
              memberOf: already ? info.team.id : null,
            });
          }
          if ((m = api.match(/^\/teams\/([A-Za-z0-9_-]{6,20})$/))) return json(res, 200, boardPayload(keyFor(m[1]), m[1], u.searchParams));
          if ((m = api.match(/^\/gatherings\/([A-Za-z0-9_-]{10,40})$/))) {
            const g = store.gatheringPreview(m[1]);
            if (!g) throw new AppError('모임을 찾을 수 없어요. 삭제되었을 수 있어요.', 404);
            return json(res, 200, gatheringPayload(keyFor(g.teamId), m[1]));
          }
        }
        if (method === 'POST') {
          rate('w:' + req.socket.remoteAddress, 120);
          const b = await body(req);
          if (api === '/teams') {
            rate('create:' + req.socket.remoteAddress, 10);
            const r = store.createTeam(b);
            return json(res, 200, { teamId: r.teamId }, { 'Set-Cookie': memberCookie(r.teamId, r.key) });
          }
          if ((m = api.match(/^\/invite\/([A-Za-z0-9_-]{10,64})\/join$/))) {
            rate('join:' + req.socket.remoteAddress, 20);
            const r = store.join(m[1], b.name);
            return json(res, 200, { teamId: r.teamId }, { 'Set-Cookie': memberCookie(r.teamId, r.key) });
          }
          if ((m = api.match(/^\/teams\/([A-Za-z0-9_-]{6,20})\/(days|touch|settings|rename|remove|invite|gatherings|leave)$/))) {
            const [, teamId, action] = m;
            const key = keyFor(teamId);
            if (action === 'days') return json(res, 200, store.setDays(key, teamId, b.changes));
            if (action === 'touch') return json(res, 200, store.touch(key, teamId));
            if (action === 'settings') return json(res, 200, store.settings(key, teamId, b));
            if (action === 'rename') return json(res, 200, store.rename(key, teamId, b.name));
            if (action === 'remove') return json(res, 200, store.removeMember(key, teamId, b.memberId));
            if (action === 'invite') {
              const r = store.resetInvite(key, teamId);
              return json(res, 200, { inviteUrl: `${config.origin}${BASE}/j/${r.invite}` });
            }
            if (action === 'gatherings') return json(res, 200, store.createGathering(key, teamId, b));
            if (action === 'leave') {
              store.requireMember(key, teamId);
              return json(res, 200, { ok: true }, { 'Set-Cookie': memberCookie(teamId, '').replace(/Max-Age=\d+/, 'Max-Age=0') });
            }
          }
          if ((m = api.match(/^\/gatherings\/([A-Za-z0-9_-]{10,40})\/(respond|confirm|delete)$/))) {
            const [, id, action] = m;
            const g = store.gatheringPreview(id);
            if (!g) throw new AppError('모임을 찾을 수 없어요. 삭제되었을 수 있어요.', 404);
            const key = keyFor(g.teamId);
            if (action === 'respond') return json(res, 200, store.respond(key, id, b.value));
            if (action === 'confirm') return json(res, 200, store.confirm(key, id));
            if (action === 'delete') return json(res, 200, store.removeGathering(key, id));
          }
        }
        throw new AppError('찾을 수 없어요.', 404);
      }

      // ---------- built static files only ----------
      if (method === 'GET' && path.startsWith(BASE + '/assets/')) {
        const relative = decodeURIComponent(path.slice(BASE.length + 1));
        const file = resolve(publicDir, relative);
        const types = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
        if (!file.startsWith(resolve(publicDir) + '/') || relative.includes('..') || !types[extname(file)]) throw new AppError('찾을 수 없어요.', 404);
        let bytes;
        try {
          bytes = await readFile(file);
        } catch {
          throw new AppError('찾을 수 없어요.', 404);
        }
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.writeHead(200, { 'Content-Type': types[extname(file)] });
        return res.end(bytes);
      }
      throw new AppError('찾을 수 없어요.', 404);
    } catch (e) {
      if (res.headersSent) return res.end();
      const known = e instanceof AppError;
      if (!known) console.error(e);
      json(res, known ? e.status : 500, { error: known ? e.message : '처리하지 못했어요. 다시 시도해 주세요.' });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const c = configuration();
  const s = openStore(c.dbPath);
  const app = createApp(c, s);
  app.listen(c.port, '0.0.0.0', () => console.log(`Team server listening on ${c.port}`));
  s.clean();
  const cleanup = setInterval(() => s.clean(), 3600000);
  cleanup.unref();
  const close = () => {
    clearInterval(cleanup);
    app.close(() => {
      s.close();
      process.exit(0);
    });
  };
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
}
