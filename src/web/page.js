/* The page's logic. Lives in its own file, not inside a template literal.
 *
 * That is not tidiness. Both bugs this replaced — a regex whose backslash-d was
 * eaten, and a string literal broken by an eaten newline — came from JavaScript
 * being embedded in a template literal, where the linter cannot see it and every
 * escape is consumed before reaching the browser. As a real file it is linted and
 * checked like everything else.
 */

import { html, setHtml } from '/markup.js';
import { suiToMist, usdcToUnits } from '/units.js';

const EXPLORER = 'https://suiscan.xyz/mainnet/tx/';
const TOKEN = document.body.dataset.token;
const $ = (id) => document.getElementById(id);

// Markup escaping lives in src/web/markup.js: it is security relevant and has no
// DOM dependency, so it is tested on its own rather than only through this file.

/** Say something to the operator without a modal dialog. */
function say(text, kind = 'k') {
  const el = $('ownerMsg');
  if (el) setHtml(el, html`<span class="${kind}">${text}</span>`);
}

let lastText = null;

/** Every API call carries the token. Without it the server answers 403. */
const api = (path, body) => fetch(path, {
  method: body ? 'POST' : 'GET',
  headers: body
    ? { 'Content-Type': 'application/json', 'x-agent-token': TOKEN }
    : { 'x-agent-token': TOKEN },
  ...(body ? { body: JSON.stringify(body) } : {}),
}).then((r) => r.json());

function intentFrom(stdout) {
  // agent.js may print two JSON docs; take the first (the proposal).
  const start = stdout.indexOf('{');
  if (start < 0) return null;
  for (let end = stdout.length; end > start; end--) {
    try { return JSON.parse(stdout.slice(start, end)); } catch { /* keep shrinking */ }
  }
  return null;
}

const walletReady = () => Boolean(window.agentWallet && window.agentWallet.address());

async function loadHires() {
  try {
    const list = await api('/api/hires');
    setHtml($('hires'), html`<span class="label">hires</span>${list.map((h) => {
      const state = h.error
        ? html`<span class="bad">unreadable</span>`
        : h.suspended
          ? html`<span class="bad">SUSPENDED</span>`
          : html`<span class="ok">active</span>`;
      const pool = h.error
        ? '?'
        : html`<span class="${h.ownVenueOpen ? 'ok' : 'warn'}">${h.feeBps / 100}% pool${h.ownVenueOpen ? ' \u2713 allowed' : ' blocked'}</span>`;
      return html`<div class="hire${h.suspended ? ' off' : ''}">
        <b>${h.name}</b>
        <span class="k" title="local record; the real cap is in the OZ ledger">budget ${h.budgetSui} local</span>
        <span class="k">${pool}</span>
        ${state}
        ${h.error ? '' : html`<button class="ghost" data-hire="${h.name}" data-next="${h.suspended ? 'false' : 'true'}">${h.suspended ? 'Resume' : 'Suspend'}</button>`}
      </div>`;
    })}<div class="legend">the swap pool allowlist and suspension are read from the chain; budget figures are local records — the cap itself is enforced in the OZ ledger.</div>`);
    for (const b of $('hires').querySelectorAll('button')) {
      b.onclick = () => toggleHire(b.dataset.hire, b.dataset.next === 'true', b);
    }
    fillHireSelects(list);
  } catch { /* leave the strip as-is */ }
}

async function toggleHire(hire, suspend, btn) {
  btn.disabled = true;
  btn.textContent = suspend ? 'suspending…' : 'resuming…';
  if (!walletReady()) {
    say('connect a wallet first — it holds the key, not this page', 'bad');
    loadHires();
    return;
  }
  // Same three steps as a swap: build here, sign in the extension, submit here.
  const built = await api('/api/build', { kind: 'suspend', hire, suspended: suspend });
  if (!built.id) {
    say(`suspend failed: ${built.refused || built.error || 'build failed'}`, 'bad');
    loadHires();
    return;
  }
  try {
    const signed = await window.agentWallet.sign(built.bytes);
    const out = await api('/api/submit', { id: built.id, signature: signed.signature });
    say(out.digest
      ? `${suspend ? 'suspended' : 'resumed'} ${hire} — ${out.status}`
      : `submit failed: ${out.error || out.output || 'no detail'}`, out.digest ? 'ok' : 'bad');
  } catch (e) {
    say(`signing declined: ${e?.message || e}`, 'bad');
  }
  loadHires();
}

