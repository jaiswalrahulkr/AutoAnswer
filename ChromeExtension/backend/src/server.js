import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import jwt from 'jsonwebtoken';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { getDb, ensureTables, withTransaction } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataPath = path.join(__dirname, '..', 'store.json');

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';
const RAZORPAY_UPI_ONLY = String(process.env.RAZORPAY_UPI_ONLY || '').toLowerCase() === 'true';
const ADMIN_EMAILS = ['qaefp43@gmail.com'];

function readStore() {
  if (!fs.existsSync(dataPath)) {
    const initial = { users: [], usage: [], payments: [], creditAdjustments: [], webhookEvents: [] };
    fs.writeFileSync(dataPath, JSON.stringify(initial, null, 2));
  }
  return JSON.parse(fs.readFileSync(dataPath, 'utf8'));
}

function writeStore(store) {
  fs.writeFileSync(dataPath, JSON.stringify(store, null, 2));
}

// Ensure stored users have admin flag aligned with ADMIN_EMAILS on startup
function syncAdminFlags() {
  try {
    const store = readStore();
    let changed = false;
    for (const u of store.users) {
      const shouldBeAdmin = ADMIN_EMAILS.includes(String(u.email || '').toLowerCase());
      if (shouldBeAdmin && !u.isAdmin) { u.isAdmin = true; changed = true; }
    }
    if (changed) writeStore(store);
  } catch (_) {}
}

