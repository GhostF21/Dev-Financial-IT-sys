// FinNova web app - customer-facing single-page app for every backend service.
// Talks only to the API Gateway (same origin). Hash routing: #/home, #/send, ...
//
//   Customer Service      -> sign-up, identity verification (KYC), profile
//   Identity Service      -> log in / log out, session, @username lookup
//   Account Service       -> bank accounts, FX rates
//   Payment Service       -> bank transfers, bank account statements
//   Wallet Service        -> wallets, add money, withdraw, send, exchange, QR pay, history
//   Ledger Service        -> double-entry ledger view
//   Notification Service  -> inbox

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));
const formData = (form) => Object.fromEntries(new FormData(form).entries());
const short = (id) => (id ? `${String(id).slice(0, 8)}…` : '');

const store = {
  get(key) { try { return JSON.parse(localStorage.getItem(`finnova.${key}`)); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(`finnova.${key}`, JSON.stringify(value)); } catch { /* private mode */ } },
  del(key) { try { localStorage.removeItem(`finnova.${key}`); } catch { /* private mode */ } },
};

// Currency badges (symbol in a coloured circle) - flag emoji do not render on Windows.
const SYMBOLS = { EUR: '€', USD: '$', GBP: '£', CHF: 'Fr', PLN: 'zł', HUF: 'Ft' };
const CURRENCY_NAMES = { EUR: 'Euro', USD: 'US Dollar', GBP: 'British Pound', CHF: 'Swiss Franc', PLN: 'Polish Złoty', HUF: 'Hungarian Forint' };
const flag = (cur) => `<span class="cur-badge cur-${esc(cur)}">${esc(SYMBOLS[cur] || cur?.[0] || '¤')}</span>`;

