'use strict';
/* ============================================================================
   La Familia : API (une seule fonction Vercel)
   - Base de données : Turso (SQLite hébergé) via les variables TURSO_DATABASE_URL et TURSO_AUTH_TOKEN.
     Sans ces variables (essais sur un ordinateur), un fichier SQLite local est utilisé.
   - Comptes : nom d'utilisateur + mot de passe haché (scrypt), rôles gestionnaire / lecture seule
   - Variable SETUP_CODE : code d'installation exigé pour créer le premier compte à distance
   ============================================================================ */
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const Lending = require('../public/lending.js'); // règles de calcul partagées avec l'application

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

/* ------------------------------------------------------------ Utilitaires -- */
const pad = n => String(n).padStart(2, '0');
const isoD = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseD = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseD(s); d.setDate(d.getDate() + n); return isoD(d); };
const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const nowIso = () => new Date().toISOString();
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const isDate = s => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d && y >= 2000 && y <= 2100;
};
const amount = (v, label) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1e12) throw new HttpError(400, `${label} invalide`);
  return round2(n);
};
const safeEq = (a, b) => {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};
const validTz = tz => { try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return true; } catch { return false; } };

const DEFAULT_SETTINGS = { company: 'La Familia', currency: '$', defaultRate: 20, timezone: 'UTC' }; // defaultRate : taux mensuel (% du capital par mois)
function today(settings) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: settings.timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  catch { return isoD(new Date()); }
}

