#!/usr/bin/env node
'use strict';
// Thin CLI over the running LLMSwapper server, for the /swapper* skills. Zero dependencies,
// Node 18+ (global fetch). Talks only to the local panel; the panel does the real work.
//
//   node swapper.mjs usage              every account: 5h and 7d quota, who is in use (Ultra: 7d only)
//   node swapper.mjs swap <name>        switch the host's active account to the one named
//   node swapper.mjs auto on|off|status automatic rotation: state and the whole queue
//
// Deliberately spare. Claude Code re-types a skill's stdout into its reply as plain
// markdown, so nothing but layout survives: one line per account, numbers aligned, one
// marker, one word of state. No bars, rules or legends. PORT overrides the port.

const PORT = process.env.PORT || process.env.SWAPPER_PORT || '7373';
const BASE = `http://127.0.0.1:${PORT}`;
const HEADERS = { 'X-Swapper': '1', 'Content-Type': 'application/json' };

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method, headers: HEADERS,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    throw new Error(`No llego al panel en ${BASE}. ¿Está corriendo "node server.js"? (${err.message})`);
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text.slice(0, 200) }; }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ---------- layout ---------- */

const NAME_W = 28;               // "Castillo · carlos" fits; longer labels are truncated
const pad = (s, n) => String(s).padEnd(n);
const num = (p) => (p == null ? '—' : `${p}%`).padStart(4);
const trunc = (s, n) => { s = String(s || ''); return s.length <= n ? s : s.slice(0, n - 1) + '…'; };