function formatIstTimestamp(ms) {
  try {
    const dtf = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    });
    const parts = Object.fromEntries(dtf.formatToParts(new Date(ms)).map(p => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} IST`;
  } catch (_) {
    return new Date(ms).toISOString();
  }
}

function findUserByGoogleSub(store, sub) {
  return store.users.find(u => u.googleSub === sub);
}

function getUserById(store, id) {
  return store.users.find(u => u.id === id);
}

function upsertUserFromGoogle(store, profile) {
  let user = findUserByGoogleSub(store, profile.sub);
  if (!user) {
    user = {
      id: uuidv4(),
      googleSub: profile.sub,
      email: profile.email,
      name: profile.name || '',
      picture: profile.picture || '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      creditsBalance: 10,
      isAdmin: ADMIN_EMAILS.includes(String(profile.email || '').toLowerCase())
    };
    store.users.push(user);
  } else {
    user.email = profile.email;
    user.name = profile.name || user.name;
    user.picture = profile.picture || user.picture;
    user.updatedAt = new Date().toISOString();
    if (ADMIN_EMAILS.includes(String(profile.email || '').toLowerCase())) user.isAdmin = true;
  }
  writeStore(store);
  return user;
}

async function verifyGoogleToken(token) {
  // First, try OIDC userinfo with an access token
  try {
    const resp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (resp.ok) {
      const data = await resp.json();
      return { sub: data.sub, email: data.email, name: data.name, picture: data.picture };
    }
    const txt = await resp.text();
    throw new Error(`userinfo ${resp.status}: ${txt}`);
  } catch (e1) {
    // Fallback: tokeninfo for access_token
    try {
      const resp2 = await fetch(`https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${encodeURIComponent(token)}`);
      if (!resp2.ok) {
        const txt2 = await resp2.text();
        throw new Error(`tokeninfo ${resp2.status}: ${txt2}`);
      }
      const t = await resp2.json();
      // tokeninfo returns user_id and email if scopes include email
      const sub = t.user_id || t.sub || '';
      const email = t.email || '';
      // Try fetch userinfo again to get name/picture (may succeed due to cache)
      let name = '';
      let picture = '';
      try {
        const resp3 = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (resp3.ok) {
          const d3 = await resp3.json();
          name = d3.name || '';
          picture = d3.picture || '';
        }
      } catch (_) {}
      if (!sub && !email) throw new Error('tokeninfo returned no subject/email');
      return { sub, email, name, picture };
    } catch (e2) {
      throw new Error(`Google verify failed: ${String(e1)} | ${String(e2)}`);
    }
  }
}

function issueAccessToken(user) {
  return jwt.sign({ sub: user.id, email: user.email, role: user.isAdmin ? 'admin' : 'user' }, JWT_SECRET, { expiresIn: '1h' });
}

function authMiddleware(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'missing_token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

function adminMiddleware(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  next();
}

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Postgres tables if DATABASE_URL is configured (startup)
let __dbReady = false;
async function initDbIfNeeded() {
  try {
    await ensureTables();
    __dbReady = true;
    console.log('DB ready: tables ensured');
  } catch (e) {
    console.error('DB init failed:', e);
    __dbReady = false;
  }
}

function dbEnabled() { return !!getDb(); }

// For Postgres-only mode: require DATABASE_URL, do not fall back to file store
app.use((req, res, next) => {
  if (!dbEnabled()) {
    return res.status(503).json({ error: 'db_unconfigured', message: 'Set DATABASE_URL to use Postgres' });
  }
  next();
});

// Health check: verify DB connectivity and table presence
app.get('/health', async (_req, res) => {
  try {
    const db = getDb();
    if (!db) return res.status(503).json({ db: false });
    await ensureTables();
    const { rows } = await db.query("SELECT to_regclass('public.users') AS users, to_regclass('public.usage_logs') AS usage_logs, to_regclass('public.payments') AS payments, to_regclass('public.credit_adjustments') AS credit_adjustments");
    return res.json({ db: true, tables: rows[0] });
  } catch (e) {
    return res.status(500).json({ db: true, error: String(e) });
  }
});

async function upsertUserFromGoogleDb(profile) {
  const db = getDb();
  const isAdmin = ADMIN_EMAILS.includes(String(profile.email || '').toLowerCase());
  console.log('Auth: upserting user', { sub: profile.sub, email: profile.email, isAdmin });
  const sql = `
    INSERT INTO users (id, google_sub, email, name, picture, credits_balance, is_admin)
    VALUES ($1, $2, $3, $4, $5, 10, $6)
    ON CONFLICT (google_sub) DO UPDATE SET
      email = EXCLUDED.email,
      name = COALESCE(EXCLUDED.name, users.name),
      picture = COALESCE(EXCLUDED.picture, users.picture),
      is_admin = users.is_admin OR EXCLUDED.is_admin,
      updated_at = now()
    RETURNING id, email, name, picture, credits_balance, is_admin;
  `;
  const id = uuidv4();
  const { rows } = await db.query(sql, [id, profile.sub, profile.email, profile.name || '', profile.picture || '', isAdmin]);
  const row = rows[0];
  console.log('Auth: upserted user OK', { id: row.id, email: row.email, credits: row.credits_balance, isAdmin: row.is_admin });
  return { id: row.id, email: row.email, name: row.name, picture: row.picture, creditsBalance: row.credits_balance, isAdmin: row.is_admin };
}

async function getUserByIdDb(id) {
  const db = getDb();
  const { rows } = await db.query('SELECT id, email, name, picture, credits_balance, is_admin, created_at, updated_at FROM users WHERE id=$1', [id]);
  const u = rows[0];
  if (!u) return null;
  return { id: u.id, email: u.email, name: u.name, picture: u.picture, creditsBalance: u.credits_balance, isAdmin: u.is_admin, createdAt: u.created_at, updatedAt: u.updated_at };
}

app.post('/auth/google', async (req, res) => {
  try {
    const { idToken } = req.body || {};
    if (!idToken) return res.status(400).json({ error: 'missing_id_token' });
    const profile = await verifyGoogleToken(idToken);
    console.log('Auth: Google profile', { sub: profile.sub, email: profile.email });
    let user;
    if (dbEnabled()) {
      user = await upsertUserFromGoogleDb(profile);
    } else {
      const store = readStore();
      user = upsertUserFromGoogle(store, profile);
    }
    const sessionToken = issueAccessToken(user);
    return res.json({ sessionToken, user: { id: user.id, email: user.email, name: user.name, creditsBalance: user.creditsBalance, isAdmin: !!user.isAdmin } });
  } catch (e) {
    console.error('Auth: failed', e);
    return res.status(401).json({ error: 'auth_failed', details: String(e) });
  }
});

app.get('/user/me', authMiddleware, async (req, res) => {
  if (dbEnabled()) {
    const user = await getUserByIdDb(req.user.sub);
    if (!user) return res.status(404).json({ error: 'not_found' });
    return res.json(user);
  } else {
    const store = readStore();
    const user = getUserById(store, req.user.sub);
    if (!user) return res.status(404).json({ error: 'not_found' });
    return res.json({ id: user.id, email: user.email, name: user.name, creditsBalance: user.creditsBalance, picture: user.picture, isAdmin: !!user.isAdmin });
  }
});

app.post('/usage/log', authMiddleware, async (req, res) => {
  const { actionType = 'autofill', requestId = uuidv4(), pageUrl = '' } = req.body || {};
  if (dbEnabled()) {
    try {
      const result = await withTransaction(async (tx) => {
        // Atomic decrement if > 0
        const dec = await tx.query(
          'UPDATE users SET credits_balance = credits_balance - 1, updated_at = now() WHERE id=$1 AND credits_balance > 0 RETURNING credits_balance',
          [req.user.sub]
        );
        if (dec.rowCount === 0) return { ok: false };
        const remaining = dec.rows[0].credits_balance;
        const nowMs = Date.now();
        await tx.query(
          'INSERT INTO usage_logs (id, user_id, timestamp_ms, timestamp_iso, timestamp_ist, page_url, action_type, delta, request_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (request_id) DO NOTHING',
          [uuidv4(), req.user.sub, nowMs, new Date(nowMs).toISOString(), formatIstTimestamp(nowMs), pageUrl, actionType, -1, requestId]
        );
        return { ok: true, remaining };
      });
      if (!result.ok) return res.status(422).json({ error: 'no_credits' });
      console.log('Usage: logged', { userId: req.user.sub, remaining: result.remaining, actionType, pageUrl });
      return res.json({ ok: true, remaining: result.remaining });
    } catch (e) {
      console.error('Usage: db_error', e);
      return res.status(500).json({ error: 'db_error' });
    }
  } else {
    const store = readStore();
    const user = getUserById(store, req.user.sub);
    if (!user) return res.status(404).json({ error: 'not_found' });
    if (typeof user.creditsBalance !== 'number' || user.creditsBalance <= 0) {
      return res.status(422).json({ error: 'no_credits' });
    }
    const exists = store.usage.find(u => u.requestId === requestId);
    if (exists) return res.json({ ok: true, remaining: user.creditsBalance });
    user.creditsBalance = Math.max(0, (user.creditsBalance || 0) - 1);
    const nowMs = Date.now();
    store.usage.push({
      id: uuidv4(),
      userId: user.id,
      timestamp: nowMs,
      timestampIso: new Date(nowMs).toISOString(),
      timestampIst: formatIstTimestamp(nowMs),
      pageUrl,
      actionType,
      delta: -1,
      requestId
    });
    writeStore(store);
    return res.json({ ok: true, remaining: user.creditsBalance });
  }
});

const PACKS = {
  pack_small: { id: 'pack_small', priceInr: 200, credits: 50 },
  pack_large: { id: 'pack_large', priceInr: 500, credits: 200 }
};

app.post('/payment/initiate', authMiddleware, async (req, res) => {
  const { packId } = req.body || {};
  const pack = PACKS[packId];
  if (!pack) return res.status(400).json({ error: 'invalid_pack' });
  if (!STRIPE_SECRET_KEY) {
    // If Razorpay is configured, prefer Payment Links
    if (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) {
      try {
        const Razorpay = (await import('razorpay')).default;
        const rzp = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });
        const payload = {
          amount: pack.priceInr * 100,
          currency: 'INR',
          description: `${pack.credits} Autofill Credits`,
          notes: { userId: req.user.sub, packId: pack.id },
          reminder_enable: true
        };
        if (RAZORPAY_UPI_ONLY) payload.upi_link = true;
        const link = await rzp.paymentLink.create(payload);
        return res.json({ checkoutUrl: link.short_url });
      } catch (e) {
        return res.status(500).json({ error: 'razorpay_error', details: String(e) });
      }
    }
    // Fallback: stub URL when neither Stripe nor Razorpay configured
    const checkoutUrl = `https://example.com/checkout/simulated?pack=${pack.id}&user=${encodeURIComponent(req.user.sub)}`;
    return res.json({ checkoutUrl });
  }
  try {
    const stripe = (await import('stripe')).default(STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      success_url: `http://localhost:${PORT}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `http://localhost:${PORT}/payment/cancel`,
      line_items: [
        {
          price_data: {
            currency: 'inr',
            product_data: { name: `${pack.credits} Autofill Credits` },
            unit_amount: pack.priceInr * 100
          },
          quantity: 1
        }
      ],
      metadata: { userId: req.user.sub, packId: pack.id }
    });
    return res.json({ checkoutUrl: session.url });
  } catch (e) {
    return res.status(500).json({ error: 'stripe_error', details: String(e) });
  }
});

