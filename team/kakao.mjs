// "카카오로 내 일정 불러오기": Kakao Login (talk_calendar) and reading busy times from 톡캘린더.
// Only start/end times are kept; titles are dropped as soon as the response is read.
import { addSegments, mergeByDate, CalendarError } from './calendar.mjs';
import { addDays } from './src/board.mjs';

const KAUTH = 'https://kauth.kakao.com';
const KAPI = 'https://kapi.kakao.com';
const KST_MS = 9 * 3600 * 1000;

export function createKakao({ keys, redirectUri, fetcher = fetch }) {
  const k = () => keys() || {};
  const ready = () => !!(k().kakaoRestKey && k().kakaoClientSecret);

  async function token(params) {
    const res = await fetcher(KAUTH + '/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: new URLSearchParams({ client_id: k().kakaoRestKey, client_secret: k().kakaoClientSecret, ...params }).toString(),
      signal: AbortSignal.timeout(10000),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.access_token) throw new CalendarError('카카오 로그인을 마치지 못했어요. 다시 시도해 주세요.');
    return d;
  }

  const pack = (d, prev = {}) => ({
    kind: 'kakao',
    access: d.access_token,
    accessExp: Date.now() + (d.expires_in || 0) * 1000,
    refresh: d.refresh_token || prev.refresh,
    refreshExp: d.refresh_token ? Date.now() + (d.refresh_token_expires_in || 0) * 1000 : prev.refreshExp,
  });

  async function api(path, tok, { method = 'GET' } = {}) {
    const res = await fetcher(path.startsWith('http') ? path : KAPI + path, {
      method,
      headers: { Authorization: 'Bearer ' + tok },
      signal: AbortSignal.timeout(10000),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      const code = d.code;
      if (code === -402) throw new CalendarError('톡캘린더 동의가 필요해요. 다시 "카카오로 내 일정 불러오기"를 눌러 동의해 주세요.');
      if (code === -3 || code === -10 || res.status === 403) throw new CalendarError('톡캘린더 사용 권한이 아직 승인되지 않았어요. 승인되면 바로 쓸 수 있어요.');
      if (code === -401 || res.status === 401) throw new CalendarError('카카오 연결이 만료됐어요. 다시 연결해 주세요.');
      throw new CalendarError('톡캘린더를 읽지 못했어요. 잠시 후 다시 시도해 주세요.');
    }
    return d;
  }

  return {
    ready,
    authorizeUrl(state) {
      const q = new URLSearchParams({ response_type: 'code', client_id: k().kakaoRestKey, redirect_uri: redirectUri, state, scope: 'talk_calendar' });
      return `${KAUTH}/oauth/authorize?${q}`;
    },
    async exchange(code) {
      const d = await token({ grant_type: 'authorization_code', redirect_uri: redirectUri, code });
      if (d.scope && !String(d.scope).split(' ').includes('talk_calendar')) {
        throw new CalendarError('톡캘린더 읽기에 동의하지 않아 일정을 불러올 수 없어요.');
      }
      return pack(d);
    },
    // Returns a fresh token bundle (same object if still valid).
    async fresh(t) {
      if (t.accessExp - 60000 > Date.now()) return t;
      if (!t.refresh || (t.refreshExp && t.refreshExp < Date.now())) throw new CalendarError('카카오 연결이 만료됐어요. 다시 연결해 주세요.');
      return pack(await token({ grant_type: 'refresh_token', refresh_token: t.refresh }), t);
    },
    // Busy blocks [{date,start,end}] in Korea time from fromDate to toDate (inclusive).
    async busy(t, fromDate, toDate) {
      const raw = [];
      const fromMs = Date.parse(fromDate + 'T00:00:00Z') - KST_MS;
      const endMs = Date.parse(addDays(toDate, 1) + 'T00:00:00Z') - KST_MS;
      for (let a = fromMs; a < endMs; a += 30 * 86400000) {
        const b = Math.min(a + 30 * 86400000, endMs);
        let url = `/v2/api/calendar/events?${new URLSearchParams({ from: new Date(a).toISOString().replace('.000', ''), to: new Date(b).toISOString().replace('.000', ''), limit: '1000', time_zone: 'Asia/Seoul' })}`;
        for (let page = 0; page < 10 && url; page++) {
          const d = await api(url, t.access);
          for (const ev of d.events || []) {
            const tm = ev.time || {};
            const s = Date.parse(tm.start_at);
            const e = Date.parse(tm.end_at);
            if (Number.isNaN(s)) continue;
            if (tm.all_day) {
              // All-day: whole Korean days from the start date up to (not including) the end date.
              const sDay = Date.parse(new Date(s + KST_MS).toISOString().slice(0, 10) + 'T00:00:00Z');
              let eDay = Number.isNaN(e) ? sDay + 86400000 : Date.parse(new Date(e + KST_MS).toISOString().slice(0, 10) + 'T00:00:00Z');
              if (eDay <= sDay) eDay = sDay + 86400000;
              addSegments(raw, sDay, eDay, true);
            } else {
              addSegments(raw, s + KST_MS, (Number.isNaN(e) ? s : e) + KST_MS, false);
            }
          }
          // Only follow next-page links that stay on Kakao's API host.
          url = d.has_next && typeof d.after_url === 'string' && d.after_url.startsWith(KAPI + '/') ? d.after_url : null;
        }
      }
      const from = fromDate;
      const to = toDate;
      return mergeByDate(raw.filter((x) => x.date >= from && x.date <= to));
    },
    async unlink(t) {
      try { await api('/v1/user/unlink', t.access, { method: 'POST' }); } catch {}
    },
  };
}