async function refresh() {
  try {
    const s = await api('/api/state');
    setHtml($('stats'), html`
      <span>vault <b>${(Number(s.vaultSuiMist) / 1e9).toFixed(4)} SUI</b></span>
      <span>wallet <b>${(Number(s.walletSuiMist) / 1e9).toFixed(4)} SUI</b></span>
      <span>USDC <b>${(Number(s.usdc) / 1e6).toFixed(6)}</b></span>
      <span>CETUS <b>${(Number(s.cetus) / 1e9).toFixed(9)}</b></span>
      <span>policy module at <b>${s.packageId.slice(0, 10)}…</b></span>`);
  } catch {
    $('stats').textContent = 'state unavailable';
  }
}

async function ask() {
  const text = $('q').value.trim();
  if (!text) return;
  lastText = text;
  setHtml($('agent'), html`<span class="k">thinking locally…</span>`);
  setHtml($('gate'), html`<span class="k">…</span>`);
  setHtml($('chain'), html`<span class="k">not submitted</span>`);
  $('run').disabled = true;

  const r = await api('/api/propose', { text });

  const d = intentFrom(r.stdout);
  if (!d) {
    setHtml($('agent'), html`<span class="bad">could not parse model output</span><pre>${r.stdout.slice(0, 400)}</pre>`);
    return;
  }

  const hint = d.modelHint;
  const hintLine = hint && hint.agent && !hint.groundedInRequest
    ? html`<pre class="warn" style="margin-top:6px">the model also proposed agent "${hint.agent}", which your request does not name — not used. The hire is chosen from your words, not its suggestion.</pre>`
    : '';

  setHtml($('agent'), html`
    <div class="row"><span class="k">you said</span></div>
    <pre>${d.request}</pre>
    <div class="row" style="margin-top:10px"><span class="k">model extracted</span><span class="k">${d.model.model}</span></div>
    <pre>${JSON.stringify(d.intent)}</pre>
    ${hintLine}
    <div class="row" style="margin-top:10px"><span class="k">converted here (not by the model)</span></div>
    <pre>${d.amountMist ?? '—'} MIST</pre>`);

  const v = d.validation || {};
  if (d.decision === 'PROPOSED') {
    setHtml($('gate'), html`
      <div class="badge ok">ALLOWED</div>
      <pre class="ok">${v.ok ? 'gate passed' : ''}</pre>
      <div class="row" style="margin-top:10px"><span class="k">vault balance</span><span>${d.vaultBalanceMist}</span></div>
      <div class="row"><span class="k">planned</span><span>${d.plan.summary}</span></div>
      <pre class="k" style="margin-top:8px">${d.plan.command} ${JSON.stringify(d.plan.env)}</pre>`);
    $('run').disabled = false;
  } else {
    setHtml($('gate'), html`
      <div class="bad">REFUSED</div>
      <pre class="bad">${v.reason || 'refused'}</pre>
      <pre class="k" style="margin-top:10px">the model proposed; this gate disposed. nothing was signed.</pre>`);
  }
}

