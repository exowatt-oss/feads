#!/usr/bin/env node
/**
 * feads-verify.mjs — prove the UI and the bd backend are actually wired together.
 *
 * `GET /healthz` only tells you the Express app is up; the UI holds no data of
 * its own and shells out to bd for everything, so a served page with a broken or
 * misdirected backend renders a perfectly healthy-looking empty board. This
 * opens the same WebSocket the browser uses, subscribes to a list, and requires
 * a real snapshot envelope back.
 *
 * Env:
 *   FEADS_URL  WebSocket URL (default ws://127.0.0.1:4141/ws)
 *
 * Exit 0 on a snapshot, 1 on error/timeout. An empty board is still a pass —
 * zero issues is a legitimate state; a protocol or backend error is not.
 */

const url = process.env.FEADS_URL || 'ws://127.0.0.1:4141/ws';
const TIMEOUT_MS = 15000;
const SUB_TYPE = 'all-issues';

const fail = (msg) => {
  console.error(`  verify failed: ${msg}`);
  process.exit(1);
};

let ws;
try {
  ws = new WebSocket(url);
} catch (err) {
  fail(`could not open ${url}: ${err.message}`);
}

const timer = setTimeout(
  () => fail(`no snapshot from ${url} within ${TIMEOUT_MS}ms`),
  TIMEOUT_MS
);

ws.onerror = (event) => fail(`websocket error on ${url}: ${event.message || event.type}`);

ws.onclose = () => {
  clearTimeout(timer);
};

ws.onopen = () => {
  ws.send(
    JSON.stringify({
      id: 'verify-1',
      type: 'subscribe-list',
      payload: { id: 'verify-sub', type: SUB_TYPE }
    })
  );
};

ws.onmessage = (event) => {
  let msg;
  try {
    msg = JSON.parse(String(event.data));
  } catch {
    return fail('server sent a non-JSON message');
  }

  // The server answers a bad request with ok:false and an error envelope.
  if (msg.ok === false) {
    return fail(`${msg.type}: ${msg.error?.code ?? 'error'}: ${msg.error?.message ?? 'unknown'}`);
  }

  if (msg.type !== 'snapshot') return; // subscribe ack; the snapshot is a separate frame

  const issues = msg.payload?.issues;
  if (!Array.isArray(issues)) {
    return fail("snapshot arrived without an 'issues' array");
  }

  clearTimeout(timer);
  const sample = issues
    .slice(0, 3)
    .map((i) => i.id)
    .join(', ');
  console.log(
    `  ok backend↔UI verified: ${SUB_TYPE} snapshot, ${issues.length} issue(s)` +
      (sample ? ` (${sample}${issues.length > 3 ? ', …' : ''})` : '')
  );
  ws.close();
  process.exit(0);
};
