import { useCallback, useEffect, useMemo, useState } from 'react';
import { addDays, TYPES } from './board.mjs';

type Any = any;
const BASE = '/team';
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
const SLOT_KEYS = ['dinner', 'lunch', 'allday', 'day'] as const;
const SLOT_LABEL: Record<string, string> = { dinner: '저녁', lunch: '점심', allday: '하루 종일', day: '시간 미정' };

const config: Any = (() => {
  try {
    return JSON.parse(document.querySelector('meta[name="team-config"]')?.getAttribute('content') || '{}');
  } catch {
    return {};
  }
})();

// ---------- helpers ----------
async function api(path: string, data?: Any) {
  const r = await fetch(BASE + '/api' + path, data === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Team-Request': '1' },
    body: JSON.stringify(data),
  });
  let d: Any = {};
  try { d = await r.json(); } catch {}
  if (!r.ok) {
    const e: Any = new Error(d.error || '처리하지 못했어요. 다시 시도해 주세요.');
    e.status = r.status;
    throw e;
  }
  return d;
}

function go(path: string) {
  history.pushState(null, '', path);
  window.dispatchEvent(new Event('popstate'));
}

function dateLabel(date: string, withYear = false) {
  const d = new Date(date + 'T00:00:00Z');
  return `${withYear ? d.getUTCFullYear() + '년 ' : ''}${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일(${WEEK[d.getUTCDay()]})`;
}
const timeLabel = (s: string, e: string) => (s === '00:00' && e === '24:00' ? '하루 종일' : `${s}~${e}`);
const weekday = (date: string) => new Date(date + 'T00:00:00Z').getUTCDay();

function ago(ms: number | null) {
  if (!ms) return '아직 안 적음';
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days <= 0) return '오늘';
  if (days === 1) return '어제';
  return `${days}일 전`;
}

