// LLMSwapper frontend. No framework, no CDN, no build.

// The usage endpoint allows roughly 5 requests per 5 minutes for the WHOLE app. What actually
// bounds our request rate is the server-side floor (MIN_GAP_MS, 80s between ANY two outbound
// calls), NOT this interval - a poll that arrives sooner than the floor is just served cache or a
// "queued" marker, never another request. So polling every 5 minutes is safe: it asks the server
// for fresh numbers more often, and the server hands back what the floor lets it fetch. Reading
// usage costs no tokens and does not touch the 5h/weekly quota, so there is nothing to save by
// polling less. Refresh (the button) forces past the cache; the background poll does not.
const POLL_MS = 5 * 60 * 1000;

/* ---------------- idioma ----------------
 *
 * Dos idiomas en un objeto, sin dependencias ni fichero aparte: la interfaz cabe en unas setenta
 * cadenas y un JSON extra costaría una petición más en el arranque para no ganar nada.
 *
 * Las claves con marcado (<code>, <strong>) se inyectan como HTML, y por eso NUNCA se construyen
 * con datos de fuera: todas viven aquí. Lo que sí viene de fuera - un nombre de cuenta, una
 * variable de entorno - entra siempre por textContent.
 *
 * Los mensajes de error del SERVIDOR siguen en castellano: llegan ya redactados por la API y
 * traducirlos exigiría que esta devolviera códigos. Está anotado en el README.
 */