/* ---------------------------------------------------------- Base de données -- */
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  `CREATE TABLE IF NOT EXISTS users (
    key TEXT PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin','owner')),
    salt TEXT NOT NULL, hash TEXT NOT NULL, token_version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`,
  'CREATE TABLE IF NOT EXISTS login_fails (ip TEXT PRIMARY KEY, n INTEGER NOT NULL, until INTEGER NOT NULL)',
  `CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '',
    id_number TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS loans (
    id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id),
    principal REAL NOT NULL CHECK (principal > 0), rate REAL NOT NULL, start_date TEXT NOT NULL,
    guarantee TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', written_off_date TEXT, created_at TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS loans_client ON loans(client_id)',
  `CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY, loan_id TEXT NOT NULL REFERENCES loans(id),
    date TEXT NOT NULL, amount REAL NOT NULL CHECK (amount > 0), note TEXT NOT NULL DEFAULT '')`,
  'CREATE INDEX IF NOT EXISTS payments_loan ON payments(loan_id)',
  `CREATE TABLE IF NOT EXISTS loan_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, loan_id TEXT NOT NULL REFERENCES loans(id),
    ts TEXT NOT NULL, text TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'event', by TEXT)`,
  'CREATE INDEX IF NOT EXISTS history_loan ON loan_history(loan_id)',
  `CREATE TABLE IF NOT EXISTS expenses (
    id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK (type IN ('depense','retrait','apport')),
    date TEXT NOT NULL, amount REAL NOT NULL CHECK (amount > 0), category TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`,
  'CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, text TEXT NOT NULL, loan_id TEXT, by TEXT)'
];

// Interface commune aux deux moteurs : all / get / run / many (lectures groupées) / batch (écritures groupées) / tx (transaction)
function libsqlAdapter(url, authToken) {
  const { createClient } = require('@libsql/client/web');
  const client = createClient({ url: url.replace(/^libsql:/, 'https:'), authToken }); // transport HTTP, adapté aux fonctions Vercel
  const norm = (sql, args = []) => ({ sql, args: args.map(a => (a === undefined ? null : a)) });
  const toRows = r => r.rows.map(row => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
  const api = ex => {
    const all = async (sql, args) => toRows(await ex.execute(norm(sql, args)));
    return {
      all,
      get: async (sql, args) => (await all(sql, args))[0],
      run: async (sql, args) => ({ changes: Number((await ex.execute(norm(sql, args))).rowsAffected) })
    };
  };
  return {
    ...api(client),
    many: async list => (await client.batch(list.map(s => norm(s.sql, s.args)), 'read')).map(toRows),
    batch: async list => { await client.batch(list.map(s => (typeof s === 'string' ? norm(s) : norm(s.sql, s.args))), 'write'); },
    tx: async fn => {
      const t = await client.transaction('write');
      try { const out = await fn(api(t)); await t.commit(); return out; }
      catch (e) { try { await t.rollback(); } catch { /* déjà annulée */ } throw e; }
      finally { t.close(); }
    }
  };
}

function localAdapter(dir) {
  process.emitWarning = ((orig) => (w, ...a) => (String((w && w.message) || w).includes('SQLite') ? undefined : orig.call(process, w, ...a)))(process.emitWarning);
  const sqliteModule = 'node:sqlite'; // chargé seulement pour les essais locaux (nom volontairement non détectable par les outils d'empaquetage)
  const { DatabaseSync } = require(sqliteModule);
  require('fs').mkdirSync(dir, { recursive: true });
  const s = new DatabaseSync(path.join(dir, 'lafamilia.db'));
  s.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  const api = {
    all: async (sql, args = []) => s.prepare(sql).all(...args).map(r => ({ ...r })),
    get: async (sql, args = []) => { const r = s.prepare(sql).get(...args); return r ? { ...r } : undefined; },
    run: async (sql, args = []) => ({ changes: Number(s.prepare(sql).run(...args).changes) })
  };
  let chain = Promise.resolve(); // une seule transaction à la fois
  const inTx = fn => { const p = chain.then(async () => { s.exec('BEGIN IMMEDIATE'); try { const out = await fn(); s.exec('COMMIT'); return out; } catch (e) { try { s.exec('ROLLBACK'); } catch { /* déjà annulée */ } throw e; } }); chain = p.catch(() => {}); return p; };
  return {
    ...api,
    many: async list => Promise.all(list.map(x => api.all(x.sql, x.args))),
    batch: list => inTx(async () => { for (const x of list) { if (typeof x === 'string') s.exec(x); else s.prepare(x.sql).run(...(x.args || [])); } }),
    tx: fn => inTx(() => fn(api))
  };
}

let dbPromise = null;
function getDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const url = process.env.TURSO_DATABASE_URL;
      const db = url ? libsqlAdapter(url, process.env.TURSO_AUTH_TOKEN) : localAdapter(path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data')));
      await db.batch(SCHEMA);
      return db;
    })().catch(e => { dbPromise = null; throw e; });
  }
  return dbPromise;
}

/* --- Réglages, compteurs, journal --- */
const SETTINGS_SQL = "INSERT INTO kv(key, value) VALUES('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value";
const setSettings = (t, s) => t.run(SETTINGS_SQL, [JSON.stringify(s)]);
const bump = t => t.run("INSERT INTO kv(key, value) VALUES('rev', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1");
async function nextId(t, kind, prefix, width = 4) {
  await t.run("INSERT INTO kv(key, value) VALUES(?, '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1", ['seq_' + kind]);
  const r = await t.get('SELECT value FROM kv WHERE key = ?', ['seq_' + kind]);
  return `${prefix}-${String(Number(r.value)).padStart(width, '0')}`;
}
async function logGlobal(t, who, text, loanId) {
  await t.run('INSERT INTO log(ts, text, loan_id, by) VALUES(?, ?, ?, ?)', [nowIso(), text, loanId || null, who ? who.username : null]);
  await t.run('DELETE FROM log WHERE id <= (SELECT MAX(id) FROM log) - 3000');
}
async function note(t, who, loanId, text, kind = 'event') {
  await t.run('INSERT INTO loan_history(loan_id, ts, text, kind, by) VALUES(?, ?, ?, ?, ?)', [loanId, nowIso(), text, kind, who ? who.username : null]);
  await logGlobal(t, who, `${loanId} : ${text}`, loanId);
}
const mutate = (db, fn) => db.tx(async t => { const out = await fn(t); await bump(t); return out; });

/* --- Lecture complète, dans la forme attendue par l'interface --- */
async function snapshot(db, settings, logLimit = 120) {
  const [revRows, cl, ln, py, hs, ex, lg] = await db.many([
    { sql: "SELECT value FROM kv WHERE key = 'rev'" },
    { sql: 'SELECT * FROM clients ORDER BY rowid' },
    { sql: 'SELECT * FROM loans ORDER BY rowid' },
    { sql: 'SELECT * FROM payments ORDER BY rowid' },
    { sql: 'SELECT * FROM loan_history ORDER BY id' },
    { sql: 'SELECT * FROM expenses ORDER BY rowid' },
    { sql: 'SELECT * FROM (SELECT * FROM log ORDER BY id DESC LIMIT ?) ORDER BY id', args: [logLimit] }
  ]);
  const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  const pays = new Map(), hist = new Map();
  for (const p of py) push(pays, p.loan_id, { id: p.id, date: p.date, amount: p.amount, note: p.note });
  for (const h of hs) push(hist, h.loan_id, { ts: h.ts, text: h.text, kind: h.kind, by: h.by });
  return {
    rev: revRows[0] ? Number(revRows[0].value) : 0,
    settings,
    clients: cl.map(c => ({ id: c.id, name: c.name, phone: c.phone, address: c.address, idNumber: c.id_number, notes: c.notes, createdAt: c.created_at })),
    loans: ln.map(l => ({
      id: l.id, clientId: l.client_id, principal: l.principal, rate: l.rate, startDate: l.start_date,
      guarantee: l.guarantee, notes: l.notes, payments: pays.get(l.id) || [],
      writtenOff: l.written_off_date ? { date: l.written_off_date } : null, history: hist.get(l.id) || [], createdAt: l.created_at
    })),
    expenses: ex.map(e => ({ id: e.id, type: e.type, date: e.date, amount: e.amount, category: e.category, description: e.description, createdAt: e.created_at })),
    log: lg.map(l => ({ ts: l.ts, text: l.text, loanId: l.loan_id, by: l.by }))
  };
}

/* ------------------------------------------------------------------- Auth -- */
const rowUser = r => r ? { key: r.key, username: r.username, role: r.role, salt: r.salt, hash: r.hash, tokenVersion: Number(r.token_version), createdAt: r.created_at } : null;
const userKey = name => String(name || '').trim().toLowerCase();
const findUser = async (x, name) => rowUser(await x.get('SELECT * FROM users WHERE key = ?', [userKey(name)]));
const countUsers = async x => Number((await x.get('SELECT COUNT(*) AS n FROM users')).n);
const pubUser = u => ({ username: u.username, role: u.role, createdAt: u.createdAt });

const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 64).toString('hex');
const DUMMY = { salt: '00'.repeat(16), hash: '00'.repeat(64) };
const verifyPw = (u, pw) => safeEq(hashPw(pw, u.salt), u.hash);
const USER_RE = /^[\p{L}\p{N}._-]{3,30}$/u;
function checkPw(pw) {
  if (String(pw).length < 8) throw new HttpError(400, 'Le mot de passe doit contenir au moins 8 caractères');
  if (String(pw).length > 200) throw new HttpError(400, 'Mot de passe trop long');
}
function cleanCreds(body) {
  const username = str(body.username, 60), password = String(body.password ?? '');
  if (!USER_RE.test(username)) throw new HttpError(400, "Nom d'utilisateur : 3 à 30 caractères (lettres, chiffres, point, tiret ou tiret bas, sans espace)");
  checkPw(password);
  return { username, password };
}
async function insertUser(t, username, password, role) {
  const salt = crypto.randomBytes(16).toString('hex');
  await t.run('INSERT INTO users(key, username, role, salt, hash, token_version, created_at) VALUES(?,?,?,?,?,0,?)', [userKey(username), username, role, salt, hashPw(password, salt), nowIso()]);
}
async function changePw(t, u, pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  await t.run('UPDATE users SET salt = ?, hash = ?, token_version = token_version + 1 WHERE key = ?', [salt, hashPw(pw, salt), u.key]);
}

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (secret, p) => crypto.createHmac('sha256', secret).update(p).digest('base64url');
const makeToken = (secret, u) => { const p = b64({ u: u.key, v: u.tokenVersion, e: Date.now() + 30 * 864e5 }); return `${p}.${sign(secret, p)}`; };
function tokenClaim(t) { // lecture du contenu (non vérifié) pour savoir quel compte charger ; la signature est vérifiée ensuite
  try { const d = JSON.parse(Buffer.from(String(t || '').split('.')[0], 'base64url').toString('utf8')); return d && typeof d.u === 'string' ? d.u : null; } catch { return null; }
}
function verifyToken(secret, t, userRow) {
  const parts = String(t || '').split('.');
  if (parts.length !== 2 || !safeEq(parts[1], sign(secret, parts[0]))) return null;
  let d; try { d = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { return null; }
  const u = rowUser(userRow);
  if (!d || Date.now() > d.e || !u || u.key !== d.u || u.tokenVersion !== d.v) return null; // changer un mot de passe ou supprimer un compte ferme ses sessions
  return u;
}

const PROXY_HEADERS = ['x-forwarded-for', 'x-real-ip', 'forwarded', 'cf-connecting-ip', 'cf-ray', 'x-vercel-id', 'x-nf-request-id', 'x-nf-client-connection-ip'];
const viaProxy = req => PROXY_HEADERS.some(h => req.headers[h]);
const ownIPs = () => new Set(Object.values(os.networkInterfaces()).flat().filter(Boolean).map(i => i.address));
function isLocalReq(req) { // requête venant de l'ordinateur lui-même, sans intermédiaire (essais locaux)
  const a = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
  return (a === '127.0.0.1' || a === '::1' || ownIPs().has(a)) && !viaProxy(req);
}
const ipOf = req => String(req.headers['x-nf-client-connection-ip'] || req.headers['x-vercel-forwarded-for'] || req.headers['x-real-ip'] || req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] || (req.socket && req.socket.remoteAddress) || '?').trim();

// Limitation des essais de connexion, conservée en base (une fonction serverless n'a pas de mémoire partagée)
async function throttled(db, ip) {
  const f = await db.get('SELECT n, until FROM login_fails WHERE ip = ?', [ip]);
  if (!f || Number(f.n) < 8) return false;
  if (Date.now() >= Number(f.until)) { await db.run('DELETE FROM login_fails WHERE ip = ?', [ip]); return false; }
  return true;
}
async function recordFail(db, ip) {
  const f = await db.get('SELECT n FROM login_fails WHERE ip = ?', [ip]);
  const n = (f ? Number(f.n) : 0) + 1;
  await db.run('INSERT INTO login_fails(ip, n, until) VALUES(?,?,?) ON CONFLICT(ip) DO UPDATE SET n = excluded.n, until = excluded.until', [ip, n, n >= 8 ? Date.now() + 10 * 60e3 : 0]);
}

/* ----------------------------------------------------------------- Routes -- */
const routes = [];
const add = (method, pattern, role, fn) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:[a-z]+/gi, m => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, role, fn });
};

add('GET', '/api/status', null, async c => ({ needsSetup: (await countUsers(c.db)) === 0, setupCodeRequired: !isLocalReq(c.req) }));

add('POST', '/api/setup', null, async ({ db, cfg, req, body }) => {
  const ip = ipOf(req);
  if (await countUsers(db)) throw new HttpError(409, 'Le compte gestionnaire existe déjà. Connectez-vous.');
  if (await throttled(db, ip)) throw new HttpError(429, 'Trop de tentatives. Réessayez dans 10 minutes.');
  if (!isLocalReq(req)) {
    const expected = process.env.SETUP_CODE;
    if (!expected) throw new HttpError(403, "Le code d'installation n'est pas configuré sur l'hébergement (variable SETUP_CODE).");
    const given = str(body.setupCode, 100);
    if (!given) throw new HttpError(403, "Le code d'installation est requis.");
    if (!safeEq(given, expected)) { await recordFail(db, ip); throw new HttpError(403, "Code d'installation incorrect."); }
  }
  const { username, password } = cleanCreds(body);
  const user = await db.tx(async t => {
    if (await countUsers(t)) throw new HttpError(409, 'Le compte gestionnaire existe déjà. Connectez-vous.');
    await insertUser(t, username, password, 'admin');
    const tz = str(body.timezone, 60);
    if (tz && validTz(tz)) await setSettings(t, { ...cfg.settings, timezone: tz });
    await logGlobal(t, { username }, 'Compte gestionnaire créé');
    await bump(t);
    return findUser(t, username);
  });
  return { token: makeToken(cfg.secret, user), role: user.role, username: user.username };
});

add('POST', '/api/login', null, async ({ db, cfg, req, body }) => {
  const ip = ipOf(req);
  if (await throttled(db, ip)) throw new HttpError(429, 'Trop de tentatives. Réessayez dans 10 minutes.');
  const u = await findUser(db, body.username);
  const ok = verifyPw(u || DUMMY, String(body.password ?? '').slice(0, 200)) && !!u; // même calcul si le compte n'existe pas
  if (!ok) { await recordFail(db, ip); throw new HttpError(401, "Nom d'utilisateur ou mot de passe incorrect"); }
  await db.run('DELETE FROM login_fails WHERE ip = ?', [ip]);
  return { token: makeToken(cfg.secret, u), role: u.role, username: u.username };
});

add('GET', '/api/users', 'admin', async ({ db }) => ({ users: (await db.all('SELECT * FROM users ORDER BY created_at')).map(r => pubUser(rowUser(r))) }));

add('POST', '/api/users', 'admin', async ({ db, user, body }) => {
  const { username, password } = cleanCreds(body);
  const role = body.role === 'admin' ? 'admin' : 'owner';
  await mutate(db, async t => {
    if (await findUser(t, username)) throw new HttpError(409, "Ce nom d'utilisateur existe déjà");
    await insertUser(t, username, password, role);
    await logGlobal(t, user, `Compte créé : ${username} (${role === 'admin' ? 'gestionnaire' : 'lecture seule'})`);
  });
  return { ok: true };
});

add('DELETE', '/api/users/:name', 'admin', async ({ db, user, params }) => {
  const u = await findUser(db, params.name);
  if (!u) throw new HttpError(404, 'Compte introuvable');
  if (u.key === user.key) throw new HttpError(400, 'Vous ne pouvez pas supprimer votre propre compte');
  await mutate(db, async t => { await t.run('DELETE FROM users WHERE key = ?', [u.key]); await logGlobal(t, user, `Compte supprimé : ${u.username}`); });
  return { ok: true };
});

add('PUT', '/api/users/:name/password', 'admin', async ({ db, user, params, body }) => {
  const u = await findUser(db, params.name);
  if (!u) throw new HttpError(404, 'Compte introuvable');
  if (u.key === user.key) throw new HttpError(400, 'Utilisez « Mon mot de passe » pour changer le vôtre');
  checkPw(body.password);
  await mutate(db, async t => { await changePw(t, u, String(body.password)); await logGlobal(t, user, `Mot de passe de ${u.username} réinitialisé`); });
  return { ok: true };
});

add('PUT', '/api/account/password', 'any', async ({ db, cfg, user, body }) => {
  if (!verifyPw(user, String(body.currentPassword ?? ''))) throw new HttpError(400, 'Mot de passe actuel incorrect');
  checkPw(body.newPassword);
  await changePw(db, user, String(body.newPassword));
  return { ok: true, token: makeToken(cfg.secret, await findUser(db, user.username)) };
});

add('GET', '/api/data', 'any', async ({ db, cfg, query, user }) => {
  const base = { today: today(cfg.settings), role: user.role, user: pubUser(user) };
  if (Number(query.get('rev')) === cfg.rev) return { unchanged: true, rev: cfg.rev, ...base };
  return { ...base, ...(await snapshot(db, cfg.settings)) };
});

add('GET', '/api/info', 'admin', async ({ req }) => {
  const online = viaProxy(req);
  const addresses = online ? [] : Object.values(os.networkInterfaces()).flat()
    .filter(i => i && (i.family === 'IPv4' || i.family === 4) && !i.internal).map(i => i.address);
  return { addresses, online, port: Number(process.env.PORT) || null };
});

/* --- Prêts --- */
add('POST', '/api/loans', 'admin', async ({ db, cfg, user, body }) => {
  const s = cfg.settings;
  const principal = amount(body.principal, 'Le montant');
  const rate = body.rate === '' || body.rate == null ? s.defaultRate : Number(body.rate);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new HttpError(400, 'Le taux mensuel doit être compris entre 0 et 100 %');
  const startDate = str(body.startDate, 10);
  if (!isDate(startDate)) throw new HttpError(400, 'Date du prêt invalide');
  const newClient = body.newClient || {};
  if (!body.clientId && !str(newClient.name, 120)) throw new HttpError(400, 'Le nom du client est obligatoire');
  const cur = s.currency || '';

  return mutate(db, async t => {
    let clientId, clientName;
    if (body.clientId) {
      const c = await t.get('SELECT id, name FROM clients WHERE id = ?', [String(body.clientId)]);
      if (!c) throw new HttpError(400, 'Client introuvable');
      clientId = c.id; clientName = c.name;
    } else {
      clientId = await nextId(t, 'client', 'CL'); clientName = str(newClient.name, 120);
      await t.run('INSERT INTO clients(id, name, phone, address, id_number, notes, created_at) VALUES(?,?,?,?,?,?,?)',
        [clientId, clientName, str(newClient.phone, 40), str(newClient.address, 200), str(newClient.idNumber, 60), '', nowIso()]);
      await logGlobal(t, user, `Nouveau client ${clientId} : ${clientName}`);
    }
    const loanId = await nextId(t, 'loan', 'PR');
    await t.run('INSERT INTO loans(id, client_id, principal, rate, start_date, guarantee, notes, written_off_date, created_at) VALUES(?,?,?,?,?,?,?,NULL,?)',
      [loanId, clientId, principal, rate, startDate, str(body.guarantee, 200), str(body.notes, 1000), nowIso()]);
    await note(t, user, loanId, `Prêt créé pour ${clientName} : ${principal} ${cur} à ${rate} % par mois (${round2(principal * rate / 100)} ${cur} d'intérêts par mois), à partir du ${startDate}`);
    return { ok: true, loanId, clientId };
  });
});