function money(amount, currency) {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${Number(amount).toFixed(2)} ${currency}`;
  }
}
const signed = (amount, currency, credit) => `${credit ? '+' : '−'}${money(Math.abs(amount), currency)}`;
const fmtDate = (d) => new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtDay = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const initials = (name) => String(name || '?').split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();

// ---------------------------------------------------------------------------
// Icons (inline SVG, stroke = currentColor)
// ---------------------------------------------------------------------------
const svg = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const I = {
  home: svg('<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'),
  wallet: svg('<rect x="3" y="6" width="18" height="14" rx="3"/><path d="M3 10h18M16 15h2"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  send: svg('<path d="M7 17 17 7M9 7h8v8"/>'),
  receive: svg('<path d="M17 7 7 17M15 17H7V9"/>'),
  exchange: svg('<path d="M4 8h13l-3-3M20 16H7l3 3"/>'),
  qr: svg('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h3v-3"/>'),
  history: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>'),
  bank: svg('<path d="M3 10 12 4l9 6M5 10v8M9 10v8M15 10v8M19 10v8M3 21h18"/>'),
  transfer: svg('<path d="M3 7h15M14 3l4 4-4 4M21 17H6M10 13l-4 4 4 4"/>'),
  ledger: svg('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h5"/>'),
  bell: svg('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10 21a2 2 0 0 0 4 0"/>'),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  card: svg('<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M2 10h20M6 15h4"/>'),
  check: svg('<path d="m5 12 5 5L20 7"/>'),
  x: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  shield: svg('<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>'),
  camera: svg('<path d="M4 7h3l2-3h6l2 3h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="4"/>'),
  upload: svg('<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>'),
  snow: svg('<path d="M12 2v20M4.9 4.9l14.2 14.2M2 12h20M4.9 19.1 19.1 4.9"/>'),
  logout: svg('<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l5-5-5-5M15 12H3"/>'),
  docs: svg('<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/>'),
};

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------
class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

async function api(method, path, body, { auth = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && state.token) headers.Authorization = `Bearer ${state.token}`;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach FinNova. Check your connection.');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.code || 'ERROR', data.message || `Request failed (${res.status})`);
  return data;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  token: store.get('token'),
  user: null,       // identity user {id, customerId, username}
  customer: null,   // customer profile
  expiresAt: null,
  wallets: [],
  accounts: [],
  rates: null,      // { EUR: 1, USD: 1.08, ... } units per 1 EUR
};

async function loadRates() {
  if (!state.rates) state.rates = (await api('GET', '/fx/rates')).rates;
  return state.rates;
}
const currencies = () => Object.keys(state.rates || SYMBOLS);
function convert(amount, from, to) {
  if (from === to || !state.rates) return amount;
  return Math.round(amount * (state.rates[to] / state.rates[from]) * 100) / 100;
}

async function loadSession() {
  if (!state.token) return false;
  try {
    const me = await api('GET', '/auth/me', undefined, { auth: true });
    state.user = me.user;
    state.expiresAt = me.expiresAt;
    state.customer = await api('GET', `/customers/${me.user.customerId}`);
    return true;
  } catch (err) {
    if (err.status === 401 || err.status === 404) { signOutLocal(); return false; }
    throw err;
  }
}

async function refreshMoney() {
  if (!state.customer) return;
  const id = state.customer.id;
  [state.wallets, state.accounts] = await Promise.all([
    api('GET', `/wallets?customerId=${id}`),
    api('GET', `/accounts?customerId=${id}`),
  ]);
}

function signOutLocal() {
  state.token = null; state.user = null; state.customer = null; state.wallets = []; state.accounts = [];
  store.del('token');
}

const walletById = (id) => state.wallets.find((w) => w.id === id);
const fullName = (c) => (c ? `${c.firstName} ${c.lastName}` : '');

// Who owns a wallet / account (for "Sent to Anna Kovács"). Cached per id.
const ownerCache = new Map();
function walletOwner(walletId) {
  const own = walletById(walletId);
  if (own) return Promise.resolve(`your ${own.currency} wallet`);
  if (!ownerCache.has(walletId)) {
    ownerCache.set(walletId, api('GET', `/wallets/${walletId}`)
      .then((w) => api('GET', `/customers/${w.customerId}`))
      .then(fullName)
      .catch(() => `wallet ${short(walletId)}`));
  }
  return ownerCache.get(walletId);
}
function customerName(customerId) {
  const key = `c:${customerId}`;
  if (!ownerCache.has(key)) ownerCache.set(key, api('GET', `/customers/${customerId}`).then(fullName).catch(() => 'FinNova customer'));
  return ownerCache.get(key);
}
// Fill <span data-wallet-owner="id"> placeholders once names are known.
function fillOwners(root) {
  $$('[data-wallet-owner]', root).forEach(async (el) => { el.textContent = await walletOwner(el.dataset.walletOwner); });
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
function toast(message) {
  const t = $('#toast');
  t.textContent = message;
  t.classList.add('show');
  clearTimeout(t.timer);
  t.timer = setTimeout(() => t.classList.remove('show'), 3200);
}

function notice(el, kind, html) {
  if (!el) return;
  el.className = `notice ${kind}`;
  el.innerHTML = html;
}

// Runs an async action with the button disabled; errors go to the notice element (or a toast).
async function busy(button, noticeEl, fn) {
  if (button) button.disabled = true;
  if (noticeEl) noticeEl.className = 'hidden';
  try {
    await fn();
  } catch (err) {
    console.error(err);
    const msg = esc(err.message || 'Something went wrong');
    if (noticeEl) notice(noticeEl, 'bad', msg); else toast(err.message);
  } finally {
    if (button) button.disabled = false;
  }
}

function statusPill(status) {
  const kind = {
    ACTIVE: 'ok', APPROVED: 'ok', PAID: 'ok', COMPLETED: 'ok', SUCCEEDED: 'ok', DELIVERED: 'ok',
    PENDING: 'warn', PROCESSING: 'warn', FROZEN: 'info', REJECTED: 'bad', FAILED: 'bad', EXPIRED: 'bad', CANCELLED: '',
  }[status] ?? '';
  return `<span class="pill ${kind}">${esc(status)}</span>`;
}

const emptyState = (icon, text) => `<div class="empty">${icon}${esc(text)}</div>`;

function walletOptions(selectedId, { exclude } = {}) {
  return state.wallets.filter((w) => w.id !== exclude).map((w) => `<option value="${w.id}" ${w.id === selectedId ? 'selected' : ''}>${w.currency} wallet · ${money(w.balance, w.currency)}${w.status !== 'ACTIVE' ? ' (frozen)' : ''}</option>`).join('');
}
function accountOptions(selectedId) {
  return state.accounts.map((a) => `<option value="${a.id}" ${a.id === selectedId ? 'selected' : ''}>${a.currency} ${a.accountType === 'SAVINGS' ? 'Savings' : 'Current'} ${a.accountNumber} · ${money(a.balance, a.currency)}</option>`).join('');
}
const currencyOptions = (selected, skip = []) => currencies().filter((c) => !skip.includes(c))
  .map((c) => `<option value="${c}" ${c === selected ? 'selected' : ''}>${SYMBOLS[c] || ''} ${c} · ${CURRENCY_NAMES[c] || c}</option>`).join('');

function openModal(html, bind) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => back.remove();
  back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('[data-close]')) close(); });
  document.body.append(back);
  bind?.(back, close);
  return close;
}

// Cleanup hooks (camera, polling) that run when the user leaves a page.
let leaveHooks = [];
const onLeave = (fn) => leaveHooks.push(fn);

// ---------------------------------------------------------------------------
// Wallet transaction presentation
// ---------------------------------------------------------------------------
function describeWalletTx(tx) {
  const credit = tx.direction === 'CREDIT';
  const owner = tx.counterpartyWalletId ? `<span data-wallet-owner="${tx.counterpartyWalletId}">…</span>` : '';
  const map = {
    TOP_UP: ['Money added', tx.paymentMethod === 'CARD' ? I.card : I.bank, 'green'],
    WITHDRAWAL: ['Withdrawal to bank', I.bank, ''],
    REVERSAL: ['Withdrawal reversed', I.history, 'amber'],
    P2P_SENT: [`To ${owner}`, I.send, ''],
    P2P_RECEIVED: [`From ${owner}`, I.receive, 'green'],
    QR_PAYMENT_SENT: [`QR payment to ${owner}`, I.qr, ''],
    QR_PAYMENT_RECEIVED: [`QR payment from ${owner}`, I.qr, 'green'],
  };
  const [title, icon, tone] = map[tx.type] || [tx.type, I.wallet, ''];
  return { title, icon, tone, credit };
}

function walletTxRow(tx, { showWallet = false } = {}) {
  const d = describeWalletTx(tx);
  const w = walletById(tx.walletId);
  return `<div class="row-item clickable" data-tx="${esc(JSON.stringify(tx))}">
    <div class="avatar ${d.tone}">${d.icon}</div>
    <div class="grow"><div class="title">${d.title}</div>
      <div class="sub">${fmtDate(tx.timestamp)}${tx.description ? ` · ${esc(tx.description)}` : ''}</div></div>
    <div class="amount"><div class="${d.credit ? 'pos' : 'neg'}">${signed(tx.amount, tx.currency, d.credit)}</div>
      <div class="sub">${showWallet && w ? `${flag(w.currency)} ${w.currency}` : money(tx.balanceAfter, tx.currency)}</div></div>
  </div>`;
}

function bindTxRows(root) {
  fillOwners(root);
  $$('[data-tx]', root).forEach((row) => row.addEventListener('click', () => {
    const tx = JSON.parse(row.dataset.tx);
    const d = describeWalletTx(tx);
    openModal(`
      <div class="card-head"><h2>${d.credit ? 'Incoming' : 'Outgoing'}</h2><button class="btn ghost sm" data-close>${I.x}</button></div>
      <div style="text-align:center"><div class="avatar ${d.tone}" style="margin:0 auto 10px;width:56px;height:56px">${d.icon}</div>
        <h1 class="${d.credit ? 'pos' : ''}">${signed(tx.amount, tx.currency, d.credit)}</h1>
        <div class="muted">${d.title}</div></div>
      <dl class="kv">
        <dt>Date</dt><dd>${fmtDate(tx.timestamp)}</dd>
        <dt>Type</dt><dd>${esc(tx.type)}</dd>
        ${tx.description ? `<dt>Note</dt><dd>${esc(tx.description)}</dd>` : ''}
        ${tx.paymentMethod ? `<dt>Method</dt><dd>${esc(tx.paymentMethod)}</dd>` : ''}
        <dt>Balance after</dt><dd>${money(tx.balanceAfter, tx.currency)}</dd>
        <dt>Transaction ID</dt><dd class="mono">${esc(tx.id)}</dd>
        ${tx.referenceId ? `<dt>Reference</dt><dd class="mono">${esc(tx.referenceId)}</dd>` : ''}
      </dl>`, fillOwners);
  }));
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------
const NAV = [
  ['/home', 'Home', I.home],
  ['/wallets', 'Wallets', I.wallet],
  ['/add-money', 'Add money', I.plus],
  ['/send', 'Send', I.send],
  ['/exchange', 'Exchange', I.exchange],
  ['/qr', 'QR pay', I.qr],
  ['/history', 'Transactions', I.history],
  null,
  ['/accounts', 'Bank accounts', I.bank],
  ['/transfer', 'Bank transfer', I.transfer],
  ['/ledger', 'Ledger', I.ledger],
  ['/inbox', 'Inbox', I.bell],
  ['/profile', 'Profile', I.user],
];
const TABS = [['/home', 'Home', I.home], ['/send', 'Send', I.send], ['/qr', 'QR pay', I.qr], ['/history', 'History', I.history], ['/profile', 'Profile', I.user]];

function renderShell(active) {
  const isActive = (p) => p === active || (p === '/accounts' && active === '/account');
  $('#app').innerHTML = `
    <div class="shell">
      <nav class="sidebar" aria-label="Main">
        <a class="brand" href="#/home"><span class="brand-mark">F</span>FinNova</a>
        ${NAV.map((n) => (n ? `<a class="nav-item ${isActive(n[0]) ? 'active' : ''}" href="#${n[0]}">${n[2]}${n[1]}</a>` : '<div class="nav-sep"></div>')).join('')}
        <div class="nav-foot">Signed in as <b>@${esc(state.user?.username)}</b></div>
      </nav>
      <main class="main"><div class="page" id="view"><div class="spinner"></div></div></main>
      <nav class="tabbar" aria-label="Tabs">
        ${TABS.map((t) => `<a href="#${t[0]}" class="${isActive(t[0]) ? 'active' : ''}">${t[2]}<span>${t[1]}</span></a>`).join('')}
      </nav>
    </div>`;
  return $('#view');
}

function renderAuthShell() {
  $('#app').innerHTML = '<div class="auth"><div class="auth-card" id="view"></div></div>';
  return $('#view');
}

const kycApproved = () => state.customer?.kycStatus === 'APPROVED';
const kycBanner = () => (kycApproved() ? '' : `
  <div class="notice warn">${I.shield.replace('<svg', '<svg style="width:18px;height:18px;vertical-align:-4px"')} Your identity is not verified yet
  (${esc(state.customer?.kycStatus)}). Wallets and accounts need a verified identity. <a href="#/profile">Verify now</a></div>`);

// ---------------------------------------------------------------------------
// Pages: welcome, log in, sign up
// ---------------------------------------------------------------------------
function pageWelcome(view) {
  view.innerHTML = `
    <div class="brand"><span class="brand-mark">F</span>FinNova</div>
    <div class="welcome-hero">
      <h1>Money, made simple.</h1>
      <div style="opacity:.9">Multi-currency wallets, instant transfers, QR payments and bank accounts in one app.</div>
    </div>
    <a class="btn block" href="#/signup">Create an account</a>
    <a class="btn block ghost" href="#/login">Log in</a>
    <p class="small muted" style="text-align:center">Demo bank for a university project. No real money moves.
      <a href="/docs/">API docs</a></p>`;
}

function pageLogin(view) {
  view.innerHTML = `
    <div class="brand"><span class="brand-mark">F</span>FinNova</div>
    <div class="card">
      <h2 style="margin-bottom:4px">Welcome back</h2>
      <p class="muted small" style="margin-top:0">Log in with your FinNova username.</p>
      <form id="login">
        <label class="field"><span>Username</span><input name="username" autocomplete="username" required autofocus /></label>
        <label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required /></label>
        <div id="msg" class="hidden"></div>
        <button class="btn block">Log in</button>
      </form>
    </div>
    <p class="small muted" style="text-align:center">New to FinNova? <a href="#/signup">Create an account</a></p>`;
  $('#login').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, $('#msg'), async () => {
      const { username, password } = formData(e.target);
      await logIn(username.trim(), password);
      store.del('signup');
      location.hash = '#/home';
    });
  });
}

async function logIn(username, password) {
  const res = await api('POST', '/auth/login', { username, password });
  state.token = res.accessToken;
  store.set('token', res.accessToken);
  await loadSession();
}

// Sign-up: 1 details (Customer) -> 2 verify identity (KYC) -> 3 login (Identity) -> 4 wallet & account
function pageSignup(view) {
  const flow = store.get('signup') || { step: 1 };
  const save = () => store.set('signup', flow);
  const stepBar = `<div class="steps">${[1, 2, 3, 4].map((s) => `<span class="${s <= flow.step ? 'done' : ''}"></span>`).join('')}</div>`;
  const head = (title, sub) => `<div class="brand"><span class="brand-mark">F</span>FinNova</div>${stepBar}
    <div><h2>${title}</h2><p class="muted small" style="margin:4px 0 0">${sub}</p></div>`;
  const startOver = () => {
    $('#over', view)?.addEventListener('click', (e) => { e.preventDefault(); store.del('signup'); signOutLocal(); location.hash = '#/welcome'; });
  };
  const overLink = '<p class="small muted" style="text-align:center"><a href="#" id="over">Cancel and start over</a></p>';

  if (flow.step === 1) {
    view.innerHTML = `${head('Tell us about you', 'Step 1 of 4 · Personal details')}
      <form class="card" id="f">
        <div class="grid2">
          <label class="field"><span>First name</span><input name="firstName" required autofocus /></label>
          <label class="field"><span>Last name</span><input name="lastName" required /></label>
        </div>
        <label class="field"><span>Email</span><input name="email" type="email" required /></label>
        <div class="grid2">
          <label class="field"><span>Phone</span><input name="phone" type="tel" placeholder="+36 30 123 4567" /></label>
          <label class="field"><span>Date of birth</span><input name="dateOfBirth" type="date" required max="${new Date().toISOString().slice(0, 10)}" /></label>
        </div>
        <label class="field"><span>Street</span><input name="street" /></label>
        <div class="grid3">
          <label class="field"><span>City</span><input name="city" /></label>
          <label class="field"><span>Postcode</span><input name="postalCode" /></label>
          <label class="field"><span>Country</span><input name="country" maxlength="2" placeholder="HU" /></label>
        </div>
        <div id="msg" class="hidden"></div>
        <button class="btn block">Continue</button>
      </form>
      <p class="small muted" style="text-align:center">Already have an account? <a href="#/login">Log in</a></p>`;
    $('#f').addEventListener('submit', (e) => {
      e.preventDefault();
      busy(e.submitter, $('#msg'), async () => {
        const f = formData(e.target);
        const customer = await api('POST', '/customers', {
          firstName: f.firstName.trim(), lastName: f.lastName.trim(), email: f.email.trim(), phone: f.phone || undefined,
          dateOfBirth: f.dateOfBirth,
          address: { street: f.street, city: f.city, postalCode: f.postalCode, country: f.country.toUpperCase() },
        });
        Object.assign(flow, { step: 2, customerId: customer.id, firstName: customer.firstName });
        save(); render();
      });
    });
    return;
  }

  if (flow.step === 2) {
    view.innerHTML = `${head(`Verify your identity, ${esc(flow.firstName)}`, 'Step 2 of 4 · Required by financial regulation (KYC)')}
      <form class="card" id="f">
        <label class="field"><span>Document</span><select name="documentType">
          <option value="PASSPORT">Passport</option><option value="ID_CARD">National ID card</option><option value="DRIVING_LICENCE">Driving licence</option>
        </select></label>
        <label class="field"><span>Photo of your document</span><input type="file" accept="image/*" /></label>
        <div class="notice info small">Demo: verification is simulated. Choose the outcome to test both paths.</div>
        <div id="msg" class="hidden"></div>
        <div class="actions"><button class="btn" value="APPROVED">${I.check} Verify me</button>
          <button class="btn ghost" value="REJECTED">Simulate rejection</button></div>
      </form>${overLink}`;
    startOver();
    $('#f').addEventListener('submit', (e) => {
      e.preventDefault();
      busy(e.submitter, $('#msg'), async () => {
        const result = e.submitter.value;
        await api('POST', `/customers/${flow.customerId}/kyc`, { documentType: formData(e.target).documentType, result });
        if (result === 'REJECTED') {
          notice($('#msg'), 'bad', 'Verification rejected. You can try again with another document.');
          return;
        }
        flow.step = 3; save(); render();
      });
    });
    return;
  }

  if (flow.step === 3) {
    view.innerHTML = `${head('Secure your account', 'Step 3 of 4 · Your login (others can send you money to @username)')}
      <form class="card" id="f">
        <label class="field"><span>Username</span><input name="username" required pattern="[A-Za-z0-9._-]{3,30}" autocomplete="username" autofocus /></label>
        <label class="field"><span>Password (min. 8 characters)</span><input name="password" type="password" minlength="8" required autocomplete="new-password" /></label>
        <div id="msg" class="hidden"></div>
        <button class="btn block">Create login</button>
      </form>${overLink}`;
    startOver();
    $('#f').addEventListener('submit', (e) => {
      e.preventDefault();
      busy(e.submitter, $('#msg'), async () => {
        const { username, password } = formData(e.target);
        await api('POST', '/auth/register', { customerId: flow.customerId, username: username.trim(), password });
        await logIn(username.trim(), password);
        flow.step = 4; save(); render();
      });
    });
    return;
  }

  view.innerHTML = `${head('Set up your money', 'Step 4 of 4 · Wallet and bank account')}
    <form class="card" id="f">
      <label class="field"><span>Main currency</span><select name="currency">${currencyOptions('EUR')}</select></label>
      <label class="field" style="grid-template-columns:auto 1fr;align-items:center"><input type="checkbox" name="openAccount" checked style="width:auto" />
        <span>Also open a current account with a demo deposit</span></label>
      <label class="field"><span>Demo deposit</span><input name="deposit" type="number" min="0" step="0.01" value="1000" /></label>
      <div id="msg" class="hidden"></div>
      <button class="btn block">Finish</button>
    </form>`;
  $('#f').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, $('#msg'), async () => {
      const f = formData(e.target);
      await api('POST', '/wallets', { customerId: flow.customerId, currency: f.currency }).catch((err) => { if (err.code !== 'WALLET_EXISTS') throw err; });
      if (f.openAccount) {
        await api('POST', '/accounts', { customerId: flow.customerId, accountType: 'CHECKING', currency: f.currency, initialDeposit: Number(f.deposit || 0) });
      }
      store.del('signup');
      toast('Welcome to FinNova!');
      location.hash = '#/home';
    });
  });
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------
async function pageHome(view) {
  const display = store.get('displayCurrency') || state.wallets[0]?.currency || 'EUR';
  const total = state.wallets.reduce((sum, w) => sum + convert(w.balance, w.currency, display), 0);
  const [whole, cents] = money(total, display).split(/(?=[.,]\d{2}$)/);

  view.innerHTML = `
    <div class="page-head"><div><div class="muted small">Good ${new Date().getHours() < 12 ? 'morning' : 'day'},</div><h1>${esc(state.customer.firstName)}</h1></div>
      <a class="avatar blue" href="#/profile" title="Profile">${initials(fullName(state.customer))}</a></div>
    ${kycBanner()}
    <section class="hero">
      <div class="label">Total balance · ${display}</div>
      <div class="balance">${esc(whole)}<span class="cents">${esc(cents || '')}</span></div>
      <div class="chips">
        ${state.wallets.map((w) => `<button class="chip ${w.currency === display ? 'active' : ''}" data-cur="${w.currency}">${flag(w.currency)} ${money(w.balance, w.currency)}</button>`).join('')
          || '<a class="chip" href="#/wallets">+ Open a wallet</a>'}
      </div>
    </section>
    <div class="quick">
      <a href="#/add-money"><span class="circle">${I.plus}</span>Add money</a>
      <a href="#/send"><span class="circle">${I.send}</span>Send</a>
      <a href="#/exchange"><span class="circle">${I.exchange}</span>Exchange</a>
      <a href="#/qr"><span class="circle">${I.qr}</span>QR pay</a>
      <a href="#/transfer"><span class="circle">${I.bank}</span>Transfer</a>
    </div>
    <section class="card"><div class="card-head"><h3>Recent activity</h3><a href="#/history" class="small">See all</a></div>
      <div class="list" id="recent"><div class="spinner"></div></div></section>
    <section class="card"><div class="card-head"><h3>Bank accounts</h3><a href="#/accounts" class="small">Manage</a></div>
      <div class="list">${state.accounts.map((a) => `
        <a class="row-item clickable" href="#/account?id=${a.id}" style="color:inherit">
          <div class="avatar blue">${I.bank}</div>
          <div class="grow"><div class="title">${a.accountType === 'SAVINGS' ? 'Savings' : 'Current'} account · ${a.currency}</div><div class="sub mono">${esc(a.accountNumber)}</div></div>
          <div class="amount">${money(a.balance, a.currency)}</div></a>`).join('') || emptyState(I.bank, 'No bank accounts yet')}</div></section>`;

  $$('.chip[data-cur]', view).forEach((c) => c.addEventListener('click', () => { store.set('displayCurrency', c.dataset.cur); render(); }));

  const pages = await Promise.all(state.wallets.map((w) => api('GET', `/wallets/${w.id}/transactions?pageSize=6`).then((r) => r.data).catch(() => [])));
  const recent = pages.flat().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 6);
  const el = $('#recent', view);
  if (!el) return;
  el.innerHTML = recent.map((tx) => walletTxRow(tx, { showWallet: state.wallets.length > 1 })).join('') || emptyState(I.history, 'No transactions yet - add money to get started');
  bindTxRows(el);
}

// ---------------------------------------------------------------------------
// Wallets
// ---------------------------------------------------------------------------
function pageWallets(view) {
  const missing = currencies().filter((c) => !state.wallets.some((w) => w.currency === c));
  view.innerHTML = `
    <div class="page-head"><h1>Wallets</h1></div>
    ${kycBanner()}
    <div class="wallet-strip">${state.wallets.map((w) => `
      <div class="wallet-tile">
        <div class="cur"><span class="flag">${flag(w.currency)}</span>${w.currency} ${w.status !== 'ACTIVE' ? statusPill(w.status) : ''}</div>
        <div class="bal">${money(w.balance, w.currency)}</div>
        <div class="muted small">${CURRENCY_NAMES[w.currency] || ''}</div>
        <div class="actions" style="margin-top:6px">
          <a class="btn sm soft" href="#/add-money?wallet=${w.id}">${I.plus}Add</a>
          <button class="btn sm ghost" data-withdraw="${w.id}">${I.bank}Withdraw</button>
          <a class="btn sm ghost" href="#/history?wallet=${w.id}">${I.history}</a>
          <button class="btn sm ghost" data-freeze="${w.id}" title="${w.status === 'ACTIVE' ? 'Freeze' : 'Unfreeze'}">${w.status === 'ACTIVE' ? I.snow : I.check}</button>
        </div>
      </div>`).join('') || `<div class="card">${emptyState(I.wallet, 'You have no wallets yet')}</div>`}</div>
    ${missing.length ? `
    <form class="card" id="open">
      <h3>Open a new wallet</h3>
      <p class="muted small" style="margin:0">Hold and spend in ${missing.length} more currencies. Transfers between currencies convert automatically.</p>
      <div class="grid2"><select name="currency">${currencyOptions(missing[0], currencies().filter((c) => !missing.includes(c)))}</select>
        <button class="btn">Open wallet</button></div>
      <div id="msg" class="hidden"></div>
    </form>` : ''}`;

  $('#open', view)?.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, $('#msg'), async () => {
      const w = await api('POST', '/wallets', { customerId: state.customer.id, currency: formData(e.target).currency });
      toast(`${w.currency} wallet opened`);
      await refreshMoney(); render();
    });
  });
  $$('[data-freeze]', view).forEach((b) => b.addEventListener('click', () => busy(b, null, async () => {
    const w = walletById(b.dataset.freeze);
    await api('PATCH', `/wallets/${w.id}`, { status: w.status === 'ACTIVE' ? 'FROZEN' : 'ACTIVE' });
    toast(w.status === 'ACTIVE' ? `${w.currency} wallet frozen` : `${w.currency} wallet unfrozen`);
    await refreshMoney(); render();
  })));
  $$('[data-withdraw]', view).forEach((b) => b.addEventListener('click', () => withdrawModal(walletById(b.dataset.withdraw))));
}

function withdrawModal(wallet) {
  if (!state.accounts.length) { toast('Open a bank account first'); location.hash = '#/accounts'; return; }
  openModal(`
    <div class="card-head"><h2>Withdraw ${flag(wallet.currency)} ${wallet.currency}</h2><button class="btn ghost sm" data-close>${I.x}</button></div>
    <form id="wd">
      <div class="amount-input"><input name="amount" type="number" min="0.01" step="0.01" placeholder="0" required /><span class="cur-label">${wallet.currency}</span></div>
      <div class="muted small">Available ${money(wallet.balance, wallet.currency)}</div>
      <label class="field"><span>To bank account</span><select name="bankAccountId">${accountOptions()}</select></label>
      <div class="quote" id="q"></div>
      <div id="msg" class="hidden"></div>
      <button class="btn block">Withdraw</button>
    </form>`, (root, close) => {
    const form = $('#wd', root);
    const update = () => {
      const f = formData(form);
      const acc = state.accounts.find((a) => a.id === f.bankAccountId);
      const amount = Number(f.amount || 0);
      $('#q', root).innerHTML = acc && acc.currency !== wallet.currency && amount > 0
        ? `<span>Arrives in account</span><b>${money(convert(amount, wallet.currency, acc.currency), acc.currency)}</b>` : '';
    };
    form.addEventListener('input', update);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(e.submitter, $('#msg', root), async () => {
        const f = formData(form);
        await api('POST', `/wallets/${wallet.id}/withdraw`, { amount: Number(f.amount), bankAccountId: f.bankAccountId, idempotencyKey: uuid() });
        close(); toast('Withdrawal completed');
        await refreshMoney(); render();
      });
    });
  });
}

function needWallet(view) {
  if (state.wallets.length) return false;
  view.innerHTML = `${kycBanner()}<div class="card">${emptyState(I.wallet, 'Open a wallet first')}<div style="text-align:center"><a class="btn" href="#/wallets">Open a wallet</a></div></div>`;
  return true;
}

// ---------------------------------------------------------------------------
// Add money (card or bank account -> wallet, via the Wallet Service payment gateway)
// ---------------------------------------------------------------------------
const TEST_CARDS = [
  ['4242 4242 4242 4242', 'Visa · approved'],
  ['5555 5555 5555 4444', 'Mastercard · approved'],
  ['4000 0000 0000 0002', 'Declined'],
  ['4000 0000 0000 9995', 'Insufficient funds'],
];

function pageAddMoney(view, params) {
  if (needWallet(view)) return;
  let method = 'CARD';
  view.innerHTML = `
    <div class="page-head"><h1>Add money</h1></div>
    <form class="card" id="f">
      <label class="field"><span>To wallet</span><select name="walletId">${walletOptions(params.wallet)}</select></label>
      <div class="amount-input"><input name="amount" type="number" min="0.01" step="0.01" placeholder="0" required autofocus /><span class="cur-label" id="cur"></span></div>
      <div class="seg" id="method"><button type="button" class="active" data-m="CARD">${I.card} Card</button><button type="button" data-m="BANK_ACCOUNT">${I.bank} Bank account</button></div>
      <div id="card-fields">
        <label class="field"><span>Card number</span><input name="number" inputmode="numeric" autocomplete="cc-number" placeholder="4242 4242 4242 4242" /></label>
        <div class="grid2" style="margin-top:12px">
          <label class="field"><span>Expiry (MM/YY)</span><input name="expiry" placeholder="12/29" autocomplete="cc-exp" /></label>
          <label class="field"><span>CVC</span><input name="cvc" inputmode="numeric" placeholder="123" autocomplete="cc-csc" /></label>
        </div>
        <div class="small muted" style="margin-top:10px">Sandbox test cards:
          ${TEST_CARDS.map(([n, label]) => `<button type="button" class="pill" data-card="${n}" style="border:0;cursor:pointer;margin:2px">${n.slice(-4)} · ${label}</button>`).join('')}</div>
      </div>
      <div id="bank-fields" class="hidden">
        ${state.accounts.length ? `<label class="field"><span>From bank account</span><select name="bankAccountId">${accountOptions()}</select></label>`
          : `<div class="notice">No bank account yet. <a href="#/accounts">Open one</a> to top up from it.</div>`}
      </div>
      <div class="quote" id="q"></div>
      <div id="msg" class="hidden"></div>
      <button class="btn block">Add money</button>
    </form>`;

  const form = $('#f', view);
  const update = () => {
    const f = formData(form);
    const w = walletById(f.walletId);
    $('#cur', view).textContent = w.currency;
    const acc = state.accounts.find((a) => a.id === f.bankAccountId);
    const amount = Number(f.amount || 0);
    $('#q', view).innerHTML = method === 'BANK_ACCOUNT' && acc && acc.currency !== w.currency && amount > 0
      ? `<span>${flag(acc.currency)} Debited from account (rate 1 ${w.currency} = ${convert(1, w.currency, acc.currency)} ${acc.currency})</span><b>${money(convert(amount, w.currency, acc.currency), acc.currency)}</b>` : '';
  };
  update();
  form.addEventListener('input', update);
  $$('#method button', view).forEach((b) => b.addEventListener('click', () => {
    method = b.dataset.m;
    $$('#method button', view).forEach((x) => x.classList.toggle('active', x === b));
    $('#card-fields', view).classList.toggle('hidden', method !== 'CARD');
    $('#bank-fields', view).classList.toggle('hidden', method !== 'BANK_ACCOUNT');
    update();
  }));
  $$('[data-card]', view).forEach((b) => b.addEventListener('click', () => {
    form.number.value = b.dataset.card; form.expiry.value = '12/29'; form.cvc.value = '123';
  }));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, $('#msg', view), async () => {
      const f = formData(form);
      const body = { amount: Number(f.amount), method, idempotencyKey: uuid() };
      if (method === 'CARD') {
        const [mm, yy] = String(f.expiry).split('/');
        body.card = { number: f.number, expiryMonth: Number(mm), expiryYear: Number(yy), cvc: f.cvc };
      } else {
        if (!f.bankAccountId) throw new Error('Choose a bank account');
        body.bankAccountId = f.bankAccountId;
      }
      const res = await api('POST', `/wallets/${f.walletId}/top-up`, body);
      await refreshMoney();
      notice($('#msg', view), 'ok', `${I.check.replace('<svg', '<svg style="width:16px;height:16px;vertical-align:-3px"')} Added ${money(body.amount, res.wallet.currency)}. New balance ${money(res.wallet.balance, res.wallet.currency)}.`);
      form.amount.value = '';
      form.walletId.innerHTML = walletOptions(f.walletId);
      if (f.bankAccountId) form.bankAccountId.innerHTML = accountOptions(f.bankAccountId);
      update();
    });
  });
}

// ---------------------------------------------------------------------------
// Send to another FinNova user (wallet P2P, converts currencies automatically)
// ---------------------------------------------------------------------------
function pageSend(view, params) {
  if (needWallet(view)) return;
  let recipient = null; // { username, customerId, name, wallets }
  view.innerHTML = `
    <div class="page-head"><h1>Send</h1></div>
    <form class="card" id="find">
      <h3>Who are you sending to?</h3>
      <div class="grid2"><input name="username" placeholder="@username" value="${esc(params.to || '')}" required /><button class="btn ghost">Find</button></div>
      <div id="who"></div>
    </form>
    <form class="card hidden" id="f">
      <label class="field"><span>From</span><select name="fromWalletId">${walletOptions()}</select></label>
      <div class="amount-input"><input name="amount" type="number" min="0.01" step="0.01" placeholder="0" required /><span class="cur-label" id="cur"></span></div>
      <label class="field"><span>Into their wallet</span><select name="toWalletId" id="to"></select></label>
      <div class="quote" id="q"></div>
      <label class="field"><span>Note (optional)</span><input name="description" maxlength="255" placeholder="Dinner 🍕" /></label>
      <div id="msg" class="hidden"></div>
      <button class="btn block">${I.send} Send</button>
    </form>`;

  const form = $('#f', view);
  const update = () => {
    const f = formData(form);
    const from = walletById(f.fromWalletId);
    $('#cur', view).textContent = from.currency;
    const to = recipient?.wallets.find((w) => w.id === f.toWalletId);
    const amount = Number(f.amount || 0);
    $('#q', view).innerHTML = to && amount > 0
      ? (to.currency === from.currency ? `<span>They receive</span><b>${money(amount, to.currency)}</b>`
        : `<span>They receive (1 ${from.currency} = ${convert(1, from.currency, to.currency)} ${to.currency})</span><b>${money(convert(amount, from.currency, to.currency), to.currency)}</b>`)
      : '';
  };
  form.addEventListener('input', update);

  $('#find', view).addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, null, async () => {
      const username = formData(e.target).username.trim().replace(/^@/, '');
      const who = $('#who', view);
      try {
        const user = await api('GET', `/auth/users/${encodeURIComponent(username)}`);
        const [name, wallets] = await Promise.all([customerName(user.customerId), api('GET', `/wallets?customerId=${user.customerId}`)]);
        recipient = { ...user, name, wallets: wallets.filter((w) => w.status === 'ACTIVE') };
      } catch (err) {
        recipient = null;
        form.classList.add('hidden');
        who.innerHTML = `<div class="notice bad" style="margin-top:12px">${esc(err.status === 404 ? `No FinNova user @${username}` : err.message)}</div>`;
        return;
      }
      who.innerHTML = `<div class="row-item" style="margin-top:8px"><div class="avatar blue">${initials(recipient.name)}</div>
        <div class="grow"><div class="title">${esc(recipient.name)}</div><div class="sub">@${esc(recipient.username)}</div></div></div>`;
      if (!recipient.wallets.length) {
        who.innerHTML += '<div class="notice warn">This user has no active wallet yet.</div>';
        form.classList.add('hidden');
        return;
      }
      const myCur = walletById(form.fromWalletId.value).currency;
      const preferred = recipient.wallets.find((w) => w.currency === myCur) || recipient.wallets[0];
      $('#to', view).innerHTML = recipient.wallets.map((w) => `<option value="${w.id}" ${w.id === preferred.id ? 'selected' : ''}>${w.currency} wallet</option>`).join('');
      form.classList.remove('hidden');
      form.amount.focus();
      update();
    });
  });
  if (params.to) $('#find', view).requestSubmit();

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, $('#msg', view), async () => {
      const f = formData(form);
      const res = await api('POST', '/wallets/transfers', {
        fromWalletId: f.fromWalletId, toWalletId: f.toWalletId, amount: Number(f.amount), description: f.description || undefined, idempotencyKey: uuid(),
      });
      await refreshMoney();
      const fx = res.toCurrency !== res.currency ? ` They received ${money(res.toAmount, res.toCurrency)}.` : '';
      notice($('#msg', view), 'ok', `Sent ${money(res.amount, res.currency)} to ${esc(recipient.name)}.${fx}`);
      form.amount.value = ''; form.description.value = '';
      form.fromWalletId.innerHTML = walletOptions(f.fromWalletId);
      update();
    });
  });
}

// ---------------------------------------------------------------------------
// Exchange between own wallets (a P2P transfer between two of my wallets)
// ---------------------------------------------------------------------------
function pageExchange(view) {
  if (needWallet(view)) return;
  const missing = currencies().filter((c) => !state.wallets.some((w) => w.currency === c));
  const rateRows = (base) => currencies().filter((c) => c !== base)
    .map((c) => `<tr><td>${flag(c)} ${c}</td><td class="r">1 ${base} = ${convert(1, base, c)} ${c}</td><td class="r">1 ${c} = ${convert(1, c, base)} ${base}</td></tr>`).join('');

  view.innerHTML = `
    <div class="page-head"><h1>Exchange</h1><span class="pill info">Fixed demo rates</span></div>
    ${state.wallets.length < 2 ? `<form class="card" id="open"><h3>You need a second wallet to exchange into</h3>
      <div class="grid2"><select name="currency">${currencyOptions(missing[0], currencies().filter((c) => !missing.includes(c)))}</select><button class="btn">Open wallet</button></div>
      <div id="omsg" class="hidden"></div></form>` : `
    <form class="card" id="f">
      <label class="field"><span>Sell</span><select name="fromWalletId">${walletOptions(state.wallets[0].id)}</select></label>
      <div class="amount-input"><input name="amount" type="number" min="0.01" step="0.01" placeholder="0" required /><span class="cur-label" id="cur"></span></div>
      <label class="field"><span>Buy</span><select name="toWalletId">${walletOptions(state.wallets[1].id)}</select></label>
      <div class="quote" id="q"></div>
      <div id="msg" class="hidden"></div>
      <button class="btn block">${I.exchange} Exchange</button>
    </form>`}
    <section class="card"><div class="card-head"><h3>Rates</h3><span class="muted small" id="base"></span></div>
      <div class="table-wrap"><table><thead><tr><th>Currency</th><th class="r">Buy</th><th class="r">Sell</th></tr></thead><tbody id="rates"></tbody></table></div></section>`;

  const showRates = (base) => { $('#rates', view).innerHTML = rateRows(base); $('#base', view).textContent = `against ${base}`; };
  const form = $('#f', view);
  if (form) {
    const update = () => {
      const f = formData(form);
      const from = walletById(f.fromWalletId);
      const to = walletById(f.toWalletId);
      $('#cur', view).textContent = from.currency;
      showRates(from.currency);
      const amount = Number(f.amount || 0);
      $('#q', view).innerHTML = from.id === to.id ? '<span>Choose two different wallets</span>'
        : `<span>You get · 1 ${from.currency} = ${convert(1, from.currency, to.currency)} ${to.currency}</span><b>${money(convert(amount, from.currency, to.currency), to.currency)}</b>`;
    };
    update();
    form.addEventListener('input', update);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(e.submitter, $('#msg', view), async () => {
        const f = formData(form);
        const res = await api('POST', '/wallets/transfers', {
          fromWalletId: f.fromWalletId, toWalletId: f.toWalletId, amount: Number(f.amount), description: 'Exchange', idempotencyKey: uuid(),
        });
        await refreshMoney();
        notice($('#msg', view), 'ok', `Exchanged ${money(res.amount, res.currency)} → ${money(res.toAmount, res.toCurrency)}`);
        form.fromWalletId.innerHTML = walletOptions(f.fromWalletId);
        form.toWalletId.innerHTML = walletOptions(f.toWalletId);
        form.amount.value = '';
        update();
      });
    });
  } else {
    showRates(state.wallets[0].currency);
    $('#open', view)?.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(e.submitter, $('#omsg', view), async () => {
        await api('POST', '/wallets', { customerId: state.customer.id, currency: formData(e.target).currency });
        await refreshMoney(); render();
      });
    });
  }
}

// ---------------------------------------------------------------------------
// QR pay: request money with a QR code, or scan / paste one to pay
// ---------------------------------------------------------------------------
function pageQr(view, params) {
  if (needWallet(view)) return;
  const mode = params.mode === 'pay' ? 'pay' : 'request';
  view.innerHTML = `
    <div class="page-head"><h1>QR pay</h1>
      <div class="seg"><a href="#/qr" class="${mode === 'request' ? 'active' : ''}">Request</a>
        <a href="#/qr?mode=pay" class="${mode === 'pay' ? 'active' : ''}">Pay</a></div></div>
    <div id="qr-body" style="display:grid;gap:18px"></div>`;
  if (mode === 'request') qrRequest($('#qr-body', view)); else qrPay($('#qr-body', view), params);
}

function qrRequest(root) {
  root.innerHTML = `
    <form class="card" id="f">
      <h3>Get paid with a QR code</h3>
      <label class="field"><span>Into wallet</span><select name="walletId">${walletOptions()}</select></label>
      <div class="amount-input"><input name="amount" type="number" min="0.01" step="0.01" placeholder="0" required /><span class="cur-label" id="cur"></span></div>
      <div class="grid2">
        <label class="field"><span>Description</span><input name="description" maxlength="255" placeholder="Coffee ☕" /></label>
        <label class="field"><span>Valid for</span><select name="expiresInMinutes"><option value="5">5 minutes</option><option value="15" selected>15 minutes</option><option value="60">1 hour</option><option value="1440">1 day</option></select></label>
      </div>
      <div id="msg" class="hidden"></div>
      <button class="btn block">${I.qr} Create QR code</button>
    </form>
    <section class="card hidden" id="code"></section>
    <section class="card"><div class="card-head"><h3>Your recent requests</h3></div><div class="list" id="list"><div class="spinner"></div></div></section>`;
  const form = $('#f', root);
  const update = () => { $('#cur', root).textContent = walletById(form.walletId.value).currency; loadList(); };
  let poll;
  onLeave(() => clearInterval(poll));

  async function loadList() {
    const list = $('#list', root);
    const items = await api('GET', `/wallets/${form.walletId.value}/qr-payments`).catch(() => []);
    if (!list.isConnected) return;
    list.innerHTML = items.map((q) => `<div class="row-item">
        <div class="avatar ${q.status === 'PAID' ? 'green' : ''}">${I.qr}</div>
        <div class="grow"><div class="title">${money(q.amount, q.currency)}${q.description ? ` · ${esc(q.description)}` : ''}</div>
          <div class="sub">${fmtDate(q.createdAt)} · ${q.paidByWalletId ? `paid by <span data-wallet-owner="${q.paidByWalletId}">…</span>` : `expires ${fmtDate(q.expiresAt)}`}</div></div>
        <div class="actions">${statusPill(q.status)}${q.status === 'PENDING' ? `<button class="btn sm ghost" data-show="${esc(q.token)}">Show</button><button class="btn sm danger" data-cancel="${esc(q.token)}">Cancel</button>` : ''}</div>
      </div>`).join('') || emptyState(I.qr, 'No QR requests for this wallet yet');
    fillOwners(list);
    $$('[data-cancel]', list).forEach((b) => b.addEventListener('click', () => busy(b, null, async () => {
      await api('POST', `/qr-payments/${encodeURIComponent(b.dataset.cancel)}/cancel`);
      toast('QR request cancelled'); loadList();
    })));
    $$('[data-show]', list).forEach((b) => b.addEventListener('click', async () => showCode(await api('GET', `/qr-payments/${encodeURIComponent(b.dataset.show)}`))));
  }

  function showCode(qr) {
    const box = $('#code', root);
    box.classList.remove('hidden');
    box.innerHTML = `<div class="qr-wrap"><img src="${qr.qrCodeDataUrl}" alt="QR code for ${esc(money(qr.amount, qr.currency))}" />
      <div style="display:grid;gap:10px"><div class="muted small">Ask the payer to scan this in FinNova → QR pay → Pay</div>
        <h1>${money(qr.amount, qr.currency)}</h1>${qr.description ? `<div>${esc(qr.description)}</div>` : ''}
        <div id="st">${statusPill(qr.status)}</div><div class="small muted">Expires ${fmtDate(qr.expiresAt)}</div>
        <div class="mono">${esc(qr.qrPayload)}</div>
        <div class="actions"><button class="btn sm ghost" id="copy">Copy code</button></div></div></div>`;
    $('#copy', box).addEventListener('click', () => navigator.clipboard?.writeText(qr.qrPayload).then(() => toast('Copied')));
    clearInterval(poll);
    poll = setInterval(async () => {
      const now = await api('GET', `/qr-payments/${encodeURIComponent(qr.token)}`).catch(() => null);
      if (!now || !box.isConnected) return;
      $('#st', box).innerHTML = statusPill(now.status);
      if (now.status !== 'PENDING') {
        clearInterval(poll);
        if (now.status === 'PAID') { toast(`Payment received: ${money(now.amount, now.currency)}`); await refreshMoney(); }
        loadList();
      }
    }, 3000);
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  form.walletId.addEventListener('change', update);
  update();
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, $('#msg', root), async () => {
      const f = formData(form);
      const qr = await api('POST', `/wallets/${f.walletId}/qr-payments`, {
        amount: Number(f.amount), description: f.description || undefined, expiresInMinutes: Number(f.expiresInMinutes),
      });
      showCode(qr);
      form.amount.value = ''; form.description.value = '';
      loadList();
    });
  });
}

function qrPay(root, params) {
  root.innerHTML = `
    <section class="card" style="display:grid;gap:14px">
      <h3>Scan or paste a FinNova QR code</h3>
      <div class="actions"><button class="btn" id="cam">${I.camera} Scan with camera</button>
        <label class="btn ghost" style="cursor:pointer">${I.upload} Upload image<input type="file" accept="image/*" id="file" hidden /></label></div>
      <video class="scanner hidden" id="video" playsinline muted></video>
      <form id="paste" class="grid2"><input name="code" placeholder="finnova://pay?token=…" value="${esc(params.token || '')}" /><button class="btn ghost">Look up</button></form>
      <div id="msg" class="hidden"></div>
    </section>
    <section class="card hidden" id="preview"></section>`;

  let stream = null;
  let raf = null;
  const stop = () => { cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); stream = null; $('#video', root)?.classList.add('hidden'); };
  onLeave(stop);

  const decode = (source, w, h) => {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, w, h);
    return window.jsQR?.(ctx.getImageData(0, 0, w, h).data, w, h)?.data || null;
  };

  $('#cam', root).addEventListener('click', async () => {
    if (!window.jsQR) { notice($('#msg', root), 'bad', 'QR decoder not loaded'); return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    } catch {
      notice($('#msg', root), 'bad', 'Camera not available. Upload a photo of the code or paste it instead.');
      return;
    }
    const video = $('#video', root);
    video.srcObject = stream;
    video.classList.remove('hidden');
    await video.play();
    const tick = () => {
      if (!stream) return;
      if (video.readyState >= 2) {
        const code = decode(video, video.videoWidth, video.videoHeight);
        if (code) { stop(); lookup(code); return; }
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
  });

  $('#file', root).addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1200 / Math.max(img.width, img.height));
      const code = decode(img, Math.round(img.width * scale), Math.round(img.height * scale));
      URL.revokeObjectURL(img.src);
      if (code) lookup(code); else notice($('#msg', root), 'bad', 'No QR code found in that image.');
    };
    img.src = URL.createObjectURL(file);
  });

  $('#paste', root).addEventListener('submit', (e) => { e.preventDefault(); lookup(formData(e.target).code.trim()); });

  async function lookup(code) {
    if (!code) return;
    const token = code.replace(/^.*[?&]token=/, '');
    $('#msg', root).className = 'hidden';
    let qr;
    try {
      qr = await api('GET', `/qr-payments/${encodeURIComponent(token)}`);
    } catch (err) {
      notice($('#msg', root), 'bad', esc(err.status === 404 ? 'This is not a valid FinNova payment code.' : err.message));
      return;
    }
    const payee = await walletOwner(qr.payeeWalletId);
    const box = $('#preview', root);
    box.classList.remove('hidden');
    const payable = qr.status === 'PENDING';
    const sameCur = state.wallets.find((w) => w.currency === qr.currency && w.status === 'ACTIVE');
    box.innerHTML = `
      <div style="text-align:center;display:grid;gap:6px">
        <div class="avatar blue" style="margin:0 auto;width:56px;height:56px">${initials(payee)}</div>
        <div class="muted">Pay ${esc(payee)}</div>
        <h1>${money(qr.amount, qr.currency)}</h1>
        ${qr.description ? `<div>${esc(qr.description)}</div>` : ''}
        <div>${statusPill(qr.status)}</div>
      </div>
      ${payable ? `<form id="payf" style="margin-top:14px">
        <label class="field"><span>Pay from</span><select name="payerWalletId">${walletOptions(sameCur?.id)}</select></label>
        <div class="quote" id="q"></div>
        <div id="pmsg" class="hidden"></div>
        <button class="btn block">Pay ${money(qr.amount, qr.currency)}</button></form>`
        : `<div class="notice ${qr.status === 'PAID' ? 'ok' : 'bad'}" style="margin-top:14px">This code is ${esc(qr.status.toLowerCase())} and cannot be paid.</div>`}`;
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const form = $('#payf', box);
    if (!form) return;
    const update = () => {
      const w = walletById(form.payerWalletId.value);
      $('#q', box).innerHTML = w.currency === qr.currency ? ''
        : `<span>${flag(w.currency)} You pay (1 ${w.currency} = ${convert(1, w.currency, qr.currency)} ${qr.currency})</span><b>${money(convert(qr.amount, qr.currency, w.currency), w.currency)}</b>`;
    };
    update();
    form.addEventListener('change', update);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(e.submitter, $('#pmsg', box), async () => {
        const res = await api('POST', `/qr-payments/${encodeURIComponent(qr.token)}/pay`, { payerWalletId: form.payerWalletId.value });
        await refreshMoney();
        box.innerHTML = `<div style="text-align:center;display:grid;gap:8px"><div class="avatar green" style="margin:0 auto;width:64px;height:64px">${I.check}</div>
          <h2>Paid ${money(res.qrPayment.amount, res.qrPayment.currency)}</h2>
          <div class="muted">to ${esc(payee)}${res.transfer.currency !== res.transfer.toCurrency ? ` · charged ${money(res.transfer.amount, res.transfer.currency)}` : ''}</div>
          <div class="muted small">Balance ${money(res.payerWallet.balance, res.payerWallet.currency)}</div></div>`;
        toast('Payment sent');
      });
    });
  }
  if (params.token) lookup(params.token);
}

// ---------------------------------------------------------------------------
// Transaction history (wallets) + card/bank gateway attempts
// ---------------------------------------------------------------------------
async function pageHistory(view, params) {
  if (needWallet(view)) return;
  const tab = params.tab === 'gateway' ? 'gateway' : 'tx';
  // Card & bank operations are listed per wallet, so "all" falls back to the first wallet there.
  const walletId = tab === 'gateway' && (!params.wallet || params.wallet === 'all') ? state.wallets[0].id : (params.wallet || 'all');
  const page = Math.max(1, Number(params.page) || 1);
  const link = (p) => `#/history?${new URLSearchParams({ ...params, ...p })}`;
  view.innerHTML = `
    <div class="page-head"><h1>Transactions</h1>
      <div class="seg"><a href="${link({ tab: 'tx', page: 1 })}" class="${tab === 'tx' ? 'active' : ''}">Activity</a>
        <a href="${link({ tab: 'gateway', page: 1, wallet: walletId === 'all' ? state.wallets[0].id : walletId })}" class="${tab === 'gateway' ? 'active' : ''}">Card &amp; bank</a></div></div>
    <form class="card" id="filters" style="gap:12px">
      <div class="grid2">
        <select name="wallet">${tab === 'tx' ? `<option value="all" ${walletId === 'all' ? 'selected' : ''}>All wallets</option>` : ''}${walletOptions(walletId)}</select>
        ${tab === 'tx' ? `<select name="type"><option value="">All types</option>${['TOP_UP', 'WITHDRAWAL', 'P2P_SENT', 'P2P_RECEIVED', 'QR_PAYMENT_SENT', 'QR_PAYMENT_RECEIVED', 'REVERSAL']
          .map((t) => `<option ${params.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select>` : ''}
      </div>
      ${tab === 'tx' ? `<div class="grid2"><label class="field"><span>From</span><input type="date" name="from" value="${esc(params.from || '')}" /></label>
        <label class="field"><span>To</span><input type="date" name="to" value="${esc(params.to || '')}" /></label></div>` : ''}
    </form>
    <section class="card"><div class="list" id="list"><div class="spinner"></div></div><div class="actions" id="pager" style="justify-content:center;margin-top:12px"></div></section>`;

  $('#filters', view).addEventListener('change', (e) => {
    const next = Object.fromEntries(Object.entries({ ...params, ...formData(e.currentTarget), page: 1 }).filter(([, v]) => v !== ''));
    location.hash = `#/history?${new URLSearchParams(next)}`;
  });

  const list = $('#list', view);
  if (tab === 'gateway') {
    const rows = await api('GET', `/wallets/${walletId}/gateway-transactions`);
    list.innerHTML = rows.map((g) => `<div class="row-item">
      <div class="avatar ${g.status === 'SUCCEEDED' ? 'green' : g.status === 'FAILED' ? 'red' : 'amber'}">${g.method === 'CARD' ? I.card : I.bank}</div>
      <div class="grow"><div class="title">${g.operation === 'TOP_UP' ? 'Top-up' : 'Withdrawal'} · ${g.method === 'CARD' ? `${esc(g.cardBrand)} ****${esc(g.cardLast4)}` : 'Bank account'}</div>
        <div class="sub">${fmtDate(g.createdAt)}${g.failureMessage ? ` · ${esc(g.failureMessage)}` : ''}</div></div>
      <div class="amount">${money(g.amount, g.currency)}<div>${statusPill(g.status)}</div></div></div>`).join('') || emptyState(I.card, 'No card or bank operations');
    return;
  }

  const qs = new URLSearchParams();
  if (params.type) qs.set('type', params.type);
  if (params.from) qs.set('from', new Date(`${params.from}T00:00:00`).toISOString());
  if (params.to) qs.set('to', new Date(`${params.to}T23:59:59`).toISOString());
  let rows;
  let pageInfo = null;
  if (walletId === 'all') {
    qs.set('pageSize', '100');
    const results = await Promise.all(state.wallets.map((w) => api('GET', `/wallets/${w.id}/transactions?${qs}`)));
    rows = results.flatMap((r) => r.data).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  } else {
    qs.set('page', page); qs.set('pageSize', '20');
    const res = await api('GET', `/wallets/${walletId}/transactions?${qs}`);
    rows = res.data; pageInfo = res.pageInfo;
  }

  // Group by day like a banking app statement.
  let lastDay = '';
  list.innerHTML = rows.map((tx) => {
    const day = fmtDay(tx.timestamp);
    const header = day !== lastDay ? `<div class="muted small" style="padding:14px 4px 4px;font-weight:600">${day}</div>` : '';
    lastDay = day;
    return header + walletTxRow(tx, { showWallet: walletId === 'all' });
  }).join('') || emptyState(I.history, 'No transactions match');
  bindTxRows(list);
  if (pageInfo && pageInfo.totalPages > 1) {
    $('#pager', view).innerHTML = `${page > 1 ? `<a class="btn sm ghost" href="${link({ page: page - 1 })}">Previous</a>` : ''}
      <span class="muted small" style="align-self:center">Page ${page} of ${pageInfo.totalPages}</span>
      ${page < pageInfo.totalPages ? `<a class="btn sm ghost" href="${link({ page: page + 1 })}">Next</a>` : ''}`;
  }
}

