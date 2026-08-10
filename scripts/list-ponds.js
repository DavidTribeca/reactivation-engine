/**
 * List every pond in Follow Up Boss, with its id and name.
 *
 *   node scripts/list-ponds.js
 *
 * Read-only. One API call. Exists because the import reports pond membership
 * by numeric id — "pond 76: 6,443 people" — which tells you the shape of the
 * target set but not whether those 6,443 people are ones you want an AI
 * phoning. Two ponds hold 47% of the target between them, and a number is not
 * something a human can sanity-check.
 *
 * Marks the ponds currently excluded as do-not-contact so the two lists can be
 * compared at a glance.
 */

import { DNC_POND_IDS } from '../src/reactivation/adapters/fub.js';

const BASE = 'https://api.followupboss.com/v1';

function authHeader() {
  const key = process.env.FUB_API_KEY;
  if (!key) throw new Error('FUB_API_KEY is not set');
  return 'Basic ' + Buffer.from(`${key}:`).toString('base64');
}

const EXCLUDED = new Set(DNC_POND_IDS.map(Number));

async function main() {
  const res = await fetch(`${BASE}/ponds?limit=100`, {
    headers: {
      Authorization: authHeader(),
      Accept: 'application/json',
      'X-System': process.env.FUB_X_SYSTEM || 'reactivation-engine',
    },
  });

  const body = await res.text();
  if (!res.ok) throw new Error(`FUB ${res.status} on /ponds: ${body.slice(0, 300)}`);

  const data = JSON.parse(body);
  const ponds = data.ponds || data.pond || [];
  if (!ponds.length) {
    console.log('No ponds returned. Raw response:\n' + body.slice(0, 600));
    return;
  }

  console.log('\n  id     status     name');
  console.log('  ' + '-'.repeat(58));
  for (const p of ponds.sort((a, b) => Number(a.id) - Number(b.id))) {
    const flag = EXCLUDED.has(Number(p.id)) ? 'EXCLUDED' : '  called';
    console.log(`  ${String(p.id).padEnd(6)} ${flag.padEnd(10)} ${p.name ?? '(no name)'}`);
  }
  console.log(`\n  ${ponds.length} ponds. EXCLUDED = currently in RE_DNC_POND_IDS ` +
    `(${[...EXCLUDED].join(',')}) and never dialled.`);
  console.log('  Everything marked "called" is in scope for the program.\n');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