const loanRow = async (t, id) => { const l = await t.get('SELECT * FROM loans WHERE id = ?', [id]); if (!l) throw new HttpError(404, 'Prêt introuvable'); return l; };
const loanForCalc = l => ({ principal: l.principal, rate: l.rate, startDate: l.start_date, writtenOff: null });

add('POST', '/api/loans/:id/payments', 'admin', async ({ db, cfg, user, params, body }) => {
  const value = amount(body.amount, 'Le montant');
  const date = str(body.date, 10);
  if (!isDate(date)) throw new HttpError(400, 'Date du paiement invalide');
  const pnote = str(body.note, 200), cur = cfg.settings.currency || '', todayStr = today(cfg.settings);
  return mutate(db, async t => {
    const loan = await loanRow(t, params.id);
    if (loan.written_off_date) throw new HttpError(400, 'Ce prêt est classé en perte. Annulez la perte pour enregistrer un paiement.');
    if (date < loan.start_date) throw new HttpError(400, 'La date du paiement est antérieure à la date du prêt');
    const existing = await t.all('SELECT id, date, amount FROM payments WHERE loan_id = ?', [loan.id]);
    const L = loanForCalc(loan);
    const owed = Lending.payoffAt(L, existing, date);
    if (owed <= 0.004) throw new HttpError(400, 'Ce prêt est déjà soldé à cette date.');
    if (value > owed + 0.004) throw new HttpError(400, `Le montant dépasse ce qui est dû à cette date (${owed} ${cur} pour tout solder : capital et intérêts)`);
    if (Lending.compute(L, [...existing, { id: 'nouveau', date, amount: value }], todayStr).excess > 0.004) throw new HttpError(400, 'Ce paiement rendrait des paiements enregistrés plus tard trop élevés. Corrigez d\'abord ces paiements.');
    const al = Lending.compute(L, [...existing, { id: 'nouveau', date, amount: value }], todayStr).allocations.find(a => a.id === 'nouveau');
    await t.run('INSERT INTO payments(id, loan_id, date, amount, note) VALUES(?,?,?,?,?)', [crypto.randomBytes(4).toString('hex'), loan.id, date, value, pnote]);
    await note(t, user, loan.id, `Paiement de ${value} ${cur} reçu le ${date} (${al.interest} ${cur} d'intérêts${al.principal > 0 ? `, ${al.principal} ${cur} de capital` : ''})${pnote ? ' : ' + pnote : ''}`);
    return { ok: true };
  });
});