const I18N = {
  es: {
    'addToken': 'añadir token',
    'addToken.title': 'Añadir una cuenta pegando un token · T',
    'refresh': 'refresh',
    'refresh.title': 'Actualizar uso · R',
    'lang.group': 'Idioma',
    'theme.group': 'Tema',
    'theme.dark': 'Tema oscuro',
    'theme.light': 'Tema claro',
    'cancel': 'cancelar',
    'yes': 'sí',
    'no': 'no',

    'banner.offline': 'Sin respuesta del servidor local. ¿Se ha cerrado <code>node server.js</code>?',
    'banner.container': 'En contenedor: no puede ver si Claude Code está abierto ni ofrecer targets de WSL. El swap sobre el host sí funciona si montaste su <code>~/.claude</code>.',
    'banner.stale': 'El <code>~/.claude.json</code> montado ya no es el fichero del host: Claude Code lo reemplazó y el contenedor se quedó con el viejo. Reinicia el contenedor (<code>docker compose restart</code>) o, en Linux, monta el directorio en vez del fichero (README, Docker).',
    'banner.env': 'gana al fichero de credenciales: mientras siga definida, los cambios de cuenta <strong>no tendrán efecto</strong> en Claude Code.',

    'dir.label': 'Importar desde otra carpeta de configuración',
    'dir.submit': 'importar',
    'dir.help': 'La carpeta que usaste al ejecutar <code>CLAUDE_CONFIG_DIR=… claude</code>. Tu sesión activa no se toca.',

    'token.label': 'Añadir una cuenta con un token de larga duración',
    'token.ph': 'pega aquí el token',
    'token.namePh': 'nombre (opcional)',
    'token.nameAria': 'Nombre para esta cuenta',
    'token.submit': 'añadir',
    'token.get': 'ábrelo en una terminal',
    'token.getTitle': 'Abre una terminal y ejecuta claude setup-token por ti',
    'token.opened': 'Terminal abierta ({how}). Aprueba en el navegador y pega aquí el token.',
    'token.help': 'Genéralo con <code>claude setup-token</code>: vale un año y no hace falta volver a entrar. Solo da permiso de inferencia, así que esa cuenta no podrá mostrar plan ni correo.',

    'tabs.group': 'Entorno',
    'rescan.title': 'Buscar distros de WSL otra vez',
    'rescan.none': 'Sin cambios: los mismos entornos de antes',
    'rescan.found': 'Nuevo entorno detectado: {names}',
    'tab.running': 'Claude Code está abierto en {name}',

    'empty.title': '0 cuentas registradas',
    'empty.step1': 'Ejecuta <code>claude setup-token</code> en una terminal.',
    'empty.step2': 'Apruébalo en el navegador y copia el token que imprime.',
    'empty.step3': 'Pulsa <strong>Añadir token</strong> y pégalo aquí.',
    'empty.footnote': 'Una vez por cuenta y dura un año. También puedes <strong>importar</strong> la sesión que ya tengas abierta: esas cuentas sí muestran consumo sin gastar tokens.',

    'import': 'import',
    'import.current': 'import cuenta actual',
    'import.title': 'Guarda la cuenta con la que tienes sesión ahora en este entorno · Mayús+clic para una carpeta CLAUDE_CONFIG_DIR',

    'col.account': 'cuenta',
    'col.session': 'sesión · 5h',
    'col.week': 'semana · 7d',
    'col.action': 'Acción',

    'swap': 'swap',
    'inUse': 'en uso',
    'swap.title': 'Poner {name} como activa en {env}',
    'rename.title': 'Renombrar {name}',
    'remove.title': 'Quitar {name} del dashboard',
    'remove.q': '¿quitar?',
    'remove.aria': '¿Quitar {name} del dashboard?',

    'reset.done': 'Reiniciado',
    'reset.dh': 'Se reinicia en {d} d {h} h',
    'reset.hm': 'Se reinicia en {h} h {m} min',
    'reset.m': 'Se reinicia en {m} min',
    'reset.s': 'Se reinicia en {s} s',
    'sync.now': 'Actualizado ahora',
    'sync.s': 'Actualizado hace {s} s',
    'sync.min': 'Actualizado hace {m} min',

    'note.stale': 'Datos de {age}',
    'note.queued': 'Datos de {age} · se actualiza en {s} s',
    'note.ageMin': 'hace {m} min',
    'note.ageUnder': 'hace menos de un minuto',
    'note.expired': 'Token caducado. Haz /login con esta cuenta y vuelve a importarla.',

    'toast.added': 'Añadida: {name}',
    'toast.imported': 'Importada: {name}',
    'toast.removed': '{name} eliminada del dashboard',
    'toast.swapped': 'Cuenta activa en {env}: {name}',
    'toast.swapFailed': 'No se pudo cambiar: {error}',
  },

  en: {
    'addToken': 'add token',
    'addToken.title': 'Add an account by pasting a token · T',
    'refresh': 'refresh',
    'refresh.title': 'Refresh usage · R',
    'lang.group': 'Language',
    'theme.group': 'Theme',
    'theme.dark': 'Dark theme',
    'theme.light': 'Light theme',
    'cancel': 'cancel',
    'yes': 'yes',
    'no': 'no',

    'banner.offline': 'No answer from the local server. Did <code>node server.js</code> stop?',
    'banner.container': 'In a container: it cannot see whether Claude Code is running, and there are no WSL targets. Swapping the host still works if you mounted its <code>~/.claude</code>.',
    'banner.stale': 'The mounted <code>~/.claude.json</code> is no longer the host file: Claude Code replaced it and the container kept the old one. Restart the container (<code>docker compose restart</code>) or, on Linux, mount the directory instead of the file (README, Docker).',
    'banner.env': 'outranks the credentials file: while it is set, switching accounts <strong>will have no effect</strong> in Claude Code.',

    'dir.label': 'Import from another config directory',
    'dir.submit': 'import',
    'dir.help': 'The directory you used when running <code>CLAUDE_CONFIG_DIR=… claude</code>. Your active session is left alone.',

    'token.label': 'Add an account with a long-lived token',
    'token.ph': 'paste the token here',
    'token.namePh': 'name (optional)',
    'token.nameAria': 'Name for this account',
    'token.submit': 'add',
    'token.get': 'open a terminal for me',
    'token.getTitle': 'Opens a terminal and runs claude setup-token for you',
    'token.opened': 'Terminal opened ({how}). Approve in the browser, then paste the token here.',
    'token.help': 'Mint one with <code>claude setup-token</code>: it lasts a year and needs no further login. It only grants inference, so that account cannot show a plan or an email.',

    'tabs.group': 'Environment',
    'rescan.title': 'Scan for WSL distros again',
    'rescan.none': 'No change: the same environments as before',
    'rescan.found': 'New environment found: {names}',
    'tab.running': 'Claude Code is running in {name}',

    'empty.title': 'No accounts yet',
    'empty.step1': 'Run <code>claude setup-token</code> in a terminal.',
    'empty.step2': 'Approve it in the browser and copy the token it prints.',
    'empty.step3': 'Press <strong>add token</strong> and paste it here.',
    'empty.footnote': 'Once per account, and it lasts a year. You can also <strong>import</strong> a session you already have open: those accounts do show usage without spending tokens.',

    'import': 'import',
    'import.current': 'import current account',
    'import.title': 'Store the account you are signed in with in this environment · Shift+click for a CLAUDE_CONFIG_DIR folder',

    'col.account': 'account',
    'col.session': 'session · 5h',
    'col.week': 'week · 7d',
    'col.action': 'Action',

    'swap': 'swap',
    'inUse': 'in use',
    'swap.title': 'Make {name} active in {env}',
    'rename.title': 'Rename {name}',
    'remove.title': 'Remove {name} from the dashboard',
    'remove.q': 'remove?',
    'remove.aria': 'Remove {name} from the dashboard?',

    'reset.done': 'Reset',
    'reset.dh': 'Resets in {d} d {h} h',
    'reset.hm': 'Resets in {h} h {m} min',
    'reset.m': 'Resets in {m} min',
    'reset.s': 'Resets in {s} s',
    'sync.now': 'Refreshed just now',
    'sync.s': 'Refreshed {s} s ago',
    'sync.min': 'Refreshed {m} min ago',

    'note.stale': 'Data from {age}',
    'note.queued': 'Data from {age} · updates in {s} s',
    'note.ageMin': '{m} min ago',
    'note.ageUnder': 'less than a minute ago',
    'note.expired': 'Token expired. Run /login with this account and import it again.',

    'toast.added': 'Added: {name}',
    'toast.imported': 'Imported: {name}',
    'toast.removed': '{name} removed from the dashboard',
    'toast.swapped': 'Active account in {env}: {name}',
    'toast.swapFailed': 'Could not switch: {error}',
  },
};

let lang = document.documentElement.lang === 'en' ? 'en' : 'es';

