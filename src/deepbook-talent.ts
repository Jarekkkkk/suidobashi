/*
 * The deepbook grid, as a talent of its own.
 *
 * It has its own process for a reason that is in `src/talents.ts` rather than in this file: a
 * talent's `id` IS its server address, and it is unique — "there is no talent without a server, and
 * no server is reached without a talent". The grid could not be a second entry pointing at the swap
 * filler's port, so it is a server, and being a server is what makes it installable, listable, and
 * reachable by an agent the same way every other talent is.
 *
 * It is also the same program underneath. The actions below shell out to `src/run-grid.ts`, which is
 * what the UI route, the clock, and a person at a terminal all run — so "everything is a talent" costs
 * a manifest and a route rather than a second implementation of the grid.
 *
 *   bun src/deepbook-talent.ts        # 127.0.0.1:8792
 */
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import {
  DEEPBOOK_BALANCE_MANAGER_ID,
  DEEPBOOK_GUARD_ID,
  DEEPBOOK_GUARD_PACKAGE,
} from './addresses.js';

const PORT = Number(process.env.DEEPBOOK_TALENT_PORT ?? 8792);
const HOST = '127.0.0.1';

/**
 * Run the runner and hand back what it printed.
 *
 * One JSON object per step, each starting a line — the same relay the UI route performs, because it
 * is the same program. A talent that reimplemented the grid would be a second thing to keep honest.
 */
function runGrid(extra: string[]) {
  const out = spawnSync(
    'bun',
    ['src/run-grid.ts', '--guard', DEEPBOOK_GUARD_ID, '--bm', DEEPBOOK_BALANCE_MANAGER_ID, ...extra],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 120_000 },
  );
  const steps = (out.stdout ?? '').split(/\n(?=\{)/).flatMap((chunk) => {
    try {
      return [JSON.parse(chunk)];
    } catch {
      return [];
    }
  });
  return { status: out.status, steps, stderr: (out.stderr ?? '').trim().slice(0, 400) || null };
}

const json = (res: http.ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  let url: URL;
  try {
    url = new URL(`http://local${req.url}`);
  } catch {
    return json(res, 400, { error: 'bad request URL' });
  }

  if (req.method === 'GET' && url.pathname === '/metadata') {
    // What a publisher declares. The terms are the part a maker reads before pointing a guard here,
    // and the second of them is the sentence this whole project exists to make true.
    return json(res, 200, {
      schemaVersion: '1',
      strategy: { id: 'sui-tokyo-grid', version: '1.0.0' },
      actions: [
        {
          id: 'grid.status',
          title: 'Read the DeepBook guard',
          description: 'The account an agent may trade: its limits, the book, the funds it holds, and '
            + 'what a pass would do. Changes nothing and signs nothing.',
          terms: {
            side: 'ask or bid — which side the ladder is quoted on',
            levels: '1 to 20, per pass',
            expire: 'minutes an order lives, 1 to 1440',
          },
        },
        {
          id: 'grid.run',
          title: 'Run one grid pass',
          description: 'Places a ladder through the guard, signed by whoever holds the seat.',
          terms: {
            boundBy: 'the guard, ON CHAIN — the band, the per-order bound, the budget, the pause',
            notBoundBy: 'this server. The limits hold even if every server in the path is compromised.',
            expires: 'an expiry is REQUIRED; DeepBook refuses zero, and expiry is not a timer — order '
              + 'funds leave on a cancel, not on a clock',
          },
        },
      ],
      routes: {
        'grid.status': 'GET /grid/status?side=&levels=&expire=',
        'grid.run': 'POST /grid/run?side=&levels=&expire=',
      },
      guard: { package: DEEPBOOK_GUARD_PACKAGE, guard: DEEPBOOK_GUARD_ID, balanceManager: DEEPBOOK_BALANCE_MANAGER_ID },
    });
  }

  // The same parameter contract either way: `side`, `levels`, `expire` by query, clamped, so that
  // an agent cannot ask for an unbounded ladder by leaving a field out.
  if (url.pathname === '/grid/status' || url.pathname === '/grid/run') {
    const run = url.pathname === '/grid/run';
    if (run && req.method !== 'POST') return json(res, 405, { error: 'grid.run is a POST' });
    if (!run && req.method !== 'GET') return json(res, 405, { error: 'grid.status is a GET' });

    const side = url.searchParams.get('side') === 'bid' ? 'bid' : 'ask';
    const levels = String(Math.min(Math.max(Number(url.searchParams.get('levels')) || 1, 1), 20));
    const expire = String(Math.min(Math.max(Number(url.searchParams.get('expire')) || 60, 1), 1440));

    const out = runGrid(['--side', side, '--levels', levels, '--expire-min', expire, ...(run ? ['--execute'] : [])]);
    return json(res, 200, {
      ok: out.status === 0,
      ran: run,
      requested: { side, levels: Number(levels), expireMinutes: Number(expire) },
      steps: out.steps,
      stderr: out.stderr,
    });
  }

  return json(res, 404, { error: `no such route: ${url.pathname}` });
});

server.listen(PORT, HOST, () => {
  console.log(`deepbook talent on http://${HOST}:${PORT}`);
  console.log(`  guard ${DEEPBOOK_GUARD_ID}`);
  console.log(`  account ${DEEPBOOK_BALANCE_MANAGER_ID}`);
});
