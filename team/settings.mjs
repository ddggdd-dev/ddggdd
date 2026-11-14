// Service keys entered through the admin setup page, stored next to the database.
// Secret values are encrypted with CAL_KEY; nothing here is ever sent back to a browser.
import { readFileSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { cipherFromKey } from './calendar.mjs';

const FIELDS = {
  kakaoJsKey: { secret: false, test: /^[0-9a-f]{32}$/i, label: '카카오 JavaScript 키' },
  kakaoRestKey: { secret: false, test: /^[0-9a-f]{32}$/i, label: '카카오 REST API 키' },
  kakaoClientSecret: { secret: true, test: /^[A-Za-z0-9]{20,64}$/, label: '카카오 클라이언트 시크릿' },
  googleClientId: { secret: false, test: /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/, label: '구글 클라이언트 ID' },
  googleClientSecret: { secret: true, test: /^[A-Za-z0-9_-]{20,64}$/, label: '구글 클라이언트 보안 비밀' },
};
const CODE_TTL = 15 * 60000;
const sha = (s) => createHash('sha256').update(s).digest('hex');

export function settingsStore(dataDir, calKey) {
  const file = join(dataDir, 'settings.json');
  const codeFile = join(dataDir, 'setup-code.json');
  const cipher = cipherFromKey(calKey);
  let cache = null;

  function load() {
    if (cache) return cache;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      cache = {};
      for (const [k, v] of Object.entries(raw)) {
        if (!FIELDS[k]) continue;
        cache[k] = FIELDS[k].secret ? (cipher ? cipher.decrypt(v) : '') : v;
      }
    } catch {
      cache = {};
    }
    return cache;
  }

  function save(values) {
    const merged = { ...load(), ...values };
    const out = {};
    for (const [k, v] of Object.entries(merged)) if (v) out[k] = FIELDS[k].secret ? cipher.encrypt(v) : v;
    const tmp = file + '.tmp';
    writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
    cache = null;
  }

  // Run on the server (docker exec ... node admin.mjs setup-code): prints a short one-time code.
  function newCode() {
    const code = String(randomInt(0, 1000000)).padStart(6, '0');
    writeFileSync(codeFile, JSON.stringify({ hash: sha(code), expires: Date.now() + CODE_TTL, tries: 0 }), { mode: 0o600 });
    return code;
  }

  function checkCode(code) {
    if (!existsSync(codeFile)) return '서버에서 확인 코드를 먼저 만들어야 해요.';
    let c;
    try { c = JSON.parse(readFileSync(codeFile, 'utf8')); } catch { return '확인 코드를 다시 만들어 주세요.'; }
    if (Date.now() > c.expires || c.tries >= 5) {
      rmSync(codeFile, { force: true });
      return '확인 코드가 만료됐어요. 다시 만들어 주세요.';
    }
    const ok = typeof code === 'string' && /^\d{6}$/.test(code) && timingSafeEqual(Buffer.from(sha(code)), Buffer.from(c.hash));
    if (!ok) {
      writeFileSync(codeFile, JSON.stringify({ ...c, tries: c.tries + 1 }), { mode: 0o600 });
      return '확인 코드가 맞지 않아요.';
    }
    return null;
  }

  return {
    get: () => load(),
    status: () => Object.fromEntries(Object.keys(FIELDS).map((k) => [k, !!load()[k]])),
    newCode,
    // body: {code, ...fields}; empty fields keep the saved value.
    apply(body) {
      if (!cipher) return { error: '서버에 CAL_KEY가 없어 저장할 수 없어요.' };
      const bad = checkCode(body.code);
      if (bad) return { error: bad };
      const values = {};
      for (const [k, f] of Object.entries(FIELDS)) {
        const v = typeof body[k] === 'string' ? body[k].trim() : '';
        if (!v) continue;
        if (!f.test.test(v)) return { error: `${f.label} 형식이 맞지 않아요. 앞뒤 공백 없이 그대로 붙여 넣어 주세요.` };
        values[k] = v;
      }
      if (!Object.keys(values).length) return { error: '넣은 값이 없어요.' };
      save(values);
      rmSync(codeFile, { force: true });
      return { ok: true, saved: Object.keys(values) };
    },
  };
}

export function dataDirOf(dbPath) {
  return dbPath === ':memory:' ? null : dirname(dbPath);
}