// ---------------------------------------------------------------------------
// Bank accounts (Account Service) and statements (Payment Service)
// ---------------------------------------------------------------------------
function pageAccounts(view) {
  view.innerHTML = `
    <div class="page-head"><h1>Bank accounts</h1></div>
    ${kycBanner()}
    <section class="card"><div class="list">${state.accounts.map((a) => `
      <a class="row-item clickable" href="#/account?id=${a.id}" style="color:inherit">
        <div class="avatar blue">${I.bank}</div>
        <div class="grow"><div class="title">${flag(a.currency)} ${a.accountType === 'SAVINGS' ? 'Savings' : 'Current'} account</div>
          <div class="sub mono">${esc(a.accountNumber)}</div></div>
        <div class="amount">${money(a.balance, a.currency)}<div>${statusPill(a.status)}</div></div></a>`).join('') || emptyState(I.bank, 'No bank accounts yet')}</div></section>
    <form class="card" id="f">
      <h3>Open a bank account</h3>
      <div class="grid2">
        <label class="field"><span>Type</span><select name="accountType"><option value="CHECKING">Current account</option><option value="SAVINGS">Savings account</option></select></label>
        <label class="field"><span>Currency</span><select name="currency">${currencyOptions(state.wallets[0]?.currency || 'EUR')}</select></label>
      </div>
      <label class="field"><span>Opening deposit (demo money)</span><input name="initialDeposit" type="number" min="0" step="0.01" value="500" /></label>
      <div id="msg" class="hidden"></div>
      <button class="btn block">Open account</button>
    </form>`;
  $('#f', view).addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, $('#msg', view), async () => {
      const f = formData(e.target);
      const acc = await api('POST', '/accounts', { customerId: state.customer.id, accountType: f.accountType, currency: f.currency, initialDeposit: Number(f.initialDeposit || 0) });
      toast(`Account ${acc.accountNumber} opened`);
      await refreshMoney(); render();
    });
  });
}