app.post('/payment/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const store = readStore();
  if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET) {
    // Allow stub POSTs for local testing
    try {
      const payload = JSON.parse(req.body.toString('utf8'));
      const { type, userId, packId, eventId } = payload || {};
      if (!eventId) return res.status(400).json({ error: 'missing_event' });
      if (store.webhookEvents.includes(eventId)) return res.json({ ok: true });
      store.webhookEvents.push(eventId);
      if (type === 'payment.succeeded') {
        const user = getUserById(store, userId);
        const pack = PACKS[packId];
        if (user && pack) {
          user.creditsBalance = (user.creditsBalance || 0) + pack.credits;
          store.creditAdjustments.push({ id: uuidv4(), userId: user.id, delta: pack.credits, reason: `payment:${pack.id}`, createdAt: new Date().toISOString() });
          store.payments.push({ id: uuidv4(), userId: user.id, provider: 'stub', amount: pack.priceInr, currency: 'INR', packId: pack.id, status: 'succeeded', createdAt: new Date().toISOString() });
          writeStore(store);
        }
      }
      return res.json({ ok: true });
    } catch (e) {
      return res.status(400).json({ error: 'invalid_stub_webhook' });
    }
  }
  try {
    const stripe = (await import('stripe')).default(STRIPE_SECRET_KEY);
    const sig = req.headers['stripe-signature'];
    const event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.metadata?.userId;
      const packId = session.metadata?.packId;
      if (userId && packId) {
        if (store.webhookEvents.includes(event.id)) return res.json({ ok: true });
        store.webhookEvents.push(event.id);
        if (dbEnabled()) {
          await withTransaction(async (tx) => {
            const pack = PACKS[packId];
            await tx.query('UPDATE users SET credits_balance = credits_balance + $2, updated_at = now() WHERE id=$1', [userId, pack.credits]);
            await tx.query('INSERT INTO credit_adjustments (id, user_id, delta, reason) VALUES ($1,$2,$3,$4)', [uuidv4(), userId, pack.credits, `payment:${pack.id}`]);
            await tx.query('INSERT INTO payments (id, user_id, provider, amount, currency, pack_id, status, provider_ref) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (provider_ref) DO NOTHING', [uuidv4(), userId, 'stripe', pack.priceInr, 'INR', pack.id, 'succeeded', session.id]);
          });
        } else {
          const user = getUserById(store, userId);
          const pack = PACKS[packId];
          if (user && pack) {
            user.creditsBalance = (user.creditsBalance || 0) + pack.credits;
            store.creditAdjustments.push({ id: uuidv4(), userId: user.id, delta: pack.credits, reason: `payment:${pack.id}`, createdAt: new Date().toISOString() });
            store.payments.push({ id: uuidv4(), userId: user.id, provider: 'stripe', amount: pack.priceInr, currency: 'INR', packId: pack.id, status: 'succeeded', createdAt: new Date().toISOString(), providerRef: session.id });
            writeStore(store);
          }
        }
      }
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(400).send(`Webhook Error: ${e.message}`);
  }
});

