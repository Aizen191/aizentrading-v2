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

let store = { users: {}, requests: [], audit: [] };
let writeQueue = Promise.resolve();
function ensureStore() {
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    if (fs.existsSync(DB_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      store = { users: parsed.users || {}, requests: parsed.requests || [], audit: parsed.audit || [] };
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
const publicUser = u => ({ id: u.id, firstName: u.firstName, lastName: u.lastName, username: u.username, languageCode: u.languageCode, createdAt: u.createdAt, lastSeenAt: u.lastSeenAt, balances: u.balances, reserved: u.reserved });
function newId(prefix) { return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`; }
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
      balances: { USDC: 0, SOL: 0, BTC: 0 }, reserved: { USDC: 0, SOL: 0, BTC: 0 }, activePlan: 'Starter'
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
  res.json({ ok: true, depositAddresses, depositMinUsd: 50, depositAsset: 'USDC', assets: Object.fromEntries(Object.entries(ASSETS).map(([k, v]) => [k, { label: v.label, network: v.network }])), status: 'online' });
});
app.use('/api', auth);
app.get('/api/me', (req, res) => res.json({ ok: true, user: publicUser(req.appUser), isAdmin: ADMIN_IDS.has(req.telegramId) }));
app.get('/api/transactions', (req, res) => {
  const items = store.requests.filter(r => r.userId === req.telegramId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ ok: true, requests: items });
});
app.post('/api/plan', async (req, res) => {
  const allowed = ['Starter', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Royal'];
  const plan = String(req.body?.plan || '');
  if (!allowed.includes(plan)) return res.status(400).json({ ok: false, error: 'Piano non valido.' });
  req.appUser.activePlan = plan;
  await persist();
  audit(req.telegramId, 'plan_selected', null, plan);
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
    item.status = 'verified';
  } else if (item.type === 'withdrawal' && action === 'paid') {
    target.reserved[item.asset] = round8(Math.max(0, (target.reserved[item.asset] || 0) - item.amount));
    item.status = 'paid';
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