async function run() {
  if (!lastText) return;
  const set = (markup) => setHtml($('chain'), markup);
  $('run').disabled = true;

  if (!walletReady()) {
    set(html`<div class="bad">no wallet connected</div><pre class="k">Connect Slush first — it holds the key, not this server.</pre>`);
    return;
  }

  // 1. The server builds and keeps the bytes. Nothing is signed yet.
  set(html`<span class="warn">building…</span>`);
  const built = await api('/api/build', { kind: 'swap', text: lastText });
  if (built.error || built.refused) {
    const reason = built.refused?.validation?.reason || built.error || 'build failed';
    set(html`<div class="bad">refused</div><pre class="bad">${reason}</pre>`);
    return;
  }

  // 2. The extension signs, showing its own approval prompt. We get a signature only.
  set(html`<span class="warn">waiting for wallet approval…</span>`);
  let signed;
  try {
    signed = await window.agentWallet.sign(built.bytes);
  } catch (e) {
    set(html`<div class="bad">declined</div><pre class="bad">${e.message || e}</pre>`);
    return;
  }

  // 3. The server submits the bytes it built with the signature it was given.
  set(html`<span class="warn">submitting…</span>`);
  const out = await api('/api/submit', { id: built.id, signature: signed.signature });
  if (out.digest) {
    set(html`
      <div class="${out.status === 'Success' ? 'ok' : 'bad'}">${out.status || 'unknown'}</div>
      <pre style="margin-top:8px"><a href="${EXPLORER}${out.digest}" target="_blank">${out.digest}</a></pre>`);
  } else {
    set(html`<div class="bad">not submitted</div><pre class="bad">${(out.error || out.output || 'no detail').slice(-400)}</pre>`);
  }
  refresh();
  loadHires();
}