// Razorpay webhook: verify signature and credit user
app.post('/payment/razorpay/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!RAZORPAY_WEBHOOK_SECRET) return res.status(501).json({ error: 'webhook_unconfigured' });
  try {
    const signature = req.headers['x-razorpay-signature'];
    const bodyBuf = req.body; // Buffer
    const raw = bodyBuf.toString('utf8');
    const crypto = (await import('crypto')).default;
    const expected = crypto.createHmac('sha256', RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex');
    if (expected !== signature) return res.status(400).json({ error: 'invalid_signature' });
    const event = JSON.parse(raw);
    const type = event?.event;
    const notes = event?.payload?.payment?.entity?.notes || event?.payload?.order?.entity?.notes || {};
    const userId = notes.userId;
    const packId = notes.packId;
    if (type === 'payment.captured' && userId && packId) {
      const pack = PACKS[packId];
      if (pack && dbEnabled()) {
        await withTransaction(async (tx) => {
          await tx.query('UPDATE users SET credits_balance = credits_balance + $2, updated_at = now() WHERE id=$1', [userId, pack.credits]);
          await tx.query('INSERT INTO credit_adjustments (id, user_id, delta, reason) VALUES ($1,$2,$3,$4)', [uuidv4(), userId, pack.credits, `payment:${pack.id}`]);
          const providerRef = event?.payload?.payment?.entity?.id || event?.payload?.order?.entity?.id || null;
          await tx.query('INSERT INTO payments (id, user_id, provider, amount, currency, pack_id, status, provider_ref) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (provider_ref) DO NOTHING', [uuidv4(), userId, 'razorpay', pack.priceInr, 'INR', pack.id, 'succeeded', providerRef]);
        });
      }
    }
    return res.json({ ok: true });
  } catch (e) {
    return res.status(400).json({ error: 'invalid_webhook', details: String(e) });
  }
});