add('DELETE', '/api/loans/:id/payments/:pid', 'admin', async ({ db, cfg, user, params }) => mutate(db, async t => {
  const loan = await loanRow(t, params.id);
  const p = await t.get('SELECT * FROM payments WHERE id = ? AND loan_id = ?', [params.pid, loan.id]);
  if (!p) throw new HttpError(404, 'Paiement introuvable');
  await t.run('DELETE FROM payments WHERE id = ?', [p.id]);
  await note(t, user, loan.id, `Paiement de ${p.amount} ${cfg.settings.currency || ''} du ${p.date} supprimé`);
  return { ok: true };
}));

add('POST', '/api/loans/:id/notes', 'admin', async ({ db, user, params, body }) => {
  const text = str(body.text, 500);
  if (!text) throw new HttpError(400, 'La note est vide');
  return mutate(db, async t => { await note(t, user, (await loanRow(t, params.id)).id, text, 'note'); return { ok: true }; });
});

add('POST', '/api/loans/:id/writeoff', 'admin', async ({ db, cfg, user, params }) => mutate(db, async t => {
  const loan = await loanRow(t, params.id);
  if (loan.written_off_date) throw new HttpError(400, 'Déjà classé en perte');
  await t.run('UPDATE loans SET written_off_date = ? WHERE id = ?', [today(cfg.settings), loan.id]);
  await note(t, user, loan.id, 'Prêt classé en perte');
  return { ok: true };
}));