/** Una cadena traducida, con {marcadores} sustituidos. Cae al castellano si falta la clave. */
function t(key, vars) {
  let s = (I18N[lang] && I18N[lang][key]) ?? I18N.es[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split('{' + k + '}').join(v);
  return s;
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const envsEl = $('#envs');
const tpl = $('#tpl-row');
const tplEnv = $('#tpl-env');

let accounts = [];
let usageById = {};
let lastFetch = 0;
let swapping = false;
// AbortController of the inline row interaction currently open - a "¿quitar?" confirmation or a
// rename - if any. Also doubles as "this row is mid-conversation with the user", which the
// keyboard shortcuts must not talk over and which render() aborts before replacing the node.
let openConfirm = null;
// Environments shown at once, from /api/targets: [{id,label,kind,activeId,running}]. The
// account list is shared; each section marks its own active account and swaps into it.
let targetList = [{ id: 'host', label: 'host', kind: 'host', activeId: null, running: false }];
// Which environment's tab is open. Survives a reload because losing it on every refresh would
// mean re-picking your WSL distro all day; falls back to the host when the remembered one is
// gone (a distro stopped, or WSL removed).
let selectedTarget = (() => {
  try { return localStorage.getItem('swapper.target') || 'host'; } catch { return 'host'; }
})();
function selectTarget(id) {
  selectedTarget = id;
  try { localStorage.setItem('swapper.target', id); } catch { /* private window: not worth failing over */ }
  render();
}

/**
 * Rellena todo lo marcado con data-i18n*. Se ejecuta al arrancar y en cada cambio de idioma;
 * como render() reconstruye las filas, tambien despues de cada render.
 */
function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  // Solo cadenas del diccionario de arriba, jamas datos de fuera.
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  for (const el of root.querySelectorAll('[data-i18n-ph]')) el.placeholder = t(el.dataset.i18nPh);
}

function setLang(next) {
  lang = next;
  document.documentElement.lang = next;
  try { localStorage.setItem('swapper.lang', next); } catch { /* ventana privada: no vale fallar por esto */ }
  for (const b of $$('#switch-lang button')) b.setAttribute('aria-pressed', String(b.dataset.lang === next));
  applyI18n();
  render(); // las filas llevan textos construidos en JS, no solo data-i18n
}

function setTheme(next) {
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('swapper.theme', next); } catch { /* idem */ }
  for (const b of $$('#switch-theme button')) b.setAttribute('aria-pressed', String(b.dataset.theme === next));
}