// "4h 15m" · "3d 2h" · "12m" until an ISO instant; '' when unknown or already past.
function resetIn(iso) {
  if (!iso) return '';
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

// A label alone when unique; "Castillo · carlos" (email local part) when two share it.
function displayName(acc, all) {
  const dup = all.filter((a) => a.label === acc.label).length > 1;
  const local = acc.email ? acc.email.split('@')[0] : '';
  return trunc(dup && local ? `${acc.label} · ${local}` : acc.label, NAME_W);
}

// One line: marker, name, 5h, 7d, state. Everything lines up on fixed columns.
function line(marker, name, s, w, state) {
  const base = `  ${marker} ${pad(name, NAME_W)} ${num(s)}   ${num(w)}`;
  return state ? `${base}   ${state}` : base.trimEnd();
}
// The column header sits over the numbers with the title at the left.
const head = (title, right) => `${pad(`  ${title}`, 2 + 2 + NAME_W)} ${'5h'.padStart(4)}   ${'7d'.padStart(4)}${right ? `   ${right}` : ''}`;

// An Ultra account has no 5-hour window: its column reads "—", and the week is what it spends.
// Older panels send no tier, which reads as "not Ultra" and keeps the table as it was.
const isUltra = (a) => !!a && a.tier === 'ultra';

function levelWord(s) {
  if (s == null) return '';
  if (s >= 95) return 'tope';
  if (s >= 80) return 'casi';
  return '';
}

// State words for a usage row, joined with " · ". `ultra` reads the week instead of the session.
function stateOf(u, active, extra, ultra = false) {
  const words = [];
  if (active) words.push('en uso');
  if (u && !u.ok) words.push(u.needsRelogin ? 'caducada' : 'sin datos');
  else {
    const win = u && u.ok ? u[ultra ? 'weekly' : 'session'] : null;
    const lw = levelWord(win ? win.percent : null);
    if (lw) words.push(lw);
    if (active) { const r = resetIn(win && win.resetsAt); if (r) words.push(`reset ${r}`); }
  }
  if (extra) words.push(extra);
  return words.join(' · ');
}

/* ---------- usage ---------- */

async function cmdUsage() {
  const [{ accounts, activeId }, usage] = await Promise.all([
    api('/api/accounts?target=host'),
    api('/api/usage/all'),
  ]);
  if (!accounts.length) { console.log('\n  Sin cuentas. Añádelas en el panel.\n'); return; }

  const sess = (a) => { const u = usage[a.id]; return u && u.ok && u.session ? u.session.percent : null; };
  const week = (a) => { const u = usage[a.id]; return u && u.ok && u.weekly ? u.weekly.percent : null; };
  // What each account is ranked by, as the rotation does: the session, or the week for Ultra.
  const key = (a) => (isUltra(a) ? week(a) : sess(a));
  const ord = [...accounts].sort((a, b) => {
    if ((a.id === activeId) !== (b.id === activeId)) return a.id === activeId ? -1 : 1;
    return (key(a) ?? 999) - (key(b) ?? 999);
  });
  // The one worth switching to: freest by its key with room in both windows, not the active. An
  // absent 5-hour window reads 0%, so it never holds an Ultra account back.
  const freest = ord.find((a) => a.id !== activeId && key(a) != null && key(a) < 90 && (sess(a) ?? 0) < 90 && (week(a) ?? 0) < 90) || null;

  const out = ['', head('Swapper · host'), ''];
  for (const a of ord) {
    const active = a.id === activeId;
    const marker = active ? '●' : freest && a.id === freest.id ? '→' : ' ';
    out.push(line(marker, displayName(a, accounts), isUltra(a) ? null : sess(a), week(a), stateOf(usage[a.id], active, freest && a.id === freest.id ? 'más libre' : '', isUltra(a))));
  }
  out.push('');
  console.log(out.join('\n'));
}

/* ---------- swap ---------- */

function findAccount(accounts, query) {
  const q = query.trim().toLowerCase();
  if (!q) throw new Error('Dime a qué cuenta cambiar: /swapper <nombre o email>');
  const exact = accounts.filter((a) => (a.label || '').toLowerCase() === q || (a.email || '').toLowerCase() === q);
  const hits = exact.length ? exact : accounts.filter((a) =>
    (a.label || '').toLowerCase().includes(q) || (a.email || '').toLowerCase().includes(q));
  if (!hits.length) throw new Error(`Ninguna cuenta coincide con "${query}". /swapper-usage muestra los nombres.`);
  if (hits.length > 1) {
    const names = hits.map((a) => a.email ? `${a.label} <${a.email}>` : a.label).join(', ');
    throw new Error(`"${query}" coincide con varias: ${names}. Usa el email.`);
  }
  return hits[0];
}

async function cmdSwap(args) {
  const { accounts, activeId } = await api('/api/accounts?target=host');
  const acc = findAccount(accounts, args.join(' '));
  const already = acc.id === activeId;
  let r = { account: acc, verified: false, warnings: [] };
  if (!already) r = await api('/api/swap', { method: 'POST', body: { id: acc.id, target: 'host' } });
  let u = null;
  try { u = await api(`/api/usage?id=${encodeURIComponent(acc.id)}`); } catch { /* usage is a nicety */ }

  const s = u && u.ok && u.session ? u.session.percent : null;
  const w = u && u.ok && u.weekly ? u.weekly.percent : null;
  const out = ['', line('●', displayName({ ...acc, label: r.account.label }, accounts), isUltra(acc) ? null : s, w, stateOf(u, true, already ? 'ya estaba' : '', isUltra(acc)))];
  out.push(`    ${already ? 'sin cambios' : 'se aplica a sesiones nuevas de Claude Code'}${r.verified ? ' · token verificado' : ''}`);
  for (const wmsg of r.warnings || []) out.push(`    ${wmsg}`);
  out.push('');
  console.log(out.join('\n'));
}

/* ---------- auto ---------- */

async function cmdAuto(args) {
  const verb = (args[0] || 'status').toLowerCase();
  let st;
  if (['on', 'true', 'activar', 'enciende'].includes(verb)) st = await api('/api/auto', { method: 'POST', body: { enabled: true } });
  else if (['off', 'false', 'desactivar', 'apaga'].includes(verb)) st = await api('/api/auto', { method: 'POST', body: { enabled: false } });
  else st = await api('/api/auto');

  // The queue plus the current account is the whole account list, so names can be
  // disambiguated against it just like in usage.
  const all = [...(st.current ? [st.current] : []), ...(st.queue || [])];
  const out = ['', head(`Rotación · ${st.enabled ? 'activada' : 'desactivada'} · ${st.threshold}%`), ''];

  if (st.current) {
    const c = st.current;
    const u = isUltra(c);
    const words = ['en uso'];
    const lw = levelWord(u ? c.weeklyPercent : c.sessionPercent); if (lw) words.push(lw);
    const r = resetIn(u ? c.weeklyResetsAt : c.sessionResetsAt); if (r) words.push(`reset ${r}`);
    out.push(line('●', displayName(c, all), u ? null : c.sessionPercent, c.weeklyPercent, words.join(' · ')));
  }
  for (const q of st.queue || []) {
    const u = isUltra(q);
    const marker = q.role === 'next' ? '→' : ' ';
    const state = q.role === 'next' ? 'siguiente' : q.eligible ? levelWord(u ? q.weeklyPercent : q.sessionPercent) : `excluida · ${q.reason}`;
    out.push(line(marker, displayName(q, all), u ? null : q.sessionPercent, q.weeklyPercent, state));
  }
  if (!st.enabled) out.push('', '    /swapper-auto on para activar');
  out.push('');
  console.log(out.join('\n'));
}

/* ---------- dispatch ---------- */

const [cmd, ...args] = process.argv.slice(2);
const run = { usage: cmdUsage, swap: () => cmdSwap(args), auto: () => cmdAuto(args), status: () => cmdAuto(['status']) };
(run[cmd] || (() => { console.error('uso: swapper.mjs usage | swap <nombre> | auto on|off|status'); process.exitCode = 1; }))()
  .catch((err) => { console.error(`\n  ✗ ${err.message}\n`); process.exitCode = 1; });