add('POST', '/api/loans/:id/unwriteoff', 'admin', async ({ db, user, params }) => mutate(db, async t => {
  const loan = await loanRow(t, params.id);
  await t.run('UPDATE loans SET written_off_date = NULL WHERE id = ?', [loan.id]);
  await note(t, user, loan.id, 'Classement en perte annulé');
  return { ok: true };
}));

add('DELETE', '/api/loans/:id', 'admin', async ({ db, cfg, user, params }) => mutate(db, async t => {
  const loan = await loanRow(t, params.id);
  const client = await t.get('SELECT name FROM clients WHERE id = ?', [loan.client_id]);
  const n = Number((await t.get('SELECT COUNT(*) AS n FROM payments WHERE loan_id = ?', [loan.id])).n);
  await t.run('DELETE FROM payments WHERE loan_id = ?', [loan.id]);
  await t.run('DELETE FROM loan_history WHERE loan_id = ?', [loan.id]);
  await t.run('DELETE FROM loans WHERE id = ?', [loan.id]);
  await logGlobal(t, user, `Prêt ${loan.id} supprimé (${client ? client.name : loan.client_id}, ${loan.principal} ${cfg.settings.currency || ''}, ${n} paiement(s))`);
  return { ok: true };
}));

/* --- Clients --- */
add('PUT', '/api/clients/:id', 'admin', async ({ db, user, params, body }) => {
  const name = str(body.name, 120);
  if (!name) throw new HttpError(400, 'Le nom du client est obligatoire');
  return mutate(db, async t => {
    const c = await t.get('SELECT id FROM clients WHERE id = ?', [params.id]);
    if (!c) throw new HttpError(404, 'Client introuvable');
    await t.run('UPDATE clients SET name = ?, phone = ?, address = ?, id_number = ?, notes = ? WHERE id = ?',
      [name, str(body.phone, 40), str(body.address, 200), str(body.idNumber, 60), str(body.notes, 500), c.id]);
    await logGlobal(t, user, `Fiche client ${c.id} modifiée (${name})`);
    return { ok: true };
  });
});

/* --- Dépenses, retraits, apports --- */
add('POST', '/api/expenses', 'admin', async ({ db, cfg, user, body }) => {
  const type = str(body.type, 20);
  if (!['depense', 'retrait', 'apport'].includes(type)) throw new HttpError(400, 'Type invalide');
  const value = amount(body.amount, 'Le montant');
  const date = str(body.date, 10);
  if (!isDate(date)) throw new HttpError(400, 'Date invalide');
  const category = str(body.category, 60);
  return mutate(db, async t => {
    const id = await nextId(t, 'expense', 'DP');
    await t.run('INSERT INTO expenses(id, type, date, amount, category, description, created_at) VALUES(?,?,?,?,?,?,?)', [id, type, date, value, category, str(body.description, 300), nowIso()]);
    const label = { depense: 'Dépense', retrait: 'Retrait du propriétaire', apport: 'Apport de capital' }[type];
    await logGlobal(t, user, `${label} de ${value} ${cfg.settings.currency || ''}${category ? ' (' + category + ')' : ''}`);
    return { ok: true, id };
  });
});

add('DELETE', '/api/expenses/:id', 'admin', async ({ db, cfg, user, params }) => mutate(db, async t => {
  const e = await t.get('SELECT * FROM expenses WHERE id = ?', [params.id]);
  if (!e) throw new HttpError(404, 'Ligne introuvable');
  await t.run('DELETE FROM expenses WHERE id = ?', [e.id]);
  await logGlobal(t, user, `Ligne ${e.id} supprimée (${e.type}, ${e.amount} ${cfg.settings.currency || ''})`);
  return { ok: true };
}));

/* --- Réglages, sauvegarde --- */
add('PUT', '/api/settings', 'admin', async ({ db, cfg, user, body }) => {
  const company = str(body.company, 80) || 'La Familia';
  const currency = str(body.currency, 8);
  const defaultRate = Number(body.defaultRate);
  const timezone = str(body.timezone, 60) || cfg.settings.timezone;
  if (!Number.isFinite(defaultRate) || defaultRate < 0 || defaultRate > 100) throw new HttpError(400, 'Taux mensuel par défaut invalide');
  if (!validTz(timezone)) throw new HttpError(400, 'Fuseau horaire invalide');
  return mutate(db, async t => { await setSettings(t, { company, currency, defaultRate, timezone }); await logGlobal(t, user, 'Réglages modifiés'); return { ok: true }; });
});