/* ---------------- transport ---------------- */

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'X-Swapper': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { ok: false, error: text.slice(0, 200) }; }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ---------------- toasts ---------------- */

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`.trim();
  el.append(document.createTextNode(message));
  $('#toasts').append(el);
  setTimeout(() => {
    el.classList.add('leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, kind === 'err' ? 7000 : 4000);
}

/* ---------------- formatting ---------------- */

function countdown(iso) {
  if (!iso) return '';
  const target = Date.parse(iso);
  if (Number.isNaN(target)) return '';
  const ms = target - Date.now();
  if (ms <= 0) return t('reset.done');

  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  if (d > 0) return t('reset.dh', { d, h });
  if (h > 0) return t('reset.hm', { h, m });
  if (m > 0) return t('reset.m', { m });
  return t('reset.s', { s });
}

function syncLabel(ms) {
  if (!ms) return '';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 15) return t('sync.now');
  if (s < 60) return t('sync.s', { s });
  return t('sync.min', { m: Math.floor(s / 60) });
}

function fillMeter(meterEl, data, extra) {
  const known = !!data;
  meterEl.dataset.sev = known ? data.severity : 'unknown';
  $('.value', meterEl).textContent = known ? `${data.percent}%` : '-';
  const fill = $('.fill', meterEl);
  // scaleX rather than width: the compositor handles it and no layout is triggered.
  // Next frame, so the transition actually plays on first paint.
  const pct = known ? Math.max(0, Math.min(100, data.percent)) : 0;
  requestAnimationFrame(() => { fill.style.transform = `scaleX(${pct / 100})`; });
  const resets = $('.resets', meterEl);
  resets.textContent = known ? countdown(data.resetsAt) : '';
  resets.dataset.resetsAt = (known && data.resetsAt) || '';
  // Scoped limits are weekly figures, so they belong on the weekly meter's own line
  // rather than costing the row a full extra line of height.
  resets.dataset.extra = extra || '';
  if (extra) resets.textContent = resets.textContent ? `${resets.textContent} · ${extra}` : extra;
}

/* ---------------- rendering ---------------- */

function skeletonRow() {
  const row = document.createElement('article');
  row.className = 'row is-skeleton';
  row.innerHTML = '<div class="who"><span class="bone" style="width:60%"></span></div>'
    + '<span class="bone" style="width:56px"></span>'
    + '<div class="meter"><span class="bone"></span></div>'
    + '<div class="meter"><span class="bone"></span></div>'
    + '<div class="actions"><span class="bone" style="width:84px;height:26px"></span></div>';
  return row;
}

function renderSkeletons(n = 2) {
  envsEl.innerHTML = '';
  const panel = document.createElement('div');
  panel.className = 'panel';
  const rows = document.createElement('div');
  rows.className = 'rows';
  for (let i = 0; i < n; i++) rows.append(skeletonRow());
  panel.append(rows);
  envsEl.append(panel);
}

function noteFor(usage) {
  if (!usage) return null;
  if (usage.ok) {
    if (usage.stale) {
      const mins = Math.round((Date.now() - usage.staleSince) / 60000);
      const age = mins >= 1 ? t('note.ageMin', { m: mins }) : t('note.ageUnder');
      // Queued behind the rate floor: say so, or "old data" reads as a broken refresh.
      if (usage.queued && Number.isFinite(usage.retryInS)) {
        return { tone: 'warn', text: t('note.queued', { age, s: usage.retryInS }) };
      }
      return { tone: 'warn', text: t('note.stale', { age }) };
    }
    return null;
  }
  if (usage.needsRelogin) {
    return { tone: 'error', text: t('note.expired') };
  }
  // Throttled or rate-limited says nothing about the account: it still swaps.
  return { tone: 'warn', text: usage.error };
}

function buildRow(account, target) {
  const node = tpl.content.firstElementChild.cloneNode(true);
  const usage = usageById[account.id];
  const isActive = account.id === target.activeId;

  node.dataset.id = account.id;
  node.classList.toggle('is-active', isActive);
  if (usage && !usage.ok) {
    node.classList.add(usage.needsRelogin ? 'is-error' : 'is-waiting');
  }

  $('.name', node).textContent = account.label;

  const usable = usage && usage.ok ? usage : null;
  const scoped = usable ? (usable.scoped || []).map((s) => `${s.label} ${s.percent}%`).join(' · ') : '';
  fillMeter($('.meter[data-kind="session"]', node), usable && usable.session);
  fillMeter($('.meter[data-kind="weekly"]', node), usable && usable.weekly, scoped);

  const note = noteFor(usage);
  const noteEl = $('.row-note', node);
  if (note) {
    noteEl.hidden = false;
    noteEl.dataset.tone = note.tone;
    noteEl.textContent = note.text;
  }

  const swapBtn = $('.btn-swap', node);
  if (isActive) {
    swapBtn.remove();
  } else {
    swapBtn.disabled = swapping;
    swapBtn.title = t('swap.title', { name: account.label, env: target.label });
    swapBtn.addEventListener('click', () => doSwap(account.id, target.id, swapBtn));
  }
  const renameBtn = $('.btn-rename', node);
  renameBtn.title = t('rename.title', { name: account.label });
  renameBtn.setAttribute('aria-label', renameBtn.title);
  renameBtn.addEventListener('click', () => armRename(node, account));

  // Per row, or every remove button in the panel announces the same name and a screen
  // reader user cannot tell which account they are about to drop.
  const removeBtn = $('.btn-remove', node);
  removeBtn.title = t('remove.title', { name: account.label });
  removeBtn.setAttribute('aria-label', removeBtn.title);
  removeBtn.addEventListener('click', () => armRemoval(node, account));

  return node;
}

// Active first (for THIS environment), then the least-used session: the next worth switching to.
function sortedFor(target) {
  return [...accounts].sort((a, b) => {
    const aa = a.id === target.activeId;
    const bb = b.id === target.activeId;
    if (aa !== bb) return aa ? -1 : 1;
    const ua = usageById[a.id];
    const ub = usageById[b.id];
    const pa = ua && ua.ok ? ua.session.percent : 999;
    const pb = ub && ub.ok ? ub.session.percent : 999;
    return pa - pb;
  });
}

/**
 * Re-scan for WSL distros, skipping the server's 30-second cache.
 *
 * That cache exists because detection spawns several wsl.exe calls and /api/targets is polled,
 * but it also means a distro you just installed does not show up for half a minute - and if
 * Claude Code has never run in it, not until it has. This is the button for "I just set that up,
 * look again", which otherwise meant restarting the server.
 *
 * It asks for /api/targets and NOTHING else. It used to call refresh(), which also re-fetched
 * every account and their usage and disabled the toolbar's refresh button while it did - so
 * looking for a distro spent a slot of the usage endpoint's tiny budget and made the other
 * button flicker for reasons the user could not connect to what they had just pressed. Two
 * buttons, two jobs.
 */
async function rescanTargets(button) {
  const bar = $('#tabs');
  button.disabled = true;
  button.classList.add('is-loading');
  bar.classList.add('is-scanning');

  const antes = new Set(targetList.map((x) => x.id));
  // Un suelo de tiempo: la deteccion puede volver en 80 ms y un parpadeo de 80 ms no se ve, asi
  // que el boton parece no haber hecho nada. Con medio segundo el barrido se lee.
  const suelo = new Promise((r) => setTimeout(r, 550));

  try {
    const res = await api('/api/targets?force=1');
    await suelo;
    if (res && Array.isArray(res.targets) && res.targets.length) targetList = res.targets;

    const nuevos = targetList.filter((x) => !antes.has(x.id));
    render();

    if (nuevos.length) {
      // Marcar las pestañas nuevas: sin esto, en una fila de cuatro no se ve cual acaba de salir.
      for (const n of nuevos) {
        const el = $(`#tabs .tab[data-target="${n.id}"]`);
        if (el) el.classList.add('is-new');
      }
      toast(t('rescan.found', { names: nuevos.map((n) => n.label).join(', ') }), 'ok');
    } else {
      toast(t('rescan.none'));
    }
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    bar.classList.remove('is-scanning');
    button.disabled = false;
    button.classList.remove('is-loading');
  }
}

/**
 * The tab strip. One per environment, in the order the server reports them - host first, then
 * each WSL distro - so the row does not reshuffle between polls.
 *
 * A dot marks an environment with Claude Code open. It used to be a sentence next to every
 * section title saying the change lands on new sessions; as a permanent label it was noise, and
 * the swap already says exactly that, once, in the toast that follows it.
 */
