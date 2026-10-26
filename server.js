'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const ADMIN_IDS = new Set((process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
const MINI_APP_URL = (process.env.MINI_APP_URL || '').trim();
const DB_PATH = path.resolve(process.env.DATABASE_PATH || path.join(__dirname, 'data', 'aizen-store.json'));
const ORIGINS = (process.env.FRONTEND_ORIGIN || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
const ASSETS = {
  USDC: { label: 'USDC · Ethereum (ERC-20)', env: 'DEPOSIT_ADDRESS_USDC_ETH', network: 'Ethereum (ERC-20)' },
  SOL: { label: 'SOL · Solana', env: 'DEPOSIT_ADDRESS_SOL_SOLANA', network: 'Solana' },
  BTC: { label: 'BTC · Bitcoin', env: 'DEPOSIT_ADDRESS_BTC_BITCOIN', network: 'Bitcoin' }
};
// Plan thresholds and target rates transcribed from the user's reference screenshots.
// They are calculation targets, not guaranteed returns. Real credits are capped by the funded
// pool of net trading profit entered by an administrator after actual results are realized.
const PLANS = [
  { name: 'Starter', minUsd: 50, maxUsd: 100, dailyRatePct: 2 },
  { name: 'Silver', minUsd: 100, maxUsd: 500, dailyRatePct: 2.5 },
  { name: 'Bronze', minUsd: 500, maxUsd: 1000, dailyRatePct: 4 },
  { name: 'Gold', minUsd: 1000, maxUsd: 5000, dailyRatePct: 6 },
  { name: 'Platinum', minUsd: 5000, maxUsd: 10000, dailyRatePct: 8 },
  { name: 'Diamond', minUsd: 10000, maxUsd: 25000, dailyRatePct: 9.5 },
  { name: 'Royal', minUsd: 25000, maxUsd: 75000, dailyRatePct: 11 }
];
const PLAN_BY_NAME = Object.fromEntries(PLANS.map(p => [p.name, p]));
const HOUR_MS = 60 * 60 * 1000;
function emptyProfitPool() {
  return { availableUSDC: 0, totalAddedUSDC: 0, totalDistributedUSDC: 0, lastDistributionAt: null, contributions: [], distributions: [] };
}

let store = { users: {}, requests: [], audit: [], ledger: [], profitPool: emptyProfitPool() };
let writeQueue = Promise.resolve();
function ensureStore() {
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    if (fs.existsSync(DB_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      store = {
        users: parsed.users || {}, requests: parsed.requests || [], audit: parsed.audit || [],
        ledger: Array.isArray(parsed.ledger) ? parsed.ledger : [],
        profitPool: { ...emptyProfitPool(), ...(parsed.profitPool || {}) }
      };
      // Migrate older user records without changing existing balances.
      for (const user of Object.values(store.users)) {
        user.balances = { USDC: 0, SOL: 0, BTC: 0, ...(user.balances || {}) };
        user.reserved = { USDC: 0, SOL: 0, BTC: 0, ...(user.reserved || {}) };
        if (!Number.isFinite(Number(user.principalUSDC))) user.principalUSDC = round8(Number(user.balances.USDC || 0) + Number(user.reserved.USDC || 0));
        if (!Number.isFinite(Number(user.profitBalanceUSDC))) user.profitBalanceUSDC = 0;
        if (!Number.isFinite(Number(user.totalProfitsEarnedUSDC))) user.totalProfitsEarnedUSDC = 0;
      }
    } else persist();
  } catch (e) {
    console.error('Database load error:', e.message);
    throw new Error('Database non leggibile: controlla DATABASE_PATH e i permessi del disco persistente.');
  }
}
function persist() {
  const snapshot = JSON.stringify(store, null, 2);
  writeQueue = writeQueue.then(async () => {
    await fs.promises.mkdir(path.dirname(DB_PATH), { recursive: true });
    const tmp = `${DB_PATH}.tmp`;
    await fs.promises.writeFile(tmp, snapshot, { mode: 0o600 });
    await fs.promises.rename(tmp, DB_PATH);
  }).catch(err => console.error('Database save error:', err.message));
  return writeQueue;
}
const now = () => new Date().toISOString();
const round8 = n => Math.round((Number(n) + Number.EPSILON) * 1e8) / 1e8;
const publicUser = u => ({
  id: u.id, firstName: u.firstName, lastName: u.lastName, username: u.username, languageCode: u.languageCode,
  createdAt: u.createdAt, lastSeenAt: u.lastSeenAt, balances: u.balances, reserved: u.reserved,
  principalUSDC: round8(u.principalUSDC || 0), profitBalanceUSDC: round8(u.profitBalanceUSDC || 0),
  totalProfitsEarnedUSDC: round8(u.totalProfitsEarnedUSDC || 0), lastProfitAt: u.lastProfitAt || null,
  activePlan: u.activePlan || 'Starter'
});
function newId(prefix) { return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`; }
function balanceForTier(user) { return round8(Number(user.balances?.USDC || 0) + Number(user.reserved?.USDC || 0)); }
function highestEligiblePlan(balance) {
  const eligible = PLANS.filter(p => balance >= p.minUsd);
  return eligible.length ? eligible[eligible.length - 1].name : 'Starter';
}
function normalizePlanAfterBalanceChange(user) {
  const current = PLAN_BY_NAME[user.activePlan];
  if (current && balanceForTier(user) < current.minUsd) user.activePlan = highestEligiblePlan(balanceForTier(user));
}
function consumeWithdrawalAccounting(user, amount) {
  // Withdraw profit balance first; only then reduce the remaining deposited principal.
  const fromProfit = Math.min(Number(user.profitBalanceUSDC || 0), amount);
  user.profitBalanceUSDC = round8(Math.max(0, Number(user.profitBalanceUSDC || 0) - fromProfit));
  const fromPrincipal = round8(Math.max(0, amount - fromProfit));
  user.principalUSDC = round8(Math.max(0, Number(user.principalUSDC || 0) - fromPrincipal));
}
function audit(adminId, action, requestId, detail = '') {
  store.audit.unshift({ id: newId('log'), adminId: String(adminId), action, requestId: requestId || null, detail, createdAt: now() });
  store.audit = store.audit.slice(0, 1000);
  persist();
}

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '32kb' }));
app.use(cors({
  origin(origin, callback) {
    if (!origin || ORIGINS.includes(origin.replace(/\/$/, ''))) return callback(null, true);
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Telegram-Init-Data'],
  maxAge: 600
}));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));

function verifyTelegramInitData(initData) {
  if (!BOT_TOKEN) return { ok: false, error: 'Server non configurato: manca TELEGRAM_BOT_TOKEN.' };
  if (typeof initData !== 'string' || initData.length < 20 || initData.length > 12000) return { ok: false, error: 'Dati Telegram assenti o non validi. Apri la Mini App dal bot.' };
  try {
    const params = new URLSearchParams(initData);
    const receivedHash = params.get('hash');
    if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) return { ok: false, error: 'Firma Telegram non valida.' };
    params.delete('hash');
    const rows = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`);
    const dataCheckString = rows.join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    const a = Buffer.from(expectedHash, 'hex');
    const b = Buffer.from(receivedHash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, error: 'Autenticazione Telegram non riuscita. Riapri la Mini App dal bot.' };
    const authDate = Number(params.get('auth_date'));
    if (!authDate || Math.abs(Date.now() / 1000 - authDate) > 24 * 60 * 60) return { ok: false, error: 'Sessione Telegram scaduta. Chiudi e riapri la Mini App.' };
    const userJSON = params.get('user');
    if (!userJSON) return { ok: false, error: 'Profilo Telegram non trovato nella sessione.' };
    const user = JSON.parse(userJSON);
    if (!user.id) return { ok: false, error: 'ID Telegram non valido.' };
    return { ok: true, user };
  } catch (e) {
    return { ok: false, error: 'Non è stato possibile verificare la sessione Telegram.' };
  }
}
function auth(req, res, next) {
  const result = verifyTelegramInitData(req.get('X-Telegram-Init-Data'));
  if (!result.ok) return res.status(401).json({ ok: false, error: result.error });
  const t = result.user;
  const id = String(t.id);
  let user = store.users[id];
  if (!user) {
    user = store.users[id] = {
      id, firstName: String(t.first_name || ''), lastName: String(t.last_name || ''), username: String(t.username || ''),
      languageCode: String(t.language_code || 'en'), createdAt: now(), lastSeenAt: now(),
      balances: { USDC: 0, SOL: 0, BTC: 0 }, reserved: { USDC: 0, SOL: 0, BTC: 0 },
      principalUSDC: 0, profitBalanceUSDC: 0, totalProfitsEarnedUSDC: 0, lastProfitAt: null, activePlan: 'Starter'
    };
  } else {
    user.firstName = String(t.first_name || user.firstName || '');
    user.lastName = String(t.last_name || user.lastName || '');
    user.username = String(t.username || user.username || '');
    user.languageCode = String(t.language_code || user.languageCode || 'en');
    user.lastSeenAt = now();
  }
  persist();
  req.telegramUser = t;
  req.appUser = user;
  req.telegramId = id;
  next();
}
function adminOnly(req, res, next) {
  if (!ADMIN_IDS.has(req.telegramId)) return res.status(403).json({ ok: false, error: 'Accesso riservato agli amministratori autorizzati.' });
  next();
}
function validAsset(asset) { return Object.prototype.hasOwnProperty.call(ASSETS, asset); }
function validAmount(value) { const n = Number(value); return Number.isFinite(n) && n > 0 && n <= 1e9 && round8(n) === n; }
function safeRequest(r) { return { ...r }; }