async function pageAccount(view, params) {
  const acc = state.accounts.find((a) => a.id === params.id);
  if (!acc) { location.hash = '#/accounts'; return; }
  const page = Math.max(1, Number(params.page) || 1);
  const type = params.type || '';
  const link = (p) => `#/account?${new URLSearchParams({ ...params, ...p })}`;
  view.innerHTML = `
    <div class="page-head"><div><a href="#/accounts" class="small">← Bank accounts</a><h1>${acc.accountType === 'SAVINGS' ? 'Savings' : 'Current'} account</h1></div>
      <a class="btn" href="#/transfer?from=${acc.id}">${I.transfer} Transfer</a></div>
    <section class="hero"><div class="label">${flag(acc.currency)} ${acc.currency} · ${statusPill(acc.status)}</div>
      <div class="balance">${money(acc.balance, acc.currency)}</div>
      <div class="chips"><button class="chip" id="copy">${esc(acc.accountNumber)} · copy</button></div></section>
    <section class="card"><div class="card-head"><h3>Statement</h3>
      <select id="type" style="width:auto"><option value="">All</option><option ${type === 'DEBIT' ? 'selected' : ''}>DEBIT</option><option ${type === 'CREDIT' ? 'selected' : ''}>CREDIT</option></select></div>
      <div class="list" id="list"><div class="spinner"></div></div><div class="actions" id="pager" style="justify-content:center;margin-top:12px"></div></section>`;
  $('#copy', view).addEventListener('click', () => navigator.clipboard?.writeText(acc.accountNumber).then(() => toast('Account number copied')));
  $('#type', view).addEventListener('change', (e) => { location.hash = link({ type: e.target.value, page: 1 }); });

  const res = await api('GET', `/transactions?accountId=${acc.id}&page=${page}&pageSize=20${type ? `&type=${type}` : ''}`);
  $('#list', view).innerHTML = res.data.map((t) => {
    const credit = t.type === 'CREDIT';
    return `<div class="row-item"><div class="avatar ${credit ? 'green' : ''}">${credit ? I.receive : I.send}</div>
      <div class="grow"><div class="title">${esc(t.description || (credit ? 'Incoming payment' : 'Outgoing payment'))}</div><div class="sub">${fmtDate(t.timestamp)}</div></div>
      <div class="amount"><div class="${credit ? 'pos' : 'neg'}">${signed(t.amount, t.currency, credit)}</div><div class="sub">${money(t.balanceAfter, t.currency)}</div></div></div>`;
  }).join('') || emptyState(I.history, 'No payments on this account yet');
  if (res.pageInfo.totalPages > 1) {
    $('#pager', view).innerHTML = `${page > 1 ? `<a class="btn sm ghost" href="${link({ page: page - 1 })}">Previous</a>` : ''}
      <span class="muted small" style="align-self:center">Page ${page} of ${res.pageInfo.totalPages}</span>
      ${page < res.pageInfo.totalPages ? `<a class="btn sm ghost" href="${link({ page: page + 1 })}">Next</a>` : ''}`;
  }
}