function buildTabs() {
  const bar = $('#tabs');
  bar.innerHTML = '';
  bar.hidden = false;

  for (const target of targetList) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'tab';
    tab.setAttribute('role', 'tab');
    tab.dataset.target = target.id;
    tab.setAttribute('aria-selected', String(target.id === selectedTarget));
    tab.textContent = target.label;

    if (target.running) {
      const dot = document.createElement('span');
      dot.className = 'tab-run';
      dot.setAttribute('aria-hidden', 'true');
      tab.append(dot);
      tab.title = t('tab.running', { name: target.label });
    }

    tab.addEventListener('click', () => selectTarget(target.id));
    bar.append(tab);
  }

  // Sits after the tabs, not in the toolbar: it re-scans THIS row, and the toolbar's refresh
  // already means something else (the usage numbers).
  const rescan = document.createElement('button');
  rescan.type = 'button';
  rescan.className = 'btn-icon tab-rescan';
  rescan.title = t('rescan.title');
  rescan.setAttribute('aria-label', rescan.title);
  rescan.innerHTML = '<svg class="ico" viewBox="0 0 18 18" aria-hidden="true"><use href="#i-refresh"/></svg>';
  rescan.addEventListener('click', () => rescanTargets(rescan));
  bar.append(rescan);
}

// The panel for ONE environment: the shared accounts, marked and swappable for that one.
function buildSection(target) {
  const node = tplEnv.content.firstElementChild.cloneNode(true);
  node.dataset.target = target.id;

  // Import the account currently logged into THIS environment. Shift-click on the host
  // uses an isolated login dir; WSL has no such concept, so it just imports normally.
  const imp = $('.btn-import-env', node);
  imp.addEventListener('click', (e) => {
    if (e.shiftKey && target.kind === 'host') { openDirField(); return; }
    importCurrent(null, target.id);
  });

  const rows = $('.rows', node);
  for (const account of sortedFor(target)) rows.append(buildRow(account, target));
  return node;
}

function render() {
  const has = accounts.length > 0;
  $('#empty').hidden = has;
  envsEl.hidden = !has;
  envsEl.setAttribute('aria-busy', 'false');
  // Every row is about to be replaced, so an open confirmation is answering about a node
  // that will not exist - drop it and its document-level listeners with it.
  if (openConfirm) { openConfirm.abort(); openConfirm = null; }
  envsEl.innerHTML = '';

  if (has) {
    // A remembered distro can disappear between reloads; falling back keeps the panel usable
    // instead of rendering nothing at all.
    const target = targetList.find((t) => t.id === selectedTarget) || targetList[0];
    selectedTarget = target.id;
    buildTabs();
    envsEl.append(buildSection(target));
  } else {
    $('#tabs').hidden = true;
  }
  // Las plantillas clonadas traen sus data-i18n sin resolver, asi que se traducen aqui, despues
  // de insertarlas: hacerlo solo al arrancar dejaria cada fila nueva en el idioma del HTML.
  applyI18n(envsEl);
  $('#sync').textContent = syncLabel(lastFetch);
}

/* ---------------- actions ---------------- */

/**
 * Destructive, so it asks - inline, in the row itself. A native confirm() cannot be
 * styled, blocks the whole page, and reads as a browser artefact rather than part of
 * the tool. Escape or a click elsewhere backs out.
 *
 * One AbortController owns all four listeners, so closing by ANY route drops them all.
 * {once:true} only fires-and-forgets: closing with Escape left the yes/no handlers
 * attached, and re-opening on the same row stacked another pair - one click on "sí" then
 * sent two DELETEs, the second answering 404, so the user saw a success toast and an
 * error toast for the same removal. It also outlives the row: render() wipes rowsEl, and
 * the document-level listeners would keep pointing at a detached node.
 */
function armRemoval(node, account) {
  const confirmEl = $('.confirm', node);
  if (!confirmEl.hidden) return;

  const ac = new AbortController();
  const { signal } = ac;
  const close = () => {
    confirmEl.hidden = true;
    node.classList.remove('is-confirming');
    if (openConfirm === ac) openConfirm = null;
    ac.abort();
  };

  confirmEl.hidden = false;
  node.classList.add('is-confirming');
  // Named, or a screen reader lands on a bare "no" button with no idea what it answers.
  confirmEl.setAttribute('role', 'group');
  confirmEl.setAttribute('aria-label', t('remove.aria', { name: account.label }));
  openConfirm = ac;
  $('.btn-no', confirmEl).focus();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  }, { capture: true, signal });
  // Deferred, or the very click that opened this would immediately close it.
  setTimeout(() => document.addEventListener('pointerdown', (e) => {
    if (!confirmEl.contains(e.target)) close();
  }, { capture: true, signal }), 0);

  $('.btn-no', confirmEl).addEventListener('click', close, { signal });
  $('.btn-yes', confirmEl).addEventListener('click', async () => {
    close();
    try {
      await api(`/api/accounts/${account.id}`, { method: 'DELETE' });
      toast(t('toast.removed', { name: account.label }), 'ok');
      await refresh(false);
    } catch (err) {
      toast(err.message, 'err');
    }
  }, { signal });
}

/**
 * Rename in place, in the row itself - the same reasoning as the removal confirmation below it:
 * a modal would steal focus from the whole page to edit one word.
 *
 * Enter commits, Escape cancels, and losing focus commits too, because a click elsewhere after
 * typing a new name reads as "done", not as "discard what I just wrote". One AbortController owns
 * every listener, so closing by ANY of those routes drops them all - the bug the removal
 * confirmation documents in detail, and it applies here for exactly the same reason.
 */