app.get('/health', (_req, res) => res.json({ ok: true, service: 'aizentrading-v2', time: now() }));
app.get('/api/config', (_req, res) => {
  const depositAddresses = {};
  for (const [asset, info] of Object.entries(ASSETS)) depositAddresses[asset] = process.env[info.env] || '';
  // Deposit minimum is enforced on the server in a USD-stable denomination (USDC).
  res.json({
    ok: true, depositAddresses, depositMinUsd: 50, depositAsset: 'USDC',
    assets: Object.fromEntries(Object.entries(ASSETS).map(([k, v]) => [k, { label: v.label, network: v.network }])),
    plans: PLANS, status: 'online', profitCredits: 'Only distributed from the administrator-entered pool of net realized trading profits; not guaranteed.'
  });
});
app.use('/api', auth);
app.get('/api/me', (req, res) => res.json({ ok: true, user: publicUser(req.appUser), isAdmin: ADMIN_IDS.has(req.telegramId) }));
app.get('/api/transactions', (req, res) => {
  const requests = store.requests.filter(r => r.userId === req.telegramId);
  const credits = (store.ledger || []).filter(r => r.userId === req.telegramId).map(r => ({
    id: r.id, type: 'profit', asset: 'USDC', amount: r.amount, status: 'credited', createdAt: r.createdAt,
    note: r.note || 'Distribuzione del profitto netto di trading'
  }));
  const items = [...requests, ...credits].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ ok: true, requests: items.slice(0, 500) });
});
app.post('/api/plan', async (req, res) => {
  const plan = String(req.body?.plan || '');
  const terms = PLAN_BY_NAME[plan];
  if (!terms) return res.status(400).json({ ok: false, error: 'Piano non valido.' });
  const balance = balanceForTier(req.appUser);
  if (balance < terms.minUsd) {
    return res.status(409).json({ ok: false, error: `Il piano ${plan} richiede almeno ${terms.minUsd.toLocaleString('en-US')} USDC di saldo verificato. Saldo utile attuale: ${balance.toFixed(2)} USDC.` });
  }
  req.appUser.activePlan = plan;
  await persist();
  audit(req.telegramId, 'plan_selected', null, `${plan} · balance ${balance} USDC`);
  res.json({ ok: true, user: publicUser(req.appUser), message: 'Piano aggiornato.' });
});
app.post('/api/deposits', async (req, res) => {
  const asset = String(req.body?.asset || '');
  const amount = Number(req.body?.amount);
  const txHash = String(req.body?.txHash || '').trim().slice(0, 180);
  const address = String(req.body?.address || '').trim().slice(0, 180);
  if (!validAsset(asset)) return res.status(400).json({ ok: false, error: 'Seleziona un asset valido.' });
  if (asset !== 'USDC') return res.status(400).json({ ok: false, error: 'Per applicare il deposito minimo di 50 USD in modo corretto, i depositi sono attualmente accettati solo in USDC su Ethereum (ERC-20). Gli altri asset possono essere abilitati dopo l’integrazione di una quotazione USD verificata.' });
  if (!validAmount(amount)) return res.status(400).json({ ok: false, error: 'Inserisci un importo valido.' });
  if (amount < 50) return res.status(400).json({ ok: false, error: 'Il deposito minimo è 50 USDC.' });
  if (!txHash) return res.status(400).json({ ok: false, error: 'Inserisci l’hash della transazione per richiedere la verifica.' });
  if (!process.env[ASSETS[asset].env]) return res.status(409).json({ ok: false, error: 'Le coordinate di deposito per questa rete non sono ancora state configurate.' });
  if (!address || address !== process.env[ASSETS[asset].env]) return res.status(400).json({ ok: false, error: 'La destinazione selezionata non corrisponde all’indirizzo configurato per questa rete.' });
  if (store.requests.some(r => r.type === 'deposit' && r.asset === asset && r.txHash.toLowerCase() === txHash.toLowerCase() && r.status !== 'rejected')) return res.status(409).json({ ok: false, error: 'Questo hash è già stato inviato per verifica.' });
  const item = { id: newId('dep'), type: 'deposit', userId: req.telegramId, userName: [req.appUser.firstName, req.appUser.lastName].filter(Boolean).join(' ') || req.appUser.username || req.telegramId, asset, network: ASSETS[asset].network, amount: round8(amount), txHash, destination: address, status: 'pending', createdAt: now(), updatedAt: now() };
  store.requests.push(item); await persist(); res.status(201).json({ ok: true, request: safeRequest(item) });
});
app.post('/api/withdrawals', async (req, res) => {
  const asset = String(req.body?.asset || '');
  const amount = Number(req.body?.amount);
  const address = String(req.body?.address || '').trim();
  if (!validAsset(asset)) return res.status(400).json({ ok: false, error: 'Seleziona un asset valido.' });
  if (!validAmount(amount)) return res.status(400).json({ ok: false, error: 'Inserisci un importo valido.' });
  if (address.length < 12 || address.length > 180 || /\s/.test(address)) return res.status(400).json({ ok: false, error: 'Controlla l’indirizzo wallet.' });
  const qty = round8(amount);
  if (round8(req.appUser.balances[asset] || 0) < qty) return res.status(409).json({ ok: false, error: 'Saldo disponibile insufficiente per questo importo.' });
  req.appUser.balances[asset] = round8(req.appUser.balances[asset] - qty);
  req.appUser.reserved[asset] = round8((req.appUser.reserved[asset] || 0) + qty);
  const item = { id: newId('wd'), type: 'withdrawal', userId: req.telegramId, userName: [req.appUser.firstName, req.appUser.lastName].filter(Boolean).join(' ') || req.appUser.username || req.telegramId, asset, network: ASSETS[asset].network, amount: qty, destination: address, status: 'pending', createdAt: now(), updatedAt: now() };
  store.requests.push(item); await persist(); res.status(201).json({ ok: true, request: safeRequest(item), user: publicUser(req.appUser) });
});