// Bank transfer by account number (Payment Service), cross-currency converted by the Account Service.
function pageTransfer(view, params) {
  if (!state.accounts.length) {
    view.innerHTML = `${kycBanner()}<div class="card">${emptyState(I.bank, 'You need a bank account to make bank transfers')}<div style="text-align:center"><a class="btn" href="#/accounts">Open an account</a></div></div>`;
    return;
  }
  let target = null;
  view.innerHTML = `
    <div class="page-head"><h1>Bank transfer</h1></div>
    <form class="card" id="f">
      <label class="field"><span>From account</span><select name="fromAccountId">${accountOptions(params.from)}</select></label>
      <label class="field"><span>Recipient account number</span><input name="accountNumber" placeholder="FN…" required autocomplete="off" /></label>
      ${state.accounts.length > 1 ? `<div class="small muted">Between your accounts: ${state.accounts.map((a) => `<button type="button" class="pill" data-num="${esc(a.accountNumber)}" style="border:0;cursor:pointer;margin:2px">${flag(a.currency)} ${a.currency} ${esc(a.accountNumber.slice(-6))}</button>`).join('')}</div>` : ''}
      <div id="who"></div>
      <div class="amount-input"><input name="amount" type="number" min="0.01" step="0.01" placeholder="0" required /><span class="cur-label" id="cur"></span></div>
      <div class="quote" id="q"></div>
      <label class="field"><span>Reference</span><input name="description" maxlength="140" placeholder="Rent November" /></label>
      <div id="msg" class="hidden"></div>
      <button class="btn block">${I.transfer} Send transfer</button>
    </form>`;
  const form = $('#f', view);
  const update = () => {
    const from = state.accounts.find((a) => a.id === form.fromAccountId.value);
    $('#cur', view).textContent = from.currency;
    const amount = Number(form.amount.value || 0);
    $('#q', view).innerHTML = target && amount > 0
      ? (target.currency === from.currency ? `<span>Recipient gets</span><b>${money(amount, from.currency)}</b>`
        : `<span>Recipient gets (1 ${from.currency} = ${convert(1, from.currency, target.currency)} ${target.currency})</span><b>${money(convert(amount, from.currency, target.currency), target.currency)}</b>`) : '';
  };
  const lookup = async () => {
    const number = form.accountNumber.value.trim();
    target = null;
    if (!number) { $('#who', view).innerHTML = ''; update(); return; }
    try {
      [target] = await api('GET', `/accounts?accountNumber=${encodeURIComponent(number)}`);
      const owner = target.customerId === state.customer.id ? 'You' : await customerName(target.customerId);
      $('#who', view).innerHTML = `<div class="row-item"><div class="avatar blue">${initials(owner)}</div><div class="grow"><div class="title">${esc(owner)}</div>
        <div class="sub">${flag(target.currency)} ${target.currency} ${target.accountType === 'SAVINGS' ? 'savings' : 'current'} account</div></div></div>`;
    } catch {
      $('#who', view).innerHTML = '<div class="notice bad">No account with this number</div>';
    }
    update();
  };
  form.accountNumber.addEventListener('change', lookup);
  $$('[data-num]', view).forEach((b) => b.addEventListener('click', () => { form.accountNumber.value = b.dataset.num; lookup(); }));
  form.addEventListener('input', update);
  update();
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, $('#msg', view), async () => {
      if (!target) await lookup();
      if (!target) throw new Error('Enter a valid recipient account number');
      const from = state.accounts.find((a) => a.id === form.fromAccountId.value);
      const pay = await api('POST', '/payments', {
        fromAccountId: from.id, toAccountId: target.id, amount: Number(form.amount.value), currency: from.currency,
        description: form.description.value || undefined, idempotencyKey: uuid(),
      });
      await refreshMoney();
      const fx = pay.toCurrency !== pay.currency ? ` Recipient received ${money(pay.toAmount, pay.toCurrency)}.` : '';
      notice($('#msg', view), 'ok', `Transfer of ${money(pay.amount, pay.currency)} completed.${fx}`);
      form.fromAccountId.innerHTML = accountOptions(from.id);
      form.amount.value = ''; form.description.value = '';
      update();
    });
  });
}