function armRename(node, account) {
  // Not while a "¿quitar?" is on screen: that question owns the row, and answering it would
  // re-render this input out from under the user mid-word.
  if (openConfirm) return;
  const nameEl = $('.name', node);
  const input = $('.name-edit', node);
  if (!input.hidden) return;

  const ac = new AbortController();
  const { signal } = ac;
  let settled = false;

  const close = () => {
    if (settled) return;
    settled = true;
    input.hidden = true;
    nameEl.hidden = false;
    node.classList.remove('is-renaming');
    if (openConfirm === ac) openConfirm = null;
    ac.abort();
  };

  const commit = async () => {
    const label = input.value.trim();
    // Nothing typed, or nothing changed: closing quietly beats a toast saying nothing happened.
    if (!label || label === account.label) { close(); return; }
    close();
    try {
      await api(`/api/accounts/${account.id}`, { method: 'PATCH', body: { label } });
      await refresh(false);
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  input.value = account.label;
  nameEl.hidden = true;
  input.hidden = false;
  node.classList.add('is-renaming');
  // Same slot as the removal confirmation: it marks "this row has an inline interaction open",
  // which render() aborts before replacing the node, and which the hotkeys must not talk over.
  openConfirm = ac;
  input.focus();
  input.select();

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
  }, { signal });
  input.addEventListener('blur', commit, { signal });
}

async function doSwap(id, targetId, button) {
  if (swapping) return;
  swapping = true;
  $$('.btn-swap').forEach((b) => { b.disabled = true; });
  const row = button.closest('.row');
  row.classList.add('is-busy');
  button.classList.add('is-loading');

  try {
    const result = await api('/api/swap', { method: 'POST', body: { id, target: targetId } });
    toast(t('toast.swapped', { env: result.targetLabel || 'host', name: result.account.label }), 'ok');
    for (const w of result.warnings || []) toast(w);
    // The swap already fetched this account's usage to verify the token; the server
    // seeded its cache with it, so a plain refresh picks it up for free.
    await refresh(false);
  } catch (err) {
    toast(t('toast.swapFailed', { error: err.message }), 'err');
  } finally {
    // In the finally, not the catch: the swap can succeed and the refresh right after it
    // still fail (server stopped, machine suspended), and refresh() returns without
    // re-rendering. The row would then keep pointer-events:none and a spinning icon for
    // ever. On the success path this node is already detached, so it is a harmless no-op.
    row.classList.remove('is-busy');
    button.classList.remove('is-loading');
    swapping = false;
    $$('.btn-swap').forEach((b) => { b.disabled = false; });
  }
}

/**
 * Add an account from a pasted long-lived token. Returns whether it landed, so the caller can
 * decide about the form: on success it is emptied and closed, on failure the value stays put so
 * a mistyped NAME does not cost the user another trip to the terminal for the token.
 */
async function addByToken(token, label) {
  const buttons = [$('#btn-add-token'), $('#btn-add-token-empty')].filter(Boolean);
  buttons.forEach((b) => { b.disabled = true; b.classList.add('is-loading'); });
  try {
    const result = await api('/api/accounts/token', { method: 'POST', body: { token, label } });
    toast(t('toast.added', { name: result.account.label }), 'ok');
    for (const w of result.warnings || []) toast(w);
    await refresh(false);
    return true;
  } catch (err) {
    toast(err.message, 'err');
    return false;
  } finally {
    buttons.forEach((b) => { b.disabled = false; b.classList.remove('is-loading'); });
  }
}

/**
 * Pide al servidor que abra una terminal con `claude setup-token`.
 *
 * No intenta capturar el token: haria falta un pty, el flujo pasa por el navegador de todos modos,
 * y meter un secreto de un año a traves de nuestro proceso para ahorrar un Ctrl+V no sale a
 * cuenta. Lo que si hace es dejar el foco en el campo, que es donde va a acabar el pegado.
 */
async function getTokenInTerminal(button) {
  button.disabled = true;
  button.classList.add('is-loading');
  try {
    const r = await api('/api/token/terminal', { method: 'POST', body: {} });
    toast(t('token.opened', { how: r.how }), 'ok');
    tokenInput.focus();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    button.disabled = false;
    button.classList.remove('is-loading');
  }
}

async function importCurrent(configDir, targetId = 'host') {
  const buttons = [...$$('.btn-import-env'), $('#btn-import-empty')].filter(Boolean);
  buttons.forEach((b) => { b.disabled = true; b.classList.add('is-loading'); });
  try {
    const result = await api('/api/accounts/import', {
      method: 'POST', body: { target: targetId, ...(configDir ? { configDir } : {}) },
    });
    toast(t('toast.imported', { name: result.account.email || result.account.label }), 'ok');
    await refresh(false);
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    buttons.forEach((b) => { b.disabled = false; b.classList.remove('is-loading'); });
  }
}

/* ---------------- data ---------------- */

// Accounts that lost the race for the rate-limited slot come back as `throttled`, carrying
// the seconds until their turn. Waiting a whole poll interval for them would be silly, so
// ask again right after the floor lifts. One timer at a time, and never for a hard 429.
let queuedRetry = null;
function scheduleQueuedRetry() {
  // `throttled` is an account with no reading yet; `queued` one that has an old reading and
  // is waiting its turn behind the rate floor. Both need a re-poll once the floor lifts, or a
  // manual refresh would renew one account and leave the rest stale until the 5-min poll.
  const waits = Object.values(usageById)
    .filter((u) => u && (u.throttled || u.queued) && Number.isFinite(u.retryInS))
    .map((u) => u.retryInS);
  if (!waits.length) return;
  clearTimeout(queuedRetry);
  queuedRetry = setTimeout(() => { if (!swapping) refresh(false); }, (Math.min(...waits) + 2) * 1000);
}