app.get('/api/admin/requests', adminOnly, (req, res) => {
  const type = String(req.query.type || 'all');
  const status = String(req.query.status || 'all');
  let requests = [...store.requests].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (['deposit', 'withdrawal'].includes(type)) requests = requests.filter(r => r.type === type);
  if (['pending', 'verified', 'rejected', 'paid'].includes(status)) requests = requests.filter(r => r.status === status);
  res.json({ ok: true, requests: requests.slice(0, 500) });
});
app.get('/api/admin/users', adminOnly, (_req, res) => {
  const users = Object.values(store.users).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)).map(u => ({ ...publicUser(u), requestCount: store.requests.filter(r => r.userId === u.id).length }));
  res.json({ ok: true, users: users.slice(0, 500) });
});
app.get('/api/admin/audit', adminOnly, (_req, res) => res.json({ ok: true, audit: store.audit.slice(0, 300) }));
app.patch('/api/admin/requests/:id', adminOnly, async (req, res) => {
  const item = store.requests.find(r => r.id === req.params.id);
  if (!item) return res.status(404).json({ ok: false, error: 'Richiesta non trovata.' });
  const action = String(req.body?.action || '');
  const target = store.users[item.userId];
  if (!target) return res.status(404).json({ ok: false, error: 'Utente della richiesta non trovato.' });
  if (item.status !== 'pending') return res.status(409).json({ ok: false, error: 'La richiesta è già stata elaborata.' });
  if (item.type === 'deposit' && !['verify', 'reject'].includes(action)) return res.status(400).json({ ok: false, error: 'Per i depositi scegli Verifica o Rifiuta.' });
  if (item.type === 'withdrawal' && !['paid', 'reject'].includes(action)) return res.status(400).json({ ok: false, error: 'Per i prelievi scegli Segna come pagato o Rifiuta.' });
  if (item.type === 'deposit' && action === 'verify') {
    // This is an admin attestation only; the operator must check the hash on the correct public explorer first.
    target.balances[item.asset] = round8((target.balances[item.asset] || 0) + item.amount);
    if (item.asset === 'USDC') target.principalUSDC = round8(Number(target.principalUSDC || 0) + item.amount);
    item.status = 'verified';
  } else if (item.type === 'withdrawal' && action === 'paid') {
    target.reserved[item.asset] = round8(Math.max(0, (target.reserved[item.asset] || 0) - item.amount));
    if (item.asset === 'USDC') consumeWithdrawalAccounting(target, item.amount);
    item.status = 'paid';
    normalizePlanAfterBalanceChange(target);
  } else {
    if (item.type === 'withdrawal') {
      target.reserved[item.asset] = round8(Math.max(0, (target.reserved[item.asset] || 0) - item.amount));
      target.balances[item.asset] = round8((target.balances[item.asset] || 0) + item.amount);
    }
    item.status = 'rejected';
  }
  item.updatedAt = now();
  item.reviewedBy = req.telegramId;
  item.adminNote = String(req.body?.note || '').trim().slice(0, 500);
  await persist(); audit(req.telegramId, `${item.type}_${item.status}`, item.id, item.adminNote);
  res.json({ ok: true, request: item, user: publicUser(target) });
});
function safeProfitPool() {
  const p = store.profitPool || emptyProfitPool();
  return {
    availableUSDC: round8(p.availableUSDC || 0), totalAddedUSDC: round8(p.totalAddedUSDC || 0),
    totalDistributedUSDC: round8(p.totalDistributedUSDC || 0), lastDistributionAt: p.lastDistributionAt || null,
    contributions: (p.contributions || []).slice(0, 20), distributions: (p.distributions || []).slice(0, 20)
  };
}
async function distributeHourlyProfits(source = 'scheduled') {
  const pool = store.profitPool || (store.profitPool = emptyProfitPool());
  const currentTime = Date.now();
  if (pool.lastDistributionAt && currentTime - Date.parse(pool.lastDistributionAt) < HOUR_MS - 5000) {
    return { distributedUSDC: 0, usersPaid: 0, reason: 'hourly_window_not_due' };
  }
  const available = round8(Number(pool.availableUSDC || 0));
  if (available <= 0) return { distributedUSDC: 0, usersPaid: 0, reason: 'profit_pool_empty' };
  const eligible = Object.values(store.users).map(user => {
    const terms = PLAN_BY_NAME[user.activePlan];
    const amount = round8(Number(user.balances?.USDC || 0));
    if (!terms || amount < terms.minUsd) return null;
    const target = round8(amount * (terms.dailyRatePct / 100) / 24);
    if (target <= 0) return null;
    return { user, terms, target };
  }).filter(Boolean);
  const totalTarget = round8(eligible.reduce((sum, x) => sum + x.target, 0));
  if (!eligible.length || totalTarget <= 0) return { distributedUSDC: 0, usersPaid: 0, reason: 'no_eligible_users' };
  // Every cent credited is funded by the pool of net trading profit entered by an admin.
  const budget = round8(Math.min(available, totalTarget));
  let remaining = budget;
  let usersPaid = 0;
  const stamp = now();
  eligible.forEach((entry, index) => {
    const amount = index === eligible.length - 1 ? round8(remaining) : round8(budget * entry.target / totalTarget);
    const credit = round8(Math.max(0, Math.min(remaining, amount)));
    if (credit <= 0) return;
    const u = entry.user;
    u.balances.USDC = round8(Number(u.balances.USDC || 0) + credit);
    u.profitBalanceUSDC = round8(Number(u.profitBalanceUSDC || 0) + credit);
    u.totalProfitsEarnedUSDC = round8(Number(u.totalProfitsEarnedUSDC || 0) + credit);
    u.lastProfitAt = stamp;
    store.ledger.unshift({
      id: newId('profit'), userId: u.id, type: 'trading_profit', asset: 'USDC', amount: credit,
      plan: entry.terms.name, targetDailyRatePct: entry.terms.dailyRatePct,
      source, note: 'Quota oraria da pool di profitti netti di trading registrati dall’amministratore', createdAt: stamp
    });
    remaining = round8(remaining - credit);
    usersPaid++;
  });
  const distributedUSDC = round8(budget - remaining);
  pool.availableUSDC = round8(Math.max(0, available - distributedUSDC));
  pool.totalDistributedUSDC = round8(Number(pool.totalDistributedUSDC || 0) + distributedUSDC);
  pool.lastDistributionAt = stamp;
  pool.distributions = [{ id: newId('dist'), source, amount: distributedUSDC, usersPaid, createdAt: stamp }, ...(pool.distributions || [])].slice(0, 500);
  store.ledger = (store.ledger || []).slice(0, 10000);
  await persist();
  console.log(`Profit distribution ${source}: ${distributedUSDC} USDC across ${usersPaid} users; pool remaining ${pool.availableUSDC}`);
  return { distributedUSDC, usersPaid, poolAvailableUSDC: pool.availableUSDC, lastDistributionAt: stamp };
}
app.get('/api/admin/profit-pool', adminOnly, (_req, res) => res.json({ ok: true, pool: safeProfitPool(), plans: PLANS }));
app.post('/api/admin/profit-pool', adminOnly, async (req, res) => {
  const amount = Number(req.body?.amount);
  const note = String(req.body?.note || '').trim().slice(0, 300);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e8 || round8(amount) !== amount) return res.status(400).json({ ok: false, error: 'Inserisci un importo di profitto valido in USDC.' });
  if (note.length < 5) return res.status(400).json({ ok: false, error: 'Scrivi una nota che identifichi il risultato di trading realizzato.' });
  const p = store.profitPool || (store.profitPool = emptyProfitPool());
  p.availableUSDC = round8(Number(p.availableUSDC || 0) + amount);
  p.totalAddedUSDC = round8(Number(p.totalAddedUSDC || 0) + amount);
  p.contributions = [{ id: newId('pool'), adminId: req.telegramId, amount: round8(amount), note, createdAt: now() }, ...(p.contributions || [])].slice(0, 500);
  await persist();
  audit(req.telegramId, 'realized_trading_profit_added', null, `${amount} USDC · ${note}`);
  res.status(201).json({ ok: true, pool: safeProfitPool(), message: 'Profitto netto registrato nella riserva di distribuzione.' });
});
app.post('/api/admin/profit-pool/distribute', adminOnly, async (req, res) => {
  const result = await distributeHourlyProfits('admin_manual');
  if (result.reason === 'hourly_window_not_due') return res.status(429).json({ ok: false, error: 'È già stata effettuata una distribuzione nell’ultima ora.', ...result });
  if (result.reason === 'profit_pool_empty') return res.status(409).json({ ok: false, error: 'La riserva è vuota. Registra prima il profitto netto effettivamente realizzato.', ...result });
  if (result.reason === 'no_eligible_users') return res.status(409).json({ ok: false, error: 'Nessun utente ha un saldo USDC sufficiente per il proprio piano.', ...result });
  audit(req.telegramId, 'profit_pool_distributed', null, `${result.distributedUSDC} USDC · ${result.usersPaid} utenti`);
  res.json({ ok: true, ...result, pool: safeProfitPool() });
});