// ---------------------------------------------------------------------------
// Ledger (Ledger Service): debit/credit entries for an account or wallet
// ---------------------------------------------------------------------------
async function pageLedger(view, params) {
  const sources = [
    ...state.wallets.map((w) => ({ id: w.id, label: `${w.currency} wallet` })),
    ...state.accounts.map((a) => ({ id: a.id, label: `${a.currency} account ${a.accountNumber}` })),
  ];
  if (!sources.length) { view.innerHTML = `<div class="card">${emptyState(I.ledger, 'No wallets or accounts yet')}</div>`; return; }
  const selected = params.id || sources[0].id;
  view.innerHTML = `
    <div class="page-head"><h1>Ledger</h1></div>
    <p class="muted" style="margin:0">Double-entry bookkeeping: every movement is recorded as a debit on one side and a matching credit on the other.</p>
    <section class="card"><select id="src">${sources.map((s) => `<option value="${s.id}" ${s.id === selected ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select>
      <div id="sum" class="actions" style="margin-top:14px"></div>
      <div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>Date</th><th>Transaction</th><th class="r">Debit</th><th class="r">Credit</th></tr></thead><tbody id="rows"></tbody></table></div></section>`;
  $('#src', view).addEventListener('change', (e) => { location.hash = `#/ledger?id=${e.target.value}`; });
  const entries = await api('GET', `/ledger-entries?accountId=${selected}&limit=200`);
  $('#rows', view).innerHTML = entries.map((e) => `<tr><td>${fmtDate(e.createdAt)}</td><td class="mono">${short(e.transactionId)}</td>
    <td class="r">${e.entryType === 'DEBIT' ? money(e.amount, e.currency) : ''}</td><td class="r pos">${e.entryType === 'CREDIT' ? money(e.amount, e.currency) : ''}</td></tr>`).join('')
    || `<tr><td colspan="4">${emptyState(I.ledger, 'No ledger entries yet')}</td></tr>`;
  const totals = {};
  entries.forEach((e) => { totals[e.currency] = (totals[e.currency] || 0) + (e.entryType === 'CREDIT' ? e.amount : -e.amount); });
  $('#sum', view).innerHTML = Object.entries(totals).map(([cur, net]) => `<span class="pill ${net >= 0 ? 'ok' : 'bad'}">Net ${money(net, cur)}</span>`).join('')
    + `<span class="pill">${entries.length} entries</span>`;
}

// ---------------------------------------------------------------------------
// Inbox (Notification Service)
// ---------------------------------------------------------------------------
function describeNotification(n) {
  const p = n.payload || {};
  const amt = p.amount !== undefined ? money(p.amount, p.currency) : '';
  const fx = p.toCurrency && p.toCurrency !== p.currency ? ` → ${money(p.toAmount, p.toCurrency)}` : '';
  const map = {
    KYC_APPROVED: [I.shield, 'green', 'Identity verified', `Your ${p.documentType || 'document'} was approved`],
    KYC_REJECTED: [I.shield, 'red', 'Identity verification failed', 'Please try again with another document'],
    ACCOUNT_OPENED: [I.bank, 'blue', 'Bank account opened', `${p.accountNumber || ''} · ${p.currency || ''}`],
    WALLET_CREATED: [I.wallet, 'blue', 'Wallet opened', `${p.currency} wallet is ready`],
    WALLET_TOPPED_UP: [I.plus, 'green', 'Money added', `${amt} via ${p.method === 'CARD' ? 'card' : 'bank account'}`],
    WALLET_WITHDRAWAL: [I.bank, '', 'Withdrawal sent', amt],
    PAYMENT_SENT: [I.send, '', 'Bank transfer sent', `${amt}${fx}`],
    PAYMENT_RECEIVED: [I.receive, 'green', 'Bank transfer received', `${p.toCurrency ? money(p.toAmount, p.toCurrency) : amt}`],
    WALLET_TRANSFER_SENT: [I.send, '', 'Money sent', `${amt}${fx}`],
    WALLET_TRANSFER_RECEIVED: [I.receive, 'green', 'Money received', `${p.toCurrency ? money(p.toAmount, p.toCurrency) : amt}`],
    QR_PAYMENT_SENT: [I.qr, '', 'QR payment sent', `${amt}${fx}`],
    QR_PAYMENT_RECEIVED: [I.qr, 'green', 'QR payment received', `${p.toCurrency ? money(p.toAmount, p.toCurrency) : amt}`],
  };
  return map[n.type] || [I.bell, '', n.type, JSON.stringify(p)];
}

async function pageInbox(view) {
  view.innerHTML = `<div class="page-head"><h1>Inbox</h1></div><section class="card"><div class="list" id="list"><div class="spinner"></div></div></section>`;
  const items = await api('GET', `/notifications?recipientId=${state.customer.id}`);
  $('#list', view).innerHTML = items.map((n) => {
    const [icon, tone, title, body] = describeNotification(n);
    return `<div class="row-item"><div class="avatar ${tone}">${icon}</div>
      <div class="grow"><div class="title">${esc(title)}</div><div class="sub">${esc(body)}</div></div>
      <div class="sub small muted">${fmtDate(n.createdAt)}</div></div>`;
  }).join('') || emptyState(I.bell, 'No notifications yet');
}

// ---------------------------------------------------------------------------
// Profile (Customer + Identity)
// ---------------------------------------------------------------------------
function pageProfile(view) {
  const c = state.customer;
  const addr = [c.address?.street, c.address?.postalCode, c.address?.city, c.address?.country].filter(Boolean).join(', ');
  view.innerHTML = `
    <div style="text-align:center;display:grid;gap:6px;justify-items:center">
      <div class="avatar blue" style="width:84px;height:84px;font-size:28px">${initials(fullName(c))}</div>
      <h1>${esc(fullName(c))}</h1><div class="muted">@${esc(state.user.username)}</div>
      <div>${statusPill(c.kycStatus)}</div>
    </div>
    ${kycApproved() ? '' : `<form class="card" id="kyc"><h3>Verify your identity</h3>
      <select name="documentType"><option value="PASSPORT">Passport</option><option value="ID_CARD">National ID card</option><option value="DRIVING_LICENCE">Driving licence</option></select>
      <div id="kmsg" class="hidden"></div><button class="btn block">${I.shield} Verify (simulated)</button></form>`}
    <section class="card"><h3 style="margin-bottom:12px">Personal details</h3>
      <dl class="kv">
        <dt>Email</dt><dd>${esc(c.email)}</dd>
        <dt>Phone</dt><dd>${esc(c.phone || '-')}</dd>
        <dt>Date of birth</dt><dd>${c.dateOfBirth ? fmtDay(c.dateOfBirth) : '-'}</dd>
        <dt>Address</dt><dd>${esc(addr || '-')}</dd>
        <dt>Customer since</dt><dd>${fmtDay(c.createdAt)}</dd>
        <dt>Customer ID</dt><dd class="mono">${esc(c.id)}</dd>
        <dt>Session expires</dt><dd>${state.expiresAt ? fmtDate(state.expiresAt) : '-'}</dd>
      </dl></section>
    <section class="card"><h3 style="margin-bottom:8px">All services</h3><div class="list">
      ${NAV.filter(Boolean).filter((n) => n[0] !== '/profile').map((n) => `<a class="row-item clickable" href="#${n[0]}" style="color:inherit"><div class="avatar">${n[2]}</div><div class="grow title">${n[1]}</div></a>`).join('')}
      <a class="row-item clickable" href="/docs/" style="color:inherit"><div class="avatar">${I.docs}</div><div class="grow title">API documentation</div></a>
      <a class="row-item clickable" href="/wallet/" style="color:inherit"><div class="avatar">${I.docs}</div><div class="grow title">Wallet developer console</div></a>
    </div></section>
    <button class="btn block danger" id="out">${I.logout} Log out</button>`;
  $('#out', view).addEventListener('click', async () => {
    await api('POST', '/auth/logout', undefined, { auth: true }).catch(() => {});
    signOutLocal();
    location.hash = '#/welcome';
  });
  $('#kyc', view)?.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, $('#kmsg', view), async () => {
      state.customer = await api('POST', `/customers/${c.id}/kyc`, { documentType: formData(e.target).documentType, result: 'APPROVED' });
      toast('Identity verified');
      render();
    });
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const PUBLIC = { '/welcome': pageWelcome, '/login': pageLogin, '/signup': pageSignup };
const PRIVATE = {
  '/home': pageHome, '/wallets': pageWallets, '/add-money': pageAddMoney, '/send': pageSend, '/exchange': pageExchange,
  '/qr': pageQr, '/history': pageHistory, '/accounts': pageAccounts, '/account': pageAccount, '/transfer': pageTransfer,
  '/ledger': pageLedger, '/inbox': pageInbox, '/profile': pageProfile,
};
const TITLES = { '/welcome': 'Welcome', '/login': 'Log in', '/signup': 'Sign up' };

function parseHash() {
  const [path, query = ''] = (location.hash.replace(/^#/, '') || '/home').split('?');
  return { path, params: Object.fromEntries(new URLSearchParams(query)) };
}

let renderSeq = 0;
async function render() {
  leaveHooks.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
  leaveHooks = [];
  $$('.modal-back').forEach((m) => m.remove());
  const seq = ++renderSeq;
  const { path, params } = parseHash();
  const signup = store.get('signup');

  try {
    await loadRates().catch(() => null);
    if (state.token && !state.user) await loadSession();

    // A sign-up in progress continues where it stopped (steps 1-3 happen before / during login).
    if (PUBLIC[path] || !state.user || (signup && path !== '/signup')) {
      if (state.user && !signup && PUBLIC[path]) { location.hash = '#/home'; return; }
      if (signup && path !== '/signup' && path !== '/login' && path !== '/welcome') { location.hash = '#/signup'; return; }
      const page = PUBLIC[path] || pageWelcome;
      document.title = `FinNova · ${TITLES[path] || 'Welcome'}`;
      page(renderAuthShell(), params);
      return;
    }

    const page = PRIVATE[path];
    if (!page) { location.hash = '#/home'; return; }
    await refreshMoney();
    if (seq !== renderSeq) return;
    const nav = NAV.find((n) => n && n[0] === path);
    document.title = `FinNova · ${nav ? nav[1] : 'Account'}`;
    const view = renderShell(path);
    await page(view, params);
  } catch (err) {
    console.error(err);
    if (seq !== renderSeq) return;
    const view = $('#view') || renderAuthShell();
    view.innerHTML = `<div class="card"><div class="notice bad">${esc(err.message || 'Something went wrong')}</div>
      <div class="actions" style="margin-top:12px"><button class="btn" id="retry">Try again</button></div></div>`;
    $('#retry').addEventListener('click', render);
  }
}

window.addEventListener('hashchange', render);
render();