async function refresh(force = false) {
  const btn = $('#btn-refresh');
  btn.disabled = true;
  btn.classList.add('is-loading');
  try {
    // Environments first: this drives one section each, with their per-environment active
    // account and running state. Falls back to host-only if the endpoint is unreachable.
    const res = await api('/api/targets').catch(() => null);
    targetList = (res && Array.isArray(res.targets) && res.targets.length)
      ? res.targets
      : [{ id: 'host', label: 'host', kind: 'host', activeId: null, running: false }];

    // The accounts are shared across environments; fetch them once. Each section marks its
    // own active from targetList, so the target of this call does not matter.
    const data = await api('/api/accounts?target=host');
    accounts = data.accounts;
    usageById = accounts.length ? await api(`/api/usage/all${force ? '?force=1' : ''}`) : {};
    lastFetch = Date.now();
    $('#banner-offline').hidden = true;
    scheduleQueuedRetry();

    render();
    reportEnvironment();
  } catch (err) {
    $('#banner-offline').hidden = false;
    envsEl.setAttribute('aria-busy', 'false');
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-loading');
  }
}

/**
 * Three things only the server can know, asked with every refresh (two stats and a flag, no
 * Anthropic call): whether it is running inside a container (where it cannot see host processes
 * or WSL distros), whether an environment variable outranks the credentials file, and whether a
 * bind-mounted ~/.claude.json has detached from the host's file. The second is the nastier one -
 * every swap then reports success and changes nothing that Claude Code will read - and it is
 * invisible from the panel unless it is said out loud. The third can flip while the tab is
 * open, which is why this is not asked once at boot.
 */
async function reportEnvironment() {
  let health;
  try { health = await api('/api/health'); } catch { return; }

  if (health.container) {
    $('#banner-container').hidden = false;
    if (health.build) $('#build-stamp').textContent = `build ${health.build}`;
  }
  $('#banner-stale').hidden = !health.staleMount;

  const vars = health.overridingEnv || [];
  if (vars.length) {
    $('#env-vars').textContent = vars.join(' y ');
    $('#banner-env').hidden = false;
  }
}

/* ---------------- boot ---------------- */

$('#btn-refresh').addEventListener('click', () => refresh(true));

for (const b of $$('#switch-lang button')) b.addEventListener('click', () => setLang(b.dataset.lang));
for (const b of $$('#switch-theme button')) b.addEventListener('click', () => setTheme(b.dataset.theme));
// El estado inicial lo fijo el script del <head> para no pintar el tema equivocado; aqui solo se
// refleja en los botones y se traduce lo estatico.
setTheme(document.documentElement.dataset.theme || 'dark');
for (const b of $$('#switch-lang button')) b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
applyI18n();

// Plain click imports the live session. Shift-click imports from an isolated login
// (CLAUDE_CONFIG_DIR=... claude /login), so another account can be captured without
// disturbing the one currently in use.
const dirForm = $('#dir-form');
const dirInput = $('#dir-input');

function openDirField() {
  // Symmetric with openTokenField. Without this the two inline forms stacked, and the pasted
  // token stayed on screen underneath a form that has nothing to do with it.
  closeTokenField({ focusBack: false });
  dirForm.hidden = false;
  dirInput.focus();
  dirInput.select();
}
function closeDirField() {
  dirForm.hidden = true; dirInput.value = '';
  const back = $('.btn-import-env') || $('#btn-import-empty');
  if (back) back.focus();
}

// The isolated-login dir is a host concept (CLAUDE_CONFIG_DIR=... claude /login).
dirForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const dir = dirInput.value.trim();
  if (!dir) { dirInput.focus(); return; }
  dirForm.hidden = true;
  await importCurrent(dir, 'host');
  dirInput.value = '';
});
$('#dir-cancel').addEventListener('click', closeDirField);
dirInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDirField(); });

/* ---------------- alta por token ---------------- */

const tokenForm = $('#token-form');
const tokenInput = $('#token-input');
const tokenLabelInput = $('#token-label');

function openTokenField() {
  closeTokenField({ focusBack: false }); // no-op if it was closed; clears any half-typed token
  dirForm.hidden = true;                 // one inline form at a time, or they stack and confuse
  tokenForm.hidden = false;
  tokenInput.focus();
}
// focusBack is refused when another field is about to take the focus itself: returning it to the
// toolbar button first would yank it back out from under the field the user just asked for.
function closeTokenField({ focusBack = true } = {}) {
  const wasOpen = !tokenForm.hidden;
  tokenForm.hidden = true;
  // A year-long credential should not outlive the form that carried it. Clearing on close means
  // it is gone from the DOM the moment the user is done, rather than sitting in a detached input
  // for as long as the tab stays open.
  tokenInput.value = '';
  tokenLabelInput.value = '';
  if (!focusBack || !wasOpen) return;
  const back = $('#btn-add-token') || $('#btn-add-token-empty');
  if (back) back.focus();
}

tokenForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = tokenInput.value.trim();
  if (!token) { tokenInput.focus(); return; }
  if (await addByToken(token, tokenLabelInput.value.trim())) closeTokenField();
  else tokenInput.focus();
});
$('#token-cancel').addEventListener('click', closeTokenField);
const btnGetToken = $('#btn-get-token');
btnGetToken.addEventListener('click', () => getTokenInTerminal(btnGetToken));
for (const el of [tokenInput, tokenLabelInput]) {
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTokenField(); });
}
$('#btn-add-token').addEventListener('click', openTokenField);
const emptyToken = $('#btn-add-token-empty');
if (emptyToken) emptyToken.addEventListener('click', openTokenField);