app.post('/admin/credits', authMiddleware, adminMiddleware, (req, res) => {
  const { userId, delta, reason = 'manual' } = req.body || {};
  if (!userId || typeof delta !== 'number') return res.status(400).json({ error: 'bad_request' });
  if (dbEnabled()) {
    return withTransaction(async (tx) => {
      const upd = await tx.query('UPDATE users SET credits_balance = credits_balance + $2, updated_at = now() WHERE id=$1 RETURNING credits_balance', [userId, delta]);
      if (upd.rowCount === 0) return res.status(404).json({ error: 'not_found' });
      await tx.query('INSERT INTO credit_adjustments (id, user_id, delta, reason, admin_id) VALUES ($1,$2,$3,$4,$5)', [uuidv4(), userId, delta, reason, req.user.sub]);
      return res.json({ newBalance: upd.rows[0].credits_balance });
    }).catch(() => res.status(500).json({ error: 'db_error' }));
  } else {
    const store = readStore();
    const user = getUserById(store, userId);
    if (!user) return res.status(404).json({ error: 'not_found' });
    user.creditsBalance = (user.creditsBalance || 0) + delta;
    store.creditAdjustments.push({ id: uuidv4(), userId: user.id, delta, reason, adminId: req.user.sub, createdAt: new Date().toISOString() });
    writeStore(store);
    return res.json({ newBalance: user.creditsBalance });
  }
});