app.use((err, _req, res, _next) => {
  console.error('Request error:', err.message);
  if (res.headersSent) return;
  res.status(500).json({ ok: false, error: 'Errore interno. Riprova tra poco.' });
});

ensureStore();
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`AizenTrading V2 API listening on ${PORT}`);
  console.log(`Configured CORS origins: ${ORIGINS.join(', ') || '(all origins; configure FRONTEND_ORIGIN in production)'}`);
  if (!BOT_TOKEN) console.warn('TELEGRAM_BOT_TOKEN not set: Telegram auth will fail until configured.');
  if (ADMIN_IDS.size === 0) console.warn('ADMIN_TELEGRAM_IDS empty: admin dashboard is inaccessible until configured.');
});

// The hourly worker only distributes funds already recorded in the actual-profit pool.
// It never mints an arbitrary balance when the pool is empty.
const profitTimer = setInterval(() => {
  distributeHourlyProfits('scheduled').catch(err => console.error('Hourly profit distribution failed:', err.message));
}, HOUR_MS);
profitTimer.unref?.();

async function startTelegramBot() {
  if (!BOT_TOKEN || String(process.env.POLLING_BOT || 'true').toLowerCase() === 'false') return;
  try {
    const { Telegraf, Markup } = require('telegraf');
    const bot = new Telegraf(BOT_TOKEN);
    const appUrl = MINI_APP_URL;
    bot.start(async ctx => {
      if (!appUrl || !/^https:\/\//i.test(appUrl)) return ctx.reply('AizenTrading è in fase di configurazione. Riprova tra poco.');
      return ctx.reply('Benvenuto in AizenTrading. Apri la Mini App per consultare piani, Academy, saldo e richieste.', Markup.inlineKeyboard([[Markup.button.webApp('Apri AizenTrading', appUrl)]]));
    });
    bot.command('admin', async ctx => {
      if (!ADMIN_IDS.has(String(ctx.from?.id))) return ctx.reply('Comando disponibile agli amministratori autorizzati.');
      if (!appUrl || !/^https:\/\//i.test(appUrl)) return ctx.reply('Configura MINI_APP_URL su Render.');
      const adminUrl = new URL('admin.html', appUrl.endsWith('/') ? appUrl : `${appUrl}/`).toString();
      return ctx.reply('Pannello amministratore AizenTrading', Markup.inlineKeyboard([[Markup.button.webApp('Apri pannello admin', adminUrl)]]));
    });
    bot.catch(err => console.error('Telegram bot error:', err.message));
    // This project uses long polling. Stop older bot instances before deploying to avoid Telegram 409 conflicts.
    await bot.telegram.deleteWebhook({ drop_pending_updates: false });
    await bot.launch();
    console.log('Telegram bot polling started.');
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
  } catch (e) {
    console.error('Telegram bot could not start. API remains available:', e.message);
  }
}
startTelegramBot();
