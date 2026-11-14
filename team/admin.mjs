import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openStore } from './store.mjs';
import { settingsStore } from './settings.mjs';

process.umask(0o077);
const dbPath = process.env.DATA_PATH || '/data/team.sqlite';
const s = openStore(dbPath);
try {
  const command = process.argv[2];
  if (command === 'backup') {
    const dir = join(dirname(dbPath), 'backups');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const dest = join(dir, 'team-' + Date.now() + '.sqlite');
    s.db.prepare('VACUUM INTO ?').run(dest);
    console.log(dest);
  } else if (command === 'stats') {
    // Counts only: no names, no dates of individual people.
    const one = (sql) => s.db.prepare(sql).get().n;
    console.log(JSON.stringify({
      teams: one('SELECT COUNT(*) AS n FROM teams'),
      members: one('SELECT COUNT(*) AS n FROM members WHERE active=1'),
      membersWithRecord: one('SELECT COUNT(*) AS n FROM members WHERE active=1 AND updated_at IS NOT NULL'),
      gatherings: one('SELECT COUNT(*) AS n FROM gatherings'),
      confirmed: one("SELECT COUNT(*) AS n FROM gatherings WHERE status='confirmed'"),
      responsesNo: one("SELECT COUNT(*) AS n FROM responses WHERE value='no'"),
      responses: one('SELECT COUNT(*) AS n FROM responses'),
    }, null, 2));
  } else if (command === 'setup-code') {
    const code = settingsStore(dirname(dbPath), process.env.CAL_KEY).newCode();
    console.log(`확인 코드: ${code}  (15분 안에 https://ddggdd.tech/team/admin 에서 입력)`);
  } else {
    throw Error('Usage: node admin.mjs backup|stats|setup-code');
  }
} finally {
  s.close();
}