add('GET', '/api/backup', 'any', async ({ db, cfg, res }) => {
  const snap = await snapshot(db, cfg.settings, 3000);
  const body = JSON.stringify({ format: 'la-familia-v2', exportedAt: nowIso(), ...snap }, null, 2);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename="la-familia-sauvegarde-${today(cfg.settings)}.json"`
  });
  res.end(body);
  return undefined;
});

add('POST', '/api/restore', 'admin', async ({ db, cfg, user, body }) => {
  const d = body && body.db;
  if (!d || !Array.isArray(d.clients) || !Array.isArray(d.loans) || !Array.isArray(d.expenses)) throw new HttpError(400, 'Fichier de sauvegarde invalide');
  if (d.loans.some(l => !l || !l.id || !l.clientId || !Array.isArray(l.payments || []))) throw new HttpError(400, 'Fichier de sauvegarde invalide (prêts)');
  const S = { ...DEFAULT_SETTINGS, timezone: cfg.settings.timezone, ...(d.settings || {}) };
  if (!validTz(S.timezone)) S.timezone = cfg.settings.timezone;
  const n0 = v => Number.isFinite(Number(v)) ? Number(v) : 0;
  const maxSuffix = (list, prefix) => list.reduce((m, x) => { const n = parseInt(String(x.id || '').replace(prefix + '-', ''), 10); return Number.isFinite(n) ? Math.max(m, n) : m; }, 0);
  const seqRows = await db.all("SELECT key, value FROM kv WHERE key LIKE 'seq_%'");
  const seq = k => Number((seqRows.find(r => r.key === 'seq_' + k) || { value: 0 }).value);
  const KV = "INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value";

  const st = ['DELETE FROM payments', 'DELETE FROM loan_history', 'DELETE FROM loans', 'DELETE FROM clients', 'DELETE FROM expenses', 'DELETE FROM log'];
  for (const c of d.clients) st.push({ sql: 'INSERT INTO clients(id, name, phone, address, id_number, notes, created_at) VALUES(?,?,?,?,?,?,?)', args: [str(c.id, 40), str(c.name, 120) || '(sans nom)', str(c.phone, 40), str(c.address, 200), str(c.idNumber, 60), str(c.notes, 500), str(c.createdAt, 40) || nowIso()] });
  for (const l of d.loans) {
    st.push({ sql: 'INSERT INTO loans(id, client_id, principal, rate, start_date, guarantee, notes, written_off_date, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      args: [str(l.id, 40), str(l.clientId, 40), n0(l.principal), n0(l.rate), str(l.startDate, 10), str(l.guarantee, 200), str(l.notes, 1000), l.writtenOff && l.writtenOff.date ? str(l.writtenOff.date, 10) : null, str(l.createdAt, 40) || nowIso()] });
    for (const p of l.payments || []) st.push({ sql: 'INSERT INTO payments(id, loan_id, date, amount, note) VALUES(?,?,?,?,?)', args: [str(p.id, 40) || crypto.randomBytes(4).toString('hex'), str(l.id, 40), str(p.date, 10), n0(p.amount), str(p.note, 200)] });
    for (const h of l.history || []) st.push({ sql: 'INSERT INTO loan_history(loan_id, ts, text, kind, by) VALUES(?,?,?,?,?)', args: [str(l.id, 40), str(h.ts, 40) || nowIso(), str(h.text, 600), h.kind === 'note' ? 'note' : 'event', h.by ? str(h.by, 60) : null] });
  }
  for (const e of d.expenses) st.push({ sql: 'INSERT INTO expenses(id, type, date, amount, category, description, created_at) VALUES(?,?,?,?,?,?,?)', args: [str(e.id, 40), str(e.type, 20), str(e.date, 10), n0(e.amount), str(e.category, 60), str(e.description, 300), str(e.createdAt, 40) || nowIso()] });
  for (const g of d.log || []) st.push({ sql: 'INSERT INTO log(ts, text, loan_id, by) VALUES(?,?,?,?)', args: [str(g.ts, 40) || nowIso(), str(g.text, 600), g.loanId ? str(g.loanId, 40) : null, g.by ? str(g.by, 60) : null] });
  st.push({ sql: KV, args: ['settings', JSON.stringify(S)] });
  st.push({ sql: KV, args: ['seq_client', String(Math.max(seq('client'), maxSuffix(d.clients, 'CL')))] });
  st.push({ sql: KV, args: ['seq_loan', String(Math.max(seq('loan'), maxSuffix(d.loans, 'PR')))] });
  st.push({ sql: KV, args: ['seq_expense', String(Math.max(seq('expense'), maxSuffix(d.expenses, 'DP')))] });
  st.push({ sql: 'INSERT INTO log(ts, text, loan_id, by) VALUES(?,?,?,?)', args: [nowIso(), 'Données restaurées depuis une sauvegarde', null, user.username] });
  st.push({ sql: "INSERT INTO kv(key, value) VALUES('rev', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1" });
  try { await db.batch(st); }
  catch (e) { console.error(e); throw new HttpError(400, 'Fichier de sauvegarde invalide : ' + String(e.message).slice(0, 120)); }
  return { ok: true };
});

/* --- Import depuis un tableur (lignes déjà lues et converties par l'application) --- */
const IMPORT_MAX = { loans: 5000, payments: 20000, expenses: 5000 };
const normName = x => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const numOrNull = v => (v == null || v === '' || typeof v === 'boolean' || !Number.isFinite(Number(v))) ? null : Number(v);

add('POST', '/api/import', 'admin', async ({ db, cfg, user, body }) => {
  const loansIn = Array.isArray(body.loans) ? body.loans : [];
  const paysIn = Array.isArray(body.payments) ? body.payments : [];
  const expIn = Array.isArray(body.expenses) ? body.expenses : [];
  if (loansIn.length > IMPORT_MAX.loans || paysIn.length > IMPORT_MAX.payments || expIn.length > IMPORT_MAX.expenses) throw new HttpError(400, `Fichier trop volumineux (maximum ${IMPORT_MAX.loans} prêts, ${IMPORT_MAX.payments} paiements, ${IMPORT_MAX.expenses} dépenses par import)`);
  if (!loansIn.length && !paysIn.length && !expIn.length) throw new HttpError(400, 'Aucune ligne à importer');
  const replace = body.mode === 'replace';
  if (replace && body.confirmReplace !== true) throw new HttpError(400, 'Le remplacement des données doit être confirmé');
  const dry = body.dryRun === true, skipDup = body.skipDuplicates !== false;
  const S = cfg.settings, todayStr = today(S), cur = S.currency || '';

  let exClients = [], exLoans = [];
  const seq = { client: 0, loan: 0, expense: 0 };
  if (!replace) {
    const [c, l, q] = await db.many([
      { sql: 'SELECT id, name FROM clients ORDER BY rowid' },
      { sql: 'SELECT client_id, principal, start_date FROM loans' },
      { sql: "SELECT key, value FROM kv WHERE key LIKE 'seq_%'" }
    ]);
    exClients = c; exLoans = l;
    for (const r of q) { const k = r.key.slice(4); if (k in seq) seq[k] = Number(r.value) || 0; }
  }
  const warnings = [], errors = [];
  const warn = (src, row, msg) => warnings.push({ src, row, msg });
  const fail = (src, row, msg) => errors.push({ src, row, msg });
  const st = []; // clients, puis prêts et paiements (ordre imposé par les références)
  if (replace) st.push('DELETE FROM payments', 'DELETE FROM loan_history', 'DELETE FROM loans', 'DELETE FROM clients', 'DELETE FROM expenses', 'DELETE FROM log');

  const newId = (kind, prefix) => `${prefix}-${String(++seq[kind]).padStart(4, '0')}`;
  const clientByName = new Map();
  for (const c of exClients) if (!clientByName.has(normName(c.name))) clientByName.set(normName(c.name), c.id);
  const dupKeys = new Set(exLoans.map(l => `${l.client_id}|${round2(Number(l.principal))}|${l.start_date}`));
  const stats = { clientsNew: 0, clientsReused: 0, loans: 0, duplicates: 0, payments: 0, paymentsCapped: 0, paymentsSkipped: 0, closings: 0, expenses: 0, lent: 0, collected: 0 };
  const reused = new Set(), importedByRef = new Map(), importedByClient = new Map(), imported = [];

  for (const r of loansIn) {
    const src = str(r.src, 60) || 'Feuille', row = Number(r.row) || 0, bad = r.bad || {};
    const name = str(String(r.clientName ?? '').replace(/\s+/g, ' '), 120);
    if (!name) { fail(src, row, 'Nom du client manquant'); continue; }
    const principal = numOrNull(r.principal);
    if (principal == null || principal <= 0 || principal > 1e12) { fail(src, row, `Montant du prêt manquant ou illisible${bad.principal ? ` (« ${str(bad.principal, 30)} »)` : ''}`); continue; }
    const startDate = str(r.startDate, 10);
    if (!isDate(startDate)) { fail(src, row, `Date du prêt manquante ou illisible${bad.startDate ? ` (« ${str(bad.startDate, 30)} »)` : ''}`); continue; }
    const P = round2(principal);
    let rate = numOrNull(r.rate);
    if (rate == null || rate < 0) rate = S.defaultRate; else if (rate > 100) { warn(src, row, `Taux de ${rate} % par mois inhabituel`); }
    rate = round2(rate);

    const key = normName(name);
    let clientId = clientByName.get(key);
    if (clientId && skipDup && dupKeys.has(`${clientId}|${P}|${startDate}`)) { stats.duplicates++; warn(src, row, `Doublon ignoré : ${name}, ${P} ${cur}, ${startDate}`); continue; }
    if (!clientId) {
      clientId = newId('client', 'CL'); clientByName.set(key, clientId); stats.clientsNew++;
      st.push({ sql: 'INSERT INTO clients(id, name, phone, address, id_number, notes, created_at) VALUES(?,?,?,?,?,?,?)', args: [clientId, name, str(r.phone, 40), str(r.address, 200), str(r.idNumber, 60), '', nowIso()] });
    } else if (!reused.has(clientId) && exClients.some(c => c.id === clientId)) { reused.add(clientId); stats.clientsReused++; }
    dupKeys.add(`${clientId}|${P}|${startDate}`);

    const status = normName(r.status);
    const lost = /perdu|perte|irrecouvr|lost|written/.test(status);
    const closedFlag = !lost && (/rembours|solde|cloture|clos|termine|fini|paye|paid|closed/.test(status));
    const endDate = isDate(str(r.endDate, 10)) ? str(r.endDate, 10) : null;
    const rec = { id: newId('loan', 'PR'), clientId, name, src, row, ref: str(r.ref, 40), principal: P, rate, startDate, lost, closedFlag, endDate, guarantee: str(r.guarantee, 200), notes: str(r.notes, 1000), pending: [], accepted: [] };
    imported.push(rec);
    if (rec.ref) importedByRef.set(normName(rec.ref), rec);
    if (!importedByClient.has(clientId)) importedByClient.set(clientId, []);
    importedByClient.get(clientId).push(rec);
    stats.loans++; stats.lent = round2(stats.lent + P);

    // Paiement indiqué sur la ligne du prêt : montant payé, ou « payé » (oui / soldé)
    const paid = numOrNull(r.paid);
    if (paid != null && paid > 0) rec.pending.push({ date: str(r.paidDate, 10) || endDate || todayStr, amount: round2(paid), note: 'Total payé indiqué sur la ligne du prêt', src, row });
    else if (r.paidFull === true) rec.closedFlag = true;
  }

  for (const r of paysIn) {
    const src = str(r.src, 60) || 'Feuille', row = Number(r.row) || 0, bad = r.bad || {};
    const value = numOrNull(r.amount);
    if (value == null || value <= 0) { fail(src, row, `Montant du paiement manquant ou illisible${bad.amount ? ` (« ${str(bad.amount, 30)} »)` : ''}`); continue; }
    const date = str(r.date, 10);
    if (!isDate(date)) { fail(src, row, `Date du paiement manquante ou illisible${bad.date ? ` (« ${str(bad.date, 30)} »)` : ''}`); continue; }
    let loan = null;
    const ref = normName(r.loanRef);
    if (ref && importedByRef.has(ref)) loan = importedByRef.get(ref);
    else {
      const cid = clientByName.get(normName(r.clientName));
      const list = cid && importedByClient.get(cid);
      if (list && list.length) {
        const ld = str(r.loanDate, 10);
        if (isDate(ld)) loan = list.find(l => l.startDate === ld);
        if (!loan) { // sinon : le prêt le plus récent commencé avant ce paiement
          const before = list.filter(l => l.startDate <= date).sort((a, b) => a.startDate < b.startDate ? 1 : -1);
          loan = before[0] || list[0];
        }
      }
    }
    if (!loan) { fail(src, row, 'Aucun prêt correspondant (référence ou client introuvable parmi les prêts importés)'); continue; }
    loan.pending.push({ date, amount: round2(value), note: str(r.note, 200), src, row });
  }

  // Chaque prêt : paiements classés par date, plafonnés à ce qui était dû, puis clôture éventuelle
  const loanStmts = [];
  for (const loan of imported) {
    const L = { principal: loan.principal, rate: loan.rate, startDate: loan.startDate, writtenOff: null };
    for (const p of [...loan.pending].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0)) {
      let date = p.date;
      if (date < loan.startDate) { warn(p.src, p.row, 'Date de paiement antérieure au prêt : date du prêt utilisée'); date = loan.startDate; }
      const owed = Lending.payoffAt(L, loan.accepted, date);
      if (owed <= 0.004) { stats.paymentsSkipped++; warn(p.src, p.row, `Paiement ignoré : le prêt de ${loan.name} du ${loan.startDate} est déjà soldé`); continue; }
      let v = p.amount;
      if (v > owed + 0.004) { warn(p.src, p.row, `Paiement de ${v} ${cur} ramené à ce qui était dû (${owed} ${cur})`); v = owed; stats.paymentsCapped++; }
      loan.accepted.push({ date, amount: v, note: p.note });
    }
    if (loan.closedFlag && !loan.lost && Lending.compute(L, loan.accepted, todayStr).status !== 'rembourse') {
      const last = loan.accepted.length ? loan.accepted[loan.accepted.length - 1].date : null;
      let d = loan.endDate || last || todayStr; if (d < loan.startDate) d = loan.startDate;
      const owed = Lending.payoffAt(L, loan.accepted, d);
      if (owed > 0.004) {
        loan.accepted.push({ date: d, amount: owed, note: 'Solde de clôture ajouté (prêt marqué remboursé dans le fichier)' });
        stats.closings++; warn(loan.src, loan.row, `Prêt marqué remboursé mais paiements insuffisants : paiement de solde de ${owed} ${cur} ajouté au ${d}`);
      }
    }
    loanStmts.push({ sql: 'INSERT INTO loans(id, client_id, principal, rate, start_date, guarantee, notes, written_off_date, created_at) VALUES(?,?,?,?,?,?,?,?,?)', args: [loan.id, loan.clientId, loan.principal, loan.rate, loan.startDate, loan.guarantee, loan.notes, loan.lost ? todayStr : null, nowIso()] });
    loanStmts.push({ sql: 'INSERT INTO loan_history(loan_id, ts, text, kind, by) VALUES(?,?,?,?,?)', args: [loan.id, nowIso(), `Importé depuis un tableur (${loan.src}, ligne ${loan.row}${loan.ref ? ', réf. ' + loan.ref : ''})`, 'event', user.username] });
    for (const p of loan.accepted) {
      loanStmts.push({ sql: 'INSERT INTO payments(id, loan_id, date, amount, note) VALUES(?,?,?,?,?)', args: [crypto.randomBytes(4).toString('hex'), loan.id, p.date, p.amount, str(p.note, 200)] });
      stats.payments++; stats.collected = round2(stats.collected + p.amount);
    }
  }
  st.push(...loanStmts);

  for (const r of expIn) {
    const src = str(r.src, 60) || 'Feuille', row = Number(r.row) || 0, bad = r.bad || {};
    const type = str(r.type, 20);
    if (!['depense', 'retrait', 'apport'].includes(type)) { fail(src, row, 'Type d\'opération invalide'); continue; }
    const value = numOrNull(r.amount);
    if (value == null || value <= 0) { fail(src, row, `Montant manquant ou illisible${bad.amount ? ` (« ${str(bad.amount, 30)} »)` : ''}`); continue; }
    const date = str(r.date, 10);
    if (!isDate(date)) { fail(src, row, `Date manquante ou illisible${bad.date ? ` (« ${str(bad.date, 30)} »)` : ''}`); continue; }
    st.push({ sql: 'INSERT INTO expenses(id, type, date, amount, category, description, created_at) VALUES(?,?,?,?,?,?,?)', args: [newId('expense', 'DP'), type, date, round2(value), str(r.category, 60), str(r.description, 300), nowIso()] });
    stats.expenses++;
  }

  const summary = { ok: true, dryRun: dry, mode: replace ? 'replace' : 'add', ...stats, warnings: warnings.slice(0, 100), warningsCount: warnings.length, errors: errors.slice(0, 100), errorsCount: errors.length };
  if (dry) return summary;
  if (!stats.loans && !stats.payments && !stats.expenses) throw new HttpError(400, 'Aucune ligne valide à importer' + (errors[0] ? ` (${errors[0].src}, ligne ${errors[0].row} : ${errors[0].msg})` : ''));

  const KVSQL = 'INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value';
  for (const k of ['client', 'loan', 'expense']) st.push({ sql: KVSQL, args: ['seq_' + k, String(seq[k])] });
  st.push({ sql: 'INSERT INTO log(ts, text, loan_id, by) VALUES(?,?,?,?)', args: [nowIso(), `Import depuis un tableur : ${stats.loans} prêt(s), ${stats.payments} paiement(s), ${stats.expenses} dépense(s)${replace ? ' (données remplacées)' : ''}`, null, user.username] });
  st.push({ sql: "INSERT INTO kv(key, value) VALUES('rev', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1" });
  try { await db.batch(st); }
  catch (e) { console.error(e); throw new HttpError(400, 'Import impossible : ' + String(e.message).slice(0, 140)); }
  return summary;
});

/* ----------------------------------------------------------------- Entrée -- */
function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
async function readBody(req, limit = 4.4e6) {
  if (req.body !== undefined && req.body !== null) { // hébergement Vercel : le contenu est déjà lu
    const b = req.body;
    try { return Buffer.isBuffer(b) ? (b.length ? JSON.parse(b.toString('utf8')) : {}) : typeof b === 'string' ? (b ? JSON.parse(b) : {}) : b; }
    catch { throw new HttpError(400, 'JSON invalide'); }
  }
  if (req.readableEnded) return {};
  return new Promise((ok, ko) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > limit) { req.destroy(); ko(new HttpError(413, 'Requête trop volumineuse')); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return ok({});
      try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { ko(new HttpError(400, 'JSON invalide')); }
    });
    req.on('error', ko);
  });
}

async function handle(req, res) {
  try {
    const db = await getDb();
    const url = new URL(req.url, 'http://local');
    let p = url.pathname;
    const query = new URLSearchParams(url.search);
    if (req.query) for (const [k, v] of Object.entries(req.query)) if (k !== 'slug') query.set(k, [].concat(v)[0]); // hébergement Vercel : paramètres déjà lus
    const slug = req.query && req.query.slug; // hébergement Vercel : segments de l'adresse après /api/
    if (slug && [].concat(slug).length) p = '/api/' + [].concat(slug).join('/');
    p = p.replace(/\/+$/, '') || '/api';

    let route = null; const params = {};
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(p);
      if (m) { route = r; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); break; }
    }
    if (!route) throw new HttpError(404, 'Route inconnue');

    // Une seule lecture groupée : réglages, révision, clé secrète et compte de la personne connectée
    const auth = String(req.headers.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : query.get('token');
    const [kvRows, userRows] = await db.many([
      { sql: "SELECT key, value FROM kv WHERE key IN ('secret', 'settings', 'rev')" },
      { sql: 'SELECT * FROM users WHERE key = ?', args: [tokenClaim(token) || ''] }
    ]);
    const kv = Object.fromEntries(kvRows.map(r => [r.key, r.value]));
    let secret = kv.secret;
    if (!secret) {
      await db.run("INSERT OR IGNORE INTO kv(key, value) VALUES('secret', ?)", [crypto.randomBytes(32).toString('hex')]);
      secret = (await db.get("SELECT value FROM kv WHERE key = 'secret'")).value;
    }
    let settings = {}; try { settings = JSON.parse(kv.settings || '{}'); } catch { /* valeurs par défaut */ }
    const cfg = { secret, settings: { ...DEFAULT_SETTINGS, ...settings }, rev: Number(kv.rev || 0) };

    let user = null;
    if (route.role) {
      user = verifyToken(secret, token, userRows[0]);
      if (!user) throw new HttpError(401, 'Session expirée');
      if (route.role === 'admin' && user.role !== 'admin') throw new HttpError(403, 'Lecture seule : action réservée au gestionnaire');
    }
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
    const result = await route.fn({ db, cfg, req, res, url, query, params, body, user });
    if (result !== undefined) send(res, 200, result);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Erreur interne du serveur' });
  }
}

module.exports = handle;