$('ask').onclick = ask;
$('run').onclick = run;
$('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(); });
refresh();
loadHires();

// === owner actions ===
//
// Same three steps as Run and Suspend: build here, sign in the extension, submit
// here. Nothing on this page signs, and the server holds no key.
//
// Amount conversion lives in src/web/units.js because it is the piece that turns
// typed text into the integer a transaction carries, and it deserves its own test.

function fillHireSelects(list) {
  for (const id of ['budHire', 'poolHire']) {
    const sel = $(id);
    if (!sel) continue;
    const keep = sel.value;
    setHtml(sel, html`${list.map((h) => html`<option>${h.name}</option>`)}`);
    if (keep && list.some((h) => h.name === keep)) sel.value = keep;
  }
}

async function ownerAction(kind, body) {
  if (!walletReady()) {
    say('connect a wallet first — it holds the key, not this page', 'bad');
    return;
  }
  say(`${kind}: building…`, 'warn');
  const built = await api('/api/build', { kind, ...body });
  if (!built.id) {
    say(`${kind} refused: ${built.refused || built.error || 'build failed'}`, 'bad');
    return;
  }
  try {
    const signed = await window.agentWallet.sign(built.bytes);
    const out = await api('/api/submit', { id: built.id, signature: signed.signature });
    if (!out.digest) {
      return say(`${kind} failed: ${out.error || out.output || 'no detail'}`, 'bad');
    }
    // A create changes which guard every later step has to address. Saying so is the
    // difference between the next click working and it looking like it broke at random.
    //
    // Every property here is read through `?.` on purpose. The first version of this
    // read `out.guard.id` directly, and the server returns `{error}` with no id when the
    // guard cannot be identified -- so it threw, landed in the catch below, and reported
    // "signing declined" for a transaction that had in fact succeeded and been
    // submitted. A failure to identify the guard must read as its own condition.
    const g = out.guard;
    let adopted = '';
    if (g?.error) {
      adopted = ` — but the new guard could not be identified (${g.error}), so the config still`
        + ' points at the old one and the next step will fail. Read the guard id out of'
        + ` ${out.digest} and put it in src/addresses.js.`;
    } else if (g?.id) {
      adopted = ` — now using guard ${g.id.slice(0, 10)}…`
        + (g.persisted ? '' : ' (in memory only — src/addresses.js was NOT updated)');
    }
    return say(`${kind}: ${out.status} — ${out.digest}${adopted}`,
      out.status === 'Success' ? 'ok' : 'bad');
  } catch (e) {
    say(`signing declined: ${e?.message || e}`, 'bad');
  }
  refresh();
  loadHires();
}

$('topup').onclick = () => {
  const mist = suiToMist($('topupAmt').value);
  if (!mist) return say('enter SUI as a plain decimal, e.g. 0.05', 'bad');
  ownerAction('topup', { amountMist: mist });
};

$('setBud').onclick = () => {
  const mist = suiToMist($('budAmt').value);
  if (mist === null) return say('enter SUI as a plain decimal, e.g. 0.03', 'bad');
  ownerAction('budget', { hire: $('budHire').value, amountMist: mist });
};

$('poolAllow').onclick = () => ownerAction('venue', { hire: $('poolHire').value, allow: true });
$('poolBlock').onclick = () => ownerAction('venue', { hire: $('poolHire').value, allow: false });

// Step 1 of the escrow flow. The only step where money moves, and the only one you
// sign — an agent fills the order afterwards, and you reclaim its storage last.
$('ordMake').onclick = () => {
  const amountMist = suiToMist($('ordAmt').value);
  if (!amountMist) return say('enter SUI as a plain decimal, e.g. 0.01', 'bad');
  const minOutUsdc = usdcToUnits($('ordMin').value);
  if (!minOutUsdc) return say('enter USDC as a plain decimal, e.g. 0.005', 'bad');
  return ownerAction('order', { amountMist, minOutUsdc });
};

// The route back to custody, and the step that must run before a package upgrade.
// No amount field: the operation that matters is emptying the vault.
$('withdraw').onclick = () => ownerAction('withdraw', {});

// Hand the grant to a different address, and bound its price, in one transaction.
// Until this runs, agent == owner, so no call can ever be refused as the wrong
// caller and the caller gate is untestable.
$('handOver').onclick = () => {
  const agent = $('agentAddr').value.trim();
  if (!agent) return say('paste the agent address first — the grant is handed to it', 'bad');
  return ownerAction('repoint', {
    hire: $('poolHire').value,
    agent,
    boundBps: $('agentBps').value.trim(),
  });
};

// === the position cycle ===
//
// Open -> fund -> move the range -> exit. Every step is a wallet signature; the
// server only ever builds and submits.
//
// Deliberately *not* a one-click flow. `redeem` closes the position for good and
// the guard keeps the id of a position that no longer exists, so the guard has to
// be created again before there is anything to move or exit. Order matters, and
// the steps are left visible for that reason.

$('posOpen').onclick = () => ownerAction('position', {});

$('depBtn').onclick = () => {
  const usdc = usdcToUnits($('depUsdc').value);
  if (!usdc) return say('enter USDC as a plain decimal, e.g. 0.5', 'bad');
  const sui = suiToMist($('depSui').value);
  if (!sui) return say('enter SUI headroom as a plain decimal, e.g. 0.6', 'bad');
  return ownerAction('deposit', { fixAmountUsdc: usdc, supplySui: sui });
};

$('rebBtn').onclick = () => {
  const lower = Number($('rebLo').value.trim());
  const upper = Number($('rebHi').value.trim());
  if (!Number.isInteger(lower) || !Number.isInteger(upper)) {
    return say('ticks must be whole numbers, e.g. 68800 and 69200', 'bad');
  }
  return ownerAction('rebalance', { tickLower: lower, tickUpper: upper });
};

$('redBtn').onclick = () => ownerAction('redeem', {});

// === wallet ===
//
// The extension holds the key and shows its own approval prompt. This page only
// asks it to sign bytes the server built.
function renderWallet(addr) {
  const el = $('wallet');
  if (addr) {
    setHtml(el, html`
      <span class="ok">wallet connected</span>
      <span class="k">${addr}</span>
      <button id="disconnect" class="ghost">Disconnect</button>`);
    const d = $('disconnect');
    if (d) d.onclick = async () => { await window.agentWallet.disconnect(); };
  } else {
    setHtml(el, html`
      <span class="k">wallet: not connected</span>
      <button id="connect" class="ghost">Connect Slush</button>`);
    $('connect').onclick = doConnect;
  }
}

async function doConnect() {
  const btn = $('connect');
  if (btn) { btn.disabled = true; btn.textContent = 'connecting…'; }
  try {
    await window.agentWallet.connect('slush');
  } catch (e) {
    setHtml($('wallet'), html`<span class="bad">connect failed: </span><span class="k">${e.message || e}</span>`);
  }
}

if (window.agentWallet) {
  window.agentWallet.onChange(renderWallet);
  renderWallet(window.agentWallet.address());
} else {
  setHtml($('wallet'), html`<span class="warn">wallet bundle missing — check the server log</span>`);
}