// Admin: list users
app.get('/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  const { q = '' } = req.query || {};
  const query = String(q).toLowerCase();
  if (dbEnabled()) {
    const db = getDb();
    const { rows } = await db.query(
      `SELECT id, email, name, credits_balance, created_at, updated_at
       FROM users
       WHERE ($1 = '' OR LOWER(email) LIKE '%'||$1||'%' OR LOWER(name) LIKE '%'||$1||'%')
       ORDER BY created_at DESC
       LIMIT 200`,
      [query]
    );
    const users = rows.map(r => ({ id: r.id, email: r.email, name: r.name, creditsBalance: r.credits_balance, createdAt: r.created_at, updatedAt: r.updated_at }));
    return res.json({ users });
  } else {
    const store = readStore();
    const users = store.users
      .filter(u => !query || (String(u.email).toLowerCase().includes(query) || String(u.name).toLowerCase().includes(query)))
      .slice(0, 200)
      .map(u => ({ id: u.id, email: u.email, name: u.name, creditsBalance: u.creditsBalance, createdAt: u.createdAt, updatedAt: u.updatedAt }));
    res.json({ users });
  }
});

// Admin: user details
app.get('/admin/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  if (dbEnabled()) {
    const db = getDb();
    const { rows: ur } = await db.query('SELECT id, email, name, credits_balance, created_at, updated_at FROM users WHERE id=$1', [req.params.id]);
    const u = ur[0];
    if (!u) return res.status(404).json({ error: 'not_found' });
    const { rows: usage } = await db.query('SELECT timestamp_ms AS timestamp, timestamp_iso, timestamp_ist, page_url AS pageUrl, action_type AS actionType, delta, request_id AS requestId FROM usage_logs WHERE user_id=$1 ORDER BY timestamp_ms DESC LIMIT 200', [req.params.id]);
    const { rows: payments } = await db.query('SELECT id, provider, amount, currency, pack_id AS packId, status, provider_ref AS providerRef, created_at AS createdAt FROM payments WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200', [req.params.id]);
    const { rows: adjustments } = await db.query('SELECT id, delta, reason, admin_id AS adminId, created_at AS createdAt FROM credit_adjustments WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200', [req.params.id]);
    return res.json({ user: { id: u.id, email: u.email, name: u.name, creditsBalance: u.credits_balance, createdAt: u.created_at, updatedAt: u.updated_at }, usage, payments, adjustments });
  } else {
    const store = readStore();
    const user = getUserById(store, req.params.id);
    if (!user) return res.status(404).json({ error: 'not_found' });
    const usage = store.usage.filter(u => u.userId === user.id).slice(-200).reverse();
    const payments = store.payments.filter(p => p.userId === user.id).slice(-200).reverse();
    const adjustments = store.creditAdjustments.filter(c => c.userId === user.id).slice(-200).reverse();
    res.json({ user: { id: user.id, email: user.email, name: user.name, creditsBalance: user.creditsBalance, createdAt: user.createdAt, updatedAt: user.updatedAt }, usage, payments, adjustments });
  }
});

// Lightweight admin UI
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Admin: migrate usage timestamps to include ISO/IST
app.post('/admin/migrate/usage-timestamps', authMiddleware, adminMiddleware, (req, res) => {
  const store = readStore();
  let updated = 0;
  for (const u of store.usage) {
    const ms = typeof u.timestamp === 'number' ? u.timestamp : Number(u.timestamp);
    if (!Number.isFinite(ms)) continue;
    if (!u.timestampIso) { u.timestampIso = new Date(ms).toISOString(); updated++; }
    if (!u.timestampIst) { u.timestampIst = formatIstTimestamp(ms); updated++; }
  }
  if (updated > 0) writeStore(store);
  res.json({ ok: true, updated });
});

// Start server after DB init to avoid race conditions on first request
(async () => {
  await initDbIfNeeded();
  app.listen(PORT, () => {
    console.log(`Backend listening on http://localhost:${PORT}`);
  });
})();