// The empty state only exists before any account, i.e. host.
const emptyImport = $('#btn-import-empty');
if (emptyImport) emptyImport.addEventListener('click', (e) => (e.shiftKey ? openDirField() : importCurrent(null, 'host')));

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  // Not while a "¿quitar?" is on screen: r would re-render the panel out from under the
  // question. And any editable target owns its own letters, not just <input>.
  if (openConfirm) return;
  if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
  if (e.key === 'r') refresh(true);
  if (e.key === 'i') importCurrent(null, 'host');
  if (e.key === 't') openTokenField();
});

// Countdowns tick locally; no API call involved.
setInterval(() => {
  for (const el of document.querySelectorAll('.resets[data-resets-at]')) {
    if (!el.dataset.resetsAt) continue;
    const base = countdown(el.dataset.resetsAt);
    const extra = el.dataset.extra;
    el.textContent = extra ? (base ? `${base} · ${extra}` : extra) : base;
  }
  $('#sync').textContent = syncLabel(lastFetch);
}, 1000);

setInterval(() => { if (!swapping) refresh(false); }, POLL_MS);

// Boot WITHOUT force: a page reload should reuse the server cache, not spend a fresh
// API call every time.
renderSkeletons();
refresh(false);

/* ---------------- fondo: campo de brasas de fosforo (firma) ----------------
   Particulas advectadas por un flow-field barato (suma de senos: sin tablas de ruido,
   sin librerias). Cada brasa nace, brilla y se apaga; al morir reaparece en otro punto.
   Se dibujan con un sprite radial pre-renderizado en modo aditivo, asi que donde se
   cruzan brillan mas (aire premium sin coste por-frame de createRadialGradient).
   Barato y respetuoso: ~30fps, dpr<=1.5, se congela en document.hidden (visibilitychange)
   y con prefers-reduced-motion pinta UN frame estatico y no arranca el bucle. */
(function emberField() {
  const canvas = document.getElementById('field');
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return;

  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const DPR = Math.min(1.5, window.devicePixelRatio || 1);
  const FRAME = 1000 / 30; // techo de ~30fps
  let w = 0, h = 0, particles = [], raf = 0, running = false, last = 0;

  // Sprite: un disco de fosforo con caida suave, pre-renderizado una sola vez.
  const sprite = (() => {
    const s = document.createElement('canvas');
    const size = 64; s.width = s.height = size;
    const c = s.getContext('2d');
    const g = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(150,255,210,1)');
    g.addColorStop(0.35, 'rgba(0,255,156,0.55)');
    g.addColorStop(1, 'rgba(0,255,156,0)');
    c.fillStyle = g; c.fillRect(0, 0, size, size);
    return s;
  })();

  function spawn() {
    const ttl = 6 + Math.random() * 10; // segundos de vida
    return {
      x: Math.random() * w,
      y: Math.random() * h,
      life: Math.random() * ttl, // arranca en un punto cualquiera de su vida: sin frames oscuros
      ttl,
      r: 5 + Math.random() * 12,  // radio de dibujo del sprite (px)
      speed: 6 + Math.random() * 16,
    };
  }

  function resize() {
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = Math.round(w * DPR);
    canvas.height = Math.round(h * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    // Densidad por area, con techo duro para que no se dispare en pantallas grandes.
    const target = Math.max(24, Math.min(110, Math.round((w * h) / 15000)));
    if (particles.length > target) particles.length = target;
    while (particles.length < target) particles.push(spawn());
  }

  // Campo de flujo: angulo suave por posicion + tiempo. Barato y sin bordes duros.
  function flowAngle(x, y, t) {
    return (Math.sin(x * 0.0016 + t * 0.15)
          + Math.cos(y * 0.0018 - t * 0.12)
          + Math.sin((x + y) * 0.001 + t * 0.10)) * 1.15;
  }

  function frame(dt, t) {
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter'; // aditivo: los cruces brillan mas
    for (const p of particles) {
      const a = flowAngle(p.x, p.y, t);
      p.x += Math.cos(a) * p.speed * dt;
      p.y += Math.sin(a) * p.speed * dt;
      p.life += dt;
      if (p.x < -30) p.x = w + 30; else if (p.x > w + 30) p.x = -30;
      if (p.y < -30) p.y = h + 30; else if (p.y > h + 30) p.y = -30;
      if (p.life >= p.ttl) Object.assign(p, spawn(), { life: 0 });
      // Brillo de brasa: sube y baja a lo largo de la vida (medio seno).
      const k = Math.sin((p.life / p.ttl) * Math.PI);
      ctx.globalAlpha = 0.06 + k * 0.42;
      const d = p.r * 2;
      ctx.drawImage(sprite, p.x - p.r, p.y - p.r, d, d);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function loop(ts) {
    raf = requestAnimationFrame(loop);
    const elapsed = ts - last;
    if (elapsed < FRAME) return; // throttle a ~30fps
    last = ts;
    frame(Math.min(0.05, elapsed / 1000), ts / 1000);
  }

  function start() {
    if (running || reduce) return;
    running = true; last = performance.now();
    raf = requestAnimationFrame(loop);
  }
  function stop() { running = false; cancelAnimationFrame(raf); }

  resize();
  frame(0, 0); // primer frame: campo visible al instante (y unico frame si reduce)

  let rt = 0;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { resize(); if (reduce || !running) frame(0, performance.now() / 1000); }, 150);
  });
  // Fuera de vista = no gastar: el bucle se para y se reanuda con la pestana.
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));

  start();
})();