let kakaoReady = false;
async function share(opts: { title: string; text: string; url: string; button?: string }, toast: (s: string) => void) {
  const W: Any = window;
  if (config.kakaoJsKey && W.Kakao) {
    try {
      if (!kakaoReady && !W.Kakao.isInitialized()) W.Kakao.init(config.kakaoJsKey);
      kakaoReady = true;
      W.Kakao.Share.sendDefault({
        objectType: 'text',
        text: `${opts.title}\n${opts.text}`.slice(0, 200),
        link: { mobileWebUrl: opts.url, webUrl: opts.url },
        buttonTitle: opts.button || '열기',
      });
      return;
    } catch {}
  }
  const message = `${opts.title}\n${opts.text}\n${opts.url}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: opts.title, text: `${opts.title}\n${opts.text}`, url: opts.url });
      return;
    } catch (e: Any) {
      if (e?.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(message);
    toast('복사했어요. 단톡방에 붙여 넣어 주세요.');
  } catch {
    window.prompt('아래 내용을 복사해 단톡방에 붙여 넣어 주세요.', message);
  }
}

async function copy(text: string, toast: (s: string) => void, done = '복사했어요.') {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    window.prompt('길게 눌러 복사해 주세요.', text);
  }
}

function useRoute() {
  const [path, setPath] = useState(location.pathname + location.search);
  useEffect(() => {
    const on = () => setPath(location.pathname + location.search);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return path;
}

function useToast() {
  const [msg, setMsg] = useState('');
  const show = useCallback((s: string) => {
    setMsg(s);
    window.setTimeout(() => setMsg(''), 2600);
  }, []);
  return [msg, show] as const;
}

// ---------- app ----------
export default function App() {
  const route = useRoute();
  const [toastMsg, toast] = useToast();
  const url = new URL(route, location.origin);
  const p = url.pathname;
  let screen;
  let m;
  if ((m = p.match(/^\/team\/j\/([A-Za-z0-9_-]+)$/))) screen = <Join invite={m[1]} gid={url.searchParams.get('g')} toast={toast} />;
  else if ((m = p.match(/^\/team\/b\/([A-Za-z0-9_-]+)$/))) screen = <Board teamId={m[1]} toast={toast} />;
  else if ((m = p.match(/^\/team\/g\/([A-Za-z0-9_-]+)$/))) screen = <Gathering gid={m[1]} toast={toast} />;
  else screen = <Home toast={toast} error={url.searchParams.get('e')} />;
  return (
    <div className="shell">
      {screen}
      {toastMsg && <div className="toast" role="status">{toastMsg}</div>}
    </div>
  );
}

function Brand({ small }: { small?: boolean }) {
  return (
    <a className={'brand' + (small ? ' small' : '')} href={BASE + '/'} onClick={(e) => { e.preventDefault(); go(BASE + '/'); }}>
      <span className="logo">되</span>
      <span>{config.appName || '되는날'}</span>
    </a>
  );
}

function ErrorBox({ error, retry }: { error: string; retry?: () => void }) {
  if (!error) return null;
  return <div className="alert" role="alert">{error}{retry && <button className="link" onClick={retry}>다시 시도</button>}</div>;
}

// ---------- home: my teams + create ----------
function Home({ toast, error }: { toast: (s: string) => void; error: string | null }) {
  const [teams, setTeams] = useState<Any[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(error === 'link' ? '개인 링크가 만료됐거나 팀에서 빠졌어요.' : '');
  useEffect(() => { api('/me').then((d) => setTeams(d.teams)).catch((e) => setErr(e.message)); }, []);
  async function create(e: Any) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    try {
      const d = await api('/teams', { teamName: f.teamName, name: f.name });
      toast('팀을 만들었어요. 이제 초대 링크를 단톡방에 올려 주세요.');
      go(`${BASE}/b/${d.teamId}?welcome=1`);
    } catch (e: Any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="page">
      <Brand />
      <h1 className="hero-title">투표 없이,<br />열면 <em>다 되는 날</em>이 보여요.</h1>
      <p className="lead">팀원이 안 되는 날만 한 번 적어 두면, 모임이 필요할 때 보드를 열어 날짜를 고르기만 하면 돼요.</p>
      <ol className="steps">
        <li><b>팀 만들기</b> 초대 링크를 단톡방에 올려요.</li>
        <li><b>안 되는 날 적기</b> 각자 한 번, 바뀔 때만 고쳐요.</li>
        <li><b>이날로 하자</b> 단톡방에서 참석 확인 한 번이면 끝.</li>
      </ol>
      <ErrorBox error={err} />
      {teams && teams.length > 0 && (
        <section className="card">
          <h2>내 팀</h2>
          {teams.map((t) => (
            <button key={t.id} className="row-btn" onClick={() => go(`${BASE}/b/${t.id}`)}>
              <span><b>{t.name}</b><small>{t.me} · {t.role === 'owner' ? '만든 사람' : '팀원'}</small></span><span>→</span>
            </button>
          ))}
        </section>
      )}
      <form className="card" onSubmit={create}>
        <h2>새 팀 만들기</h2>
        <label>팀 이름<input name="teamName" required maxLength={30} placeholder="예: 개발팀, 토요 풋살" /></label>
        <label>내 이름<input name="name" required maxLength={20} placeholder="팀에서 부르는 이름" /></label>
        <button className="primary full" disabled={busy}>{busy ? '만드는 중…' : '팀 만들기'}</button>
        <p className="hint">가입이나 로그인은 없어요. 이 기기에 팀 정보가 저장되고, 다른 폰에서는 개인 링크로 이어 쓸 수 있어요.</p>
      </form>
      {teams === null && !err && <p className="muted center">불러오는 중…</p>}
    </main>
  );
}

// ---------- join ----------
function Join({ invite, gid, toast }: { invite: string; gid: string | null; toast: (s: string) => void }) {
  const [info, setInfo] = useState<Any>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api(`/invite/${invite}${gid ? '?g=' + encodeURIComponent(gid) : ''}`)
      .then((d) => {
        if (d.memberOf) go(d.gathering ? `${BASE}/g/${d.gathering.id}` : `${BASE}/b/${d.memberOf}`);
        else setInfo(d);
      })
      .catch((e) => setErr(e.message));
  }, [invite, gid]);
  async function join(e: Any) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    try {
      const d = await api(`/invite/${invite}/join`, { name: f.name });
      toast('참여했어요.');
      go(info?.gathering ? `${BASE}/g/${info.gathering.id}` : `${BASE}/b/${d.teamId}?welcome=1`);
    } catch (e: Any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="page">
      <Brand />
      <ErrorBox error={err} />
      {!info && !err && <p className="muted center">불러오는 중…</p>}
      {info && (
        <form className="card" onSubmit={join}>
          <span className="eyebrow">팀 초대</span>
          <h1>{info.team.name}</h1>
          <p className="muted">{info.team.memberCount}명이 함께하고 있어요.</p>
          {info.gathering && (
            <div className="callout">
              <b>{info.gathering.title}</b>
              <span>{dateLabel(info.gathering.date)} · {timeLabel(info.gathering.start, info.gathering.end)}</span>
              <small>이름만 넣으면 바로 참석 여부를 답할 수 있어요.</small>
            </div>
          )}
          <label>내 이름<input name="name" required maxLength={20} autoFocus placeholder="팀에서 부르는 이름" /></label>
          <button className="primary full" disabled={busy}>{busy ? '참여하는 중…' : '참여하기'}</button>
          <p className="hint">가입이나 로그인은 없어요. 불가 사유는 묻지 않아요.</p>
        </form>
      )}
    </main>
  );
}

// ---------- board ----------
function weekStart(date: string) {
  return addDays(date, -weekday(date));
}

function Board({ teamId, toast }: { teamId: string; toast: (s: string) => void }) {
  const [slot, setSlot] = useState<string>(() => localStorageGet('slot:' + teamId) || 'dinner');
  const [weekends, setWeekends] = useState<boolean>(() => localStorageGet('weekends:' + teamId) === '1');
  const [from, setFrom] = useState<string | null>(null);
  const [data, setData] = useState<Any>(null);
  const [err, setErr] = useState('');
  const [needJoin, setNeedJoin] = useState(false);
  const [edit, setEdit] = useState(false);
  const [sheet, setSheet] = useState<string | null>(null);
  const [panel, setPanel] = useState<'' | 'members' | 'propose' | 'calendar'>('');
  const [proposeDate, setProposeDate] = useState('');
  const welcome = new URLSearchParams(location.search).get('welcome') === '1';

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ slot, days: '35', weekends: weekends ? '1' : '0' });
      if (from) qs.set('from', from);
      const d = await api(`/teams/${teamId}?${qs}`);
      if (!from) {
        setFrom(weekStart(d.today));
        return;
      }
      setData(d);
      setErr('');
    } catch (e: Any) {
      if (e.status === 403) setNeedJoin(true);
      setErr(e.message);
    }
  }, [teamId, slot, from, weekends]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const id = window.setInterval(() => { if (document.visibilityState === 'visible') load(); }, 30000);
    return () => window.clearInterval(id);
  }, [load]);
  useEffect(() => { localStorageSet('slot:' + teamId, slot); }, [teamId, slot]);
  useEffect(() => { localStorageSet('weekends:' + teamId, weekends ? '1' : '0'); }, [teamId, weekends]);

  const myMark = useMemo(() => new Map((data?.myMarks || []).map((m: Any) => [m.date, m])), [data]);
  const myBusy = useMemo(() => {
    const map = new Map<string, Any[]>();
    for (const b of data?.myBusy || []) map.set(b.date, [...(map.get(b.date) || []), b]);
    return map;
  }, [data]);

  async function setDay(date: string, change: Any) {
    try {
      await api(`/teams/${teamId}/days`, { changes: [{ date, ...change }] });
      await load();
    } catch (e: Any) {
      toast(e.message);
    }
  }

  function tapDay(date: string) {
    if (!data || date < data.today) return;
    if (edit) {
      const cur: Any = myMark.get(date);
      setDay(date, cur && cur.kind === 'blocked' ? { kind: null } : { kind: 'blocked', allDay: true });
    } else {
      setSheet(date);
    }
  }

  if (needJoin) {
    return (
      <main className="page">
        <Brand />
        <div className="card">
          <h1>이 기기에서는 아직 팀에 참여하지 않았어요.</h1>
          <p className="muted">단톡방의 초대 링크를 눌러 참여하거나, 다른 기기에서 받은 개인 링크를 열어 주세요.</p>
          <button className="secondary full" onClick={() => go(BASE + '/')}>처음 화면으로</button>
        </div>
      </main>
    );
  }
  if (!data) return <main className="page"><Brand /><ErrorBox error={err} retry={load} />{!err && <p className="muted center">보드를 불러오는 중…</p>}</main>;

  const { team, me, days, best, today } = data;
  const isOwner = me.role === 'owner';
  const upcoming = data.gatherings.filter((g: Any) => g.date >= today);
  const stale = me.updatedAt && Date.now() - me.updatedAt > 14 * 86400000;

  return (
    <main className="page board">
      <header className="topbar">
        <Brand small />
        <button className="chip" onClick={() => setPanel('members')}>팀원 {data.members.length}명</button>
      </header>
      <h1 className="team-name">{team.name}</h1>

      {welcome && isOwner && data.members.length === 1 && (
        <div className="callout strong">
          <b>먼저 단톡방에 초대 링크를 올려 주세요.</b>
          <span>팀원이 이름만 넣으면 바로 참여해요.</span>
          <button className="primary" onClick={() => share({ title: `${team.name} 되는 날 보드`, text: '안 되는 날만 한 번 적어 주세요. 모임 날짜를 바로 정할 수 있어요.', url: team.inviteUrl, button: '참여하기' }, toast)}>초대 링크 공유</button>
        </div>
      )}

      <section className={'mine' + (!me.updatedAt ? ' warn' : stale ? ' stale' : '')}>
        <div>
          <b>{me.name}님 기록</b>
          <small>마지막 수정 · {ago(me.updatedAt)}</small>
        </div>
        {!me.updatedAt
          ? <button className="primary" onClick={() => setEdit(true)}>안 되는 날 적기</button>
          : <div className="mine-actions">
              <button className="secondary" onClick={() => setEdit(!edit)}>{edit ? '다 했어요' : '수정'}</button>
              {!edit && <button className="ghost" onClick={async () => { await api(`/teams/${teamId}/touch`, {}); toast('확인했어요. 기록이 최신으로 표시돼요.'); load(); }}>바뀐 것 없어요</button>}
            </div>}
      </section>
      {data.calendar.available && (
        <button className={'cal-line' + (data.calendar.linked?.status === 'error' ? ' bad' : '')} onClick={() => setPanel('calendar')}>
          <span className="grow">
            {data.calendar.linked
              ? data.calendar.linked.status === 'ok'
                ? <><b>{data.calendar.linked.provider} 캘린더 연결됨</b><small>{ago(data.calendar.linked.fetchedAt)} 확인 · 일정 있는 시간은 자동으로 안 됨</small></>
                : <><b>캘린더를 못 읽고 있어요</b><small>눌러서 확인해 주세요</small></>
              : <><b>내 캘린더 연결하기</b><small>구글 · 아이폰 · 아웃룩 · 톡캘린더 일정으로 자동 표시</small></>}
          </span>
          <span>›</span>
        </button>
      )}

      {edit && (
        <div className="edit-banner">
          <b>안 되는 날을 눌러 주세요.</b> 하루 종일 안 됨으로 표시돼요. 저녁만 안 되는 날은 편집을 마친 뒤 날짜를 눌러 바꿀 수 있어요.
          {!me.updatedAt && <button className="link" onClick={async () => { await api(`/teams/${teamId}/touch`, {}); setEdit(false); toast('저장했어요. 이 기간에 안 되는 날이 없다고 표시돼요.'); load(); }}>안 되는 날이 없어요</button>}
        </div>
      )}

      <div className="slots" role="tablist" aria-label="시간대">
        {SLOT_KEYS.map((k) => (
          <button key={k} role="tab" aria-selected={slot === k} className={slot === k ? 'on' : ''} onClick={() => setSlot(k)}>{SLOT_LABEL[k]}</button>
        ))}
      </div>

      {!edit && (
        <section className="best">
          <div className="best-head">
            <h2>{SLOT_LABEL[slot]} 추천 날짜 <small>{weekends ? '주말 포함' : '평일만'}</small></h2>
            <label className="check small"><input type="checkbox" checked={weekends} onChange={(e) => setWeekends(e.target.checked)} /> 주말 포함</label>
          </div>
          {best.length === 0 && <p className="muted">이 기간에는 추천할 날이 없어요. 다음 4주를 보거나 주말을 포함해 보세요.</p>}
          <div className="best-row">
            {best.map((d: Any, i: number) => (
              <button key={d.date} className={'best-card' + (i === 0 ? ' top' : '')} onClick={() => setSheet(d.date)}>
                <span>{dateLabel(d.date)}</span>
                <b>{d.yes}/{d.total}명</b>
                <small>{d.no ? `안 됨 ${d.no}` : d.unknown ? `미입력 ${d.unknown}` : '다 돼요'}</small>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="calendar">
        <div className="cal-head">
          <button aria-label="이전 4주" onClick={() => setFrom(addDays(from!, -28))} disabled={from! <= weekStart(today)}>‹</button>
          <b>{dateLabel(data.from)} ~ {dateLabel(data.to)}</b>
          <button aria-label="다음 4주" onClick={() => setFrom(addDays(from!, 28))}>›</button>
        </div>
        <div className="week">{WEEK.map((w, i) => <span key={w} className={i === 0 ? 'sun' : i === 6 ? 'sat' : ''}>{w}</span>)}</div>
        <div className="grid">
          {days.map((d: Any) => {
            const past = d.date < today;
            const ratio = d.total ? d.yes / d.total : 0;
            const level = past ? 0 : Math.min(4, Math.round(ratio * 4));
            const all = !past && d.no === 0 && d.unknown === 0 && d.total > 0;
            const mine: Any = myMark.get(d.date);
            return (
              <button key={d.date} className={`day l${level}${all ? ' all' : ''}${past ? ' past' : ''}${d.date === today ? ' today' : ''}${edit && mine?.kind === 'blocked' ? ' my-no' : ''}`} onClick={() => tapDay(d.date)} disabled={past} aria-label={`${dateLabel(d.date)} 되는 사람 ${d.yes}명, 안 되는 사람 ${d.no}명`}>
                <span className={'num' + (weekday(d.date) === 0 ? ' sun' : weekday(d.date) === 6 ? ' sat' : '')}>{Number(d.date.slice(8))}</span>
                {!past && <small>{d.yes}/{d.total}</small>}
                {mine && (mine.kind === 'blocked' ? <i className="dot-no" aria-hidden="true" /> : mine.kind === 'preferred' ? <i className="heart" aria-hidden="true">♥</i> : null)}
                {!past && myBusy.has(d.date) && <i className="cal-bar" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
        <div className="legend"><span><i className="sw l4" />다 되는 쪽</span><span><i className="sw l1" />적게 됨</span><span><i className="dot-no" />내가 안 됨</span><span><i className="heart">♥</i>내가 좋아요</span>{data.calendar.linked && <span><i className="cal-bar inline" />내 캘린더 일정</span>}</div>
      </section>

      {upcoming.length > 0 && (
        <section className="card">
          <h2>잡힌 모임</h2>
          {upcoming.map((g: Any) => (
            <button key={g.id} className="row-btn" onClick={() => go(`${BASE}/g/${g.id}`)}>
              <span><b>{g.title}</b><small>{dateLabel(g.date)} · {timeLabel(g.start, g.end)}</small></span>
              <span className={'tag' + (g.status === 'confirmed' ? ' green' : '')}>{g.status === 'confirmed' ? '확정' : '확인 중'}</span>
            </button>
          ))}
        </section>
      )}

      <section className="actions-row">
        <button className="secondary" onClick={() => share({ title: `${team.name} · 안 되는 날 업데이트`, text: '이번 달 안 되는 날, 바뀐 게 있으면 한 번만 고쳐 주세요.', url: team.inviteUrl, button: '보드 열기' }, toast)}>안 되는 날 적어 달라고 공유</button>
      </section>

      {sheet && (
        <DaySheet
          day={days.find((d: Any) => d.date === sheet) || best.find((d: Any) => d.date === sheet)}
          slot={data.slot}
          slotKey={slot}
          mine={myMark.get(sheet)}
          busy={myBusy.get(sheet) || []}
          hideNames={team.hideNames && !isOwner}
          onClose={() => setSheet(null)}
          onSet={async (change: Any) => { await setDay(sheet, change); }}
          onPropose={() => { setProposeDate(sheet); setSheet(null); setPanel('propose'); }}
        />
      )}
      {panel === 'propose' && (
        <ProposeSheet teamId={teamId} date={proposeDate} slot={data.slot} slotKey={slot} onClose={() => setPanel('')} toast={toast} />
      )}
      {panel === 'calendar' && (
        <CalendarSheet teamId={teamId} calendar={data.calendar} onClose={() => setPanel('')} reload={load} toast={toast} />
      )}
      {panel === 'members' && (
        <MembersSheet data={data} teamId={teamId} onClose={() => setPanel('')} reload={load} toast={toast} />
      )}
    </main>
  );
}

function localStorageGet(k: string) {
  try { return window.localStorage.getItem(k); } catch { return null; }
}
function localStorageSet(k: string, v: string) {
  try { window.localStorage.setItem(k, v); } catch {}
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: Any }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);
  return (
    <div className="overlay" onClick={onClose}>
      <section className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head"><h2>{title}</h2><button className="close" aria-label="닫기" onClick={onClose}>×</button></div>
        {children}
      </section>
    </div>
  );
}

function Names({ label, names, count, tone }: { label: string; names: string[] | null; count: number; tone: string }) {
  if (!count) return null;
  return (
    <div className={'names ' + tone}>
      <b>{label} {count}</b>
      <span>{names ? names.join(', ') : '이름은 팀 설정으로 숨겨져 있어요'}</span>
    </div>
  );
}

function DaySheet({ day, slot, slotKey, mine, busy: calBusy, hideNames, onClose, onSet, onPropose }: Any) {
  const [busy, setBusy] = useState(false);
  if (!day) return null;
  const partial = slotKey === 'dinner' || slotKey === 'lunch';
  const act = async (change: Any) => {
    setBusy(true);
    await onSet(change);
    setBusy(false);
  };
  const state = !mine ? 'none' : mine.kind === 'preferred' ? 'like' : mine.kind === 'free' ? 'free' : mine.start === '00:00' && mine.end === '24:00' ? 'all' : 'part';
  const hasBusy = calBusy.length > 0;
  return (
    <Sheet title={dateLabel(day.date)} onClose={onClose}>
      <p className="muted">{SLOT_LABEL[slotKey] || '선택한 시간'} {slotKey !== 'day' && slotKey !== 'allday' ? `(${slot.start}~${slot.end}) ` : ''}기준</p>
      <div className="big-count"><b>{day.yes}</b>/{day.total}명 가능</div>
      <Names label="좋아요" names={day.names.prefer} count={day.prefer} tone="like" />
      <Names label="가능" names={day.names.yes} count={day.yes - day.prefer} tone="yes" />
      <Names label="안 됨" names={day.names.no} count={day.no} tone="no" />
      <Names label="낮에 일부 안 됨" names={day.names.part} count={day.part} tone="part" />
      <Names label="아직 안 적음" names={day.names.unknown} count={day.unknown} tone="unknown" />
      <h3>나는 이날</h3>
      {hasBusy && (
        <div className="my-cal">
          <b>내 캘린더 일정</b>
          <span>{calBusy.map((b: Any) => timeLabel(b.start, b.end)).join(', ')}</span>
          <small>{state === 'none' ? '이 시간과 겹치는 모임은 자동으로 안 됨이에요. 일정 내용은 저장하지 않고 나한테만 보여요.' : '직접 고른 표시가 캘린더보다 우선이에요.'}</small>
        </div>
      )}
      <div className="choice">
        <button disabled={busy} className={state === 'all' ? 'on no' : ''} onClick={() => act({ kind: 'blocked', allDay: true })}>하루 종일 안 돼요</button>
        {partial && <button disabled={busy} className={state === 'part' ? 'on no' : ''} onClick={() => act({ kind: 'blocked', start: slot.start, end: slot.end })}>{SLOT_LABEL[slotKey]}만 안 돼요</button>}
        <button disabled={busy} className={state === 'like' ? 'on like' : ''} onClick={() => act({ kind: 'preferred', allDay: true })}>이날 좋아요 ♥</button>
        {hasBusy
          ? <>
              <button disabled={busy} className={state === 'free' ? 'on' : ''} onClick={() => act({ kind: 'free', allDay: true })}>일정 있어도 괜찮아요</button>
              <button disabled={busy} className={state === 'none' ? 'on' : ''} onClick={() => act({ kind: null })}>캘린더대로</button>
            </>
          : <button disabled={busy} className={state === 'none' ? 'on' : ''} onClick={() => act({ kind: null })}>괜찮아요</button>}
      </div>
      <button className="primary full" onClick={onPropose}>이날로 하자 →</button>
      <p className="hint">단톡방에 참석 확인 카드가 올라가요. 투표가 아니라 확인 한 번이에요.</p>
    </Sheet>
  );
}

function ProposeSheet({ teamId, date, slot, slotKey, onClose, toast }: Any) {
  const [type, setType] = useState('회식');
  const [allDay, setAllDay] = useState(slotKey === 'allday' || slotKey === 'day');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const defaults: Record<string, string> = { 회식: '팀 회식', 송년회: '송년회', 워크숍: '워크숍', 점심: '팀 점심', 기타: '팀 모임' };
  const [title, setTitle] = useState(defaults['회식']);
  async function submit(e: Any) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    try {
      const d = await api(`/teams/${teamId}/gatherings`, { date, type, title, place: f.place, allDay, start: f.start, end: f.end });
      toast('모임을 만들었어요. 단톡방에 공유해 주세요.');
      go(`${BASE}/g/${d.id}?new=1`);
    } catch (e: Any) {
      setErr(e.message);
      setBusy(false);
    }
  }
  const s = slotKey === 'day' || slotKey === 'allday' ? '18:00' : slot.start;
  const en = slotKey === 'day' || slotKey === 'allday' ? '21:00' : slot.end === '24:00' ? '23:30' : slot.end;
  return (
    <Sheet title={`${dateLabel(date)}로 하자`} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="types">
          {TYPES.map((t: string) => (
            <button type="button" key={t} className={type === t ? 'on' : ''} onClick={() => { setType(t); if (Object.values(defaults).includes(title)) setTitle(defaults[t]); if (t === '워크숍') setAllDay(true); }}>{t}</button>
          ))}
        </div>
        <label>모임 이름<input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={40} /></label>
        <label className="check"><input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /> 하루 종일</label>
        {!allDay && (
          <div className="two">
            <label>시작<input type="time" name="start" defaultValue={s} required /></label>
            <label>끝<input type="time" name="end" defaultValue={en} required /></label>
          </div>
        )}
        <label>장소 (선택)<input name="place" maxLength={60} placeholder="미정이어도 괜찮아요" /></label>
        <ErrorBox error={err} />
        <button className="primary full" disabled={busy}>{busy ? '만드는 중…' : '모임 만들고 공유하기'}</button>
      </form>
    </Sheet>
  );
}

function MembersSheet({ data, teamId, onClose, reload, toast }: Any) {
  const { team, me, members } = data;
  const isOwner = me.role === 'owner';
  const [inviteUrl, setInviteUrl] = useState(team.inviteUrl);
  async function post(path: string, body: Any, done: string) {
    try {
      const d = await api(`/teams/${teamId}/${path}`, body);
      toast(done);
      reload();
      return d;
    } catch (e: Any) {
      toast(e.message);
    }
  }
  return (
    <Sheet title="팀원" onClose={onClose}>
      <div className="member-list">
        {members.map((m: Any) => (
          <div key={m.id} className="member">
            <span className="avatar">{m.name[0]}</span>
            <span className="grow"><b>{m.name}{m.id === me.id ? ' (나)' : ''}</b><small>{m.role === 'owner' ? '만든 사람 · ' : ''}{m.updatedAt ? `기록 ${ago(m.updatedAt)}` : '아직 안 적음'}</small></span>
            {isOwner && m.id !== me.id && <button className="link danger" onClick={() => { if (confirm(`${m.name}님을 팀에서 내보낼까요? 기록도 지워져요.`)) post('remove', { memberId: m.id }, '내보냈어요.'); }}>내보내기</button>}
          </div>
        ))}
      </div>
      <h3>초대</h3>
      <div className="stack">
        <button className="primary" onClick={() => share({ title: `${team.name} 되는 날 보드`, text: '안 되는 날만 한 번 적어 주세요. 모임 날짜를 바로 정할 수 있어요.', url: inviteUrl, button: '참여하기' }, toast)}>초대 링크 공유</button>
        <button className="secondary" onClick={() => copy(inviteUrl, toast, '초대 링크를 복사했어요.')}>초대 링크 복사</button>
        {isOwner && <button className="link" onClick={async () => { if (confirm('지금 링크는 더 이상 쓸 수 없게 돼요. 새 링크를 만들까요?')) { const d = await post('invite', {}, '새 초대 링크를 만들었어요.'); if (d) setInviteUrl(d.inviteUrl); } }}>초대 링크 새로 만들기</button>}
      </div>
      {isOwner && (
        <>
          <h3>배려 설정</h3>
          <label className="check"><input type="checkbox" checked={team.hideNames} onChange={(e) => post('settings', { hideNames: e.target.checked }, e.target.checked ? '이제 안 되는 사람 이름은 숫자로만 보여요.' : '이름이 다시 보여요.')} /> 안 되는 사람 이름 숨기기 (숫자로만 표시)</label>
          <p className="hint">켜면 팀원에게는 "안 됨 2"처럼 숫자만 보여요. 만든 사람에게는 이름이 보여요.</p>
        </>
      )}
      <h3>내 설정</h3>
      <div className="stack">
        <button className="secondary" onClick={() => copy(me.personalUrl, toast, '개인 링크를 복사했어요. 나만 쓰세요.')}>다른 폰에서 이어 쓰기 (개인 링크 복사)</button>
        <button className="link" onClick={() => { const n = prompt('팀에서 쓸 이름', me.name); if (n) post('rename', { name: n }, '이름을 바꿨어요.'); }}>내 이름 바꾸기</button>
      </div>
      <p className="hint">개인 링크는 나만 쓰는 열쇠예요. 다른 사람에게 보내면 그 사람이 내 기록을 고칠 수 있어요.</p>
    </Sheet>
  );
}


const CAL_GUIDES: { key: string; label: string; steps: string[]; note?: string }[] = [
  { key: 'google', label: '구글', steps: [
    'PC에서 calendar.google.com 을 열어요. (휴대폰 앱에는 이 메뉴가 없어요)',
    '왼쪽 "내 캘린더"에서 내 이름 캘린더 옆 ⋮ → "설정 및 공유"를 눌러요.',
    '아래쪽 "캘린더 통합"의 "iCal 형식의 비공개 주소"를 복사해요.',
    '여기에 붙여 넣고 "연결"을 눌러요.',
  ], note: '회사 구글 계정은 관리자가 이 주소를 막아 둔 경우가 있어요. 삼성 캘린더를 구글 계정과 함께 쓰고 있다면 이 방법으로 연결하면 돼요.' },
  { key: 'icloud', label: '아이폰', steps: [
    '아이폰 "캘린더" 앱 → 아래 "캘린더"를 눌러요.',
    '연결할 캘린더 옆 ⓘ 를 눌러 "공개 캘린더"를 켜요.',
    '"링크 공유…" → "복사"를 눌러요.',
    '여기에 붙여 넣고 "연결"을 눌러요.',
  ], note: '아이폰은 "공개 캘린더" 링크라서, 링크를 아는 사람은 일정을 볼 수 있어요. 링크를 다른 곳에 올리지 마세요.' },
  { key: 'outlook', label: '아웃룩', steps: [
    'PC에서 outlook.com 또는 회사 Outlook 웹을 열어요.',
    '설정 → 일정 → "공유 일정" → "일정 게시"에서 캘린더를 고르고, 권한은 바쁜 시간만 보이는 가장 적은 단계로 골라 게시해요.',
    '나오는 "ICS" 링크를 복사해 여기에 붙여 넣어요.',
  ] },
  { key: 'kakao', label: '톡캘린더', steps: [
    'PC에서 톡캘린더 웹(calendar.kakao.com)에 로그인해요.',
    '연결할 캘린더의 설정에서 iCal 주소를 찾아 복사해요.',
    '여기에 붙여 넣고 "연결"을 눌러요.',
  ] },
  { key: 'other', label: '네이버 · 기타', steps: [
    '쓰는 캘린더의 설정에서 "iCal", "ICS", "구독 주소", "캘린더 내보내기 주소"를 찾아 복사해요.',
    'https:// 또는 webcal:// 로 시작하는 주소면 대부분 연결돼요.',
  ], note: '네이버 캘린더는 내보내기 주소가 없을 수 있어요. 이때는 일정을 구글이나 아이폰 캘린더에도 함께 두고 그 주소를 넣어 주세요.' },
];

function CalendarSheet({ teamId, calendar, onClose, reload, toast }: Any) {
  const [tab, setTab] = useState('google');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const linked = calendar.linked;
  const guide = CAL_GUIDES.find((g) => g.key === tab)!;
  async function run(path: string, body: Any, done: string) {
    setBusy(true);
    setErr('');
    try {
      const d = await api(`/teams/${teamId}/calendar/${path}`, body);
      toast(path === 'connect' ? `${d.provider} 캘린더를 연결했어요. 앞으로 10주 일정 ${d.count}건을 읽었어요.` : done);
      setUrl('');
      await reload();
      if (path !== 'refresh') onClose();
    } catch (e: Any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet title="내 캘린더 연결" onClose={onClose}>
      {linked && (
        <div className={'callout' + (linked.status === 'error' ? ' warn-box' : '')}>
          <b>{linked.provider} 캘린더 {linked.status === 'ok' ? '연결됨' : '— 읽지 못하는 중'}</b>
          <span>{linked.status === 'ok' ? `마지막 확인 ${ago(linked.fetchedAt)} · 약 30분마다 다시 읽어요` : linked.error}</span>
          <div className="row-actions">
            <button className="secondary" disabled={busy} onClick={() => run('refresh', {}, '지금 다시 읽었어요.')}>지금 다시 읽기</button>
            <button className="link danger" disabled={busy} onClick={() => { if (confirm('캘린더 연결을 끊을까요? 저장된 주소와 일정 시간이 지워져요.')) run('disconnect', {}, '연결을 끊었어요.'); }}>연결 끊기</button>
          </div>
        </div>
      )}
      <p className="muted">내 캘린더에서 일정이 있는 시간만 읽어서, 그 시간은 자동으로 "안 됨"으로 보여요. <b>일정 제목·장소는 저장하지 않고</b>, 팀원에게는 가능·안 됨만 보여요.</p>
      <div className="types">
        {CAL_GUIDES.map((g) => <button type="button" key={g.key} className={tab === g.key ? 'on' : ''} onClick={() => setTab(g.key)}>{g.label}</button>)}
      </div>
      <ol className="guide">{guide.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
      {guide.note && <p className="hint">{guide.note}</p>}
      <form onSubmit={(e) => { e.preventDefault(); run('connect', { url }, ''); }}>
        <label>{linked ? '다른 주소로 바꾸기' : '캘린더 주소'}<input value={url} onChange={(e) => setUrl(e.target.value)} required inputMode="url" autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder="https://… 또는 webcal://…" /></label>
        <ErrorBox error={err} />
        <button className="primary full" disabled={busy || !url.trim()}>{busy ? '캘린더 읽는 중…' : '연결'}</button>
      </form>
      <p className="hint">이 주소는 비밀번호와 같아요. 되는날 서버에는 암호화해서 보관하고, 연결을 끊으면 바로 지워요. 혹시 새어 나갔다면 캘린더 설정에서 주소를 "재설정"하면 예전 주소는 쓸 수 없게 돼요.</p>
    </Sheet>
  );
}

// ---------- gathering ----------
function Gathering({ gid, toast }: { gid: string; toast: (s: string) => void }) {
  const [d, setD] = useState<Any>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const isNew = new URLSearchParams(location.search).get('new') === '1';
  const load = useCallback(() => api(`/gatherings/${gid}`).then((x) => { setD(x); setErr(''); }).catch((e) => setErr(e.message)), [gid]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const id = window.setInterval(() => { if (document.visibilityState === 'visible') load(); }, 20000);
    return () => window.clearInterval(id);
  }, [load]);

  async function act(path: string, body: Any, done: string) {
    setBusy(true);
    try {
      await api(`/gatherings/${gid}/${path}`, body);
      toast(done);
      await load();
    } catch (e: Any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!d) return <main className="page"><Brand /><ErrorBox error={err} retry={load} />{!err && <p className="muted center">불러오는 중…</p>}</main>;
  const g = d.gathering;
  const confirmed = g.status === 'confirmed';
  const when = `${dateLabel(g.date)} ${timeLabel(g.start, g.end)}`;
  const shareInvite = () => share({ title: `${g.title} · ${when}`, text: confirmed ? '날짜가 확정됐어요. 내 캘린더에 추가해 주세요.' : '이날 괜찮은지 참석 / 어려워요만 눌러 주세요.', url: d.shareUrl, button: confirmed ? '캘린더에 추가' : '답하기' }, toast);
  const waitingNames = d.people.filter((p: Any) => !p.response && p.name).map((p: Any) => p.name);

  return (
    <main className="page">
      <header className="topbar">
        <Brand small />
        <button className="chip" onClick={() => go(`${BASE}/b/${d.team.id}`)}>보드로</button>
      </header>
      <section className="card gather">
        <span className={'tag' + (confirmed ? ' green' : '')}>{confirmed ? '날짜 확정' : '참석 확인 중'}</span>
        <h1>{g.title}</h1>
        <p className="when">{when}</p>
        <p className="muted">{d.team.name} · {g.place || '장소 미정'} · 제안 {g.proposerName}</p>

        {isNew && !confirmed && (
          <div className="callout strong"><b>단톡방에 카드를 올려 주세요.</b><span>팀원은 참석 / 어려워요만 누르면 돼요.</span></div>
        )}

        {!confirmed && (
          <>
            <h3>나는</h3>
            <div className="answer">
              <button disabled={busy} className={d.me.response === 'yes' ? 'on yes' : ''} onClick={() => act('respond', { value: 'yes' }, '참석으로 답했어요.')}>참석</button>
              <button disabled={busy} className={d.me.response === 'no' ? 'on no' : ''} onClick={() => act('respond', { value: 'no' }, '어려워요로 답했어요. 보드에도 반영돼요.')}>어려워요</button>
            </div>
          </>
        )}

        <div className="tally">
          <span><b>{d.counts.yes}</b>참석</span><span><b>{d.counts.no}</b>어려워요</span><span><b>{d.counts.waiting}</b>대기</span>
        </div>
        <div className="member-list">
          {d.people.map((p: Any, i: number) => (
            <div key={p.id || 'h' + i} className="member">
              <span className="avatar">{p.name ? p.name[0] : '·'}</span>
              <span className="grow"><b>{p.name || '이름 숨김'}</b>{!p.response && <small>{p.boardHint === 'no' ? '보드상 안 되는 날' : p.boardHint === 'yes' ? '보드상 가능' : '보드 미입력'}</small>}</span>
              <span className={'tag ' + (p.response === 'yes' ? 'green' : p.response === 'no' ? 'red' : '')}>{p.response === 'yes' ? '참석' : p.response === 'no' ? '어려워요' : '대기'}</span>
            </div>
          ))}
        </div>

        <div className="stack">
          <button className="primary" onClick={shareInvite}>{confirmed ? '확정 소식 단톡방에 공유' : '단톡방에 공유'}</button>
          {!confirmed && waitingNames.length > 0 && (
            <button className="secondary" onClick={() => share({ title: `${g.title} 참석 확인`, text: `아직 ${waitingNames.length}명 답이 없어요. 참석 / 어려워요만 눌러 주세요.`, url: d.shareUrl, button: '답하기' }, toast)}>아직 안 한 사람에게 다시 알리기</button>
          )}
        </div>

        {d.me.canManage && !confirmed && (
          <div className="manage">
            <button className="primary full" disabled={busy} onClick={() => { if (confirm(`${when}로 확정할까요? 확정하면 응답을 바꿀 수 없어요.`)) act('confirm', {}, '확정했어요. 단톡방에 알려 주세요.'); }}>이날로 확정</button>
          </div>
        )}

        <h3>내 캘린더에 추가</h3>
        <div className="stack">
          <a className="secondary btn" href={d.icsUrl}>아이폰 · 삼성 캘린더</a>
          <a className="secondary btn" href={d.googleUrl} target="_blank" rel="noopener noreferrer">구글 캘린더</a>
        </div>
        <p className="hint">카톡 안에서 안 열리면 오른쪽 위 메뉴의 "다른 브라우저로 열기"를 눌러 주세요.</p>

        {d.me.canManage && (
          <button className="link danger" disabled={busy} onClick={() => { if (confirm('모임을 삭제할까요? "어려워요"로 보드에 들어간 표시도 지워져요.')) api(`/gatherings/${gid}/delete`, {}).then(() => go(`${BASE}/b/${d.team.id}`)).catch((e) => toast(e.message)); }}>모임 삭제</button>
        )}
      </section>
    </main>
  );
}
