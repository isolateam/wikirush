const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 2100);
const ADMIN_USERNAME = 'b';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const DATA_DIR = process.env.DATA_DIR || (process.env.VERCEL ? '/tmp/wikirush-data' : path.join(__dirname, 'data'));
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const SESSION_COOKIE = 'wikirush_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const sessions = new Map();
let storageInitialized = false;

function initializeStorage() {
  if (storageInitialized) return;
  if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) {
    throw new Error('Set ADMIN_PASSWORD to a random value of at least 12 characters.');
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(ACCOUNTS_FILE)) fs.writeFileSync(ACCOUNTS_FILE, '[]\n');
  } catch (error) {
    throw new Error(`Cannot create account storage at ${DATA_DIR}. Set DATA_DIR to a writable persistent directory or connect a database. ${error.message}`);
  }
  ensureAdminAccount();
  storageInitialized = true;
}

function readAccounts() {
  return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
}

function writeAccounts(accounts) {
  const temporaryFile = `${ACCOUNTS_FILE}.tmp`;
  fs.writeFileSync(temporaryFile, `${JSON.stringify(accounts, null, 2)}\n`);
  fs.renameSync(temporaryFile, ACCOUNTS_FILE);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, account) {
  const attempted = Buffer.from(hashPassword(password, account.passwordSalt).hash, 'hex');
  const expected = Buffer.from(account.passwordHash, 'hex');
  return attempted.length === expected.length && crypto.timingSafeEqual(attempted, expected);
}

function newId() {
  return crypto.randomUUID();
}

function publicAccount(account) {
  return {
    id: account.id,
    username: account.username,
    role: account.role,
    stats: account.stats
  };
}

function ensureAdminAccount() {
  const accounts = readAccounts();
  let admin = accounts.find(account => account.username === ADMIN_USERNAME);
  const password = hashPassword(ADMIN_PASSWORD);
  if (!admin) {
    admin = {
      id: newId(),
      username: ADMIN_USERNAME,
      role: 'admin',
      passwordSalt: password.salt,
      passwordHash: password.hash,
      stats: { elo: 300, rankedGames: 0 }
    };
    accounts.push(admin);
  } else if (admin.role !== 'admin') {
    admin.role = 'admin';
  }
  writeAccounts(accounts);
}

function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie || '').split(';').filter(Boolean).map(part => {
    const index = part.indexOf('=');
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }));
}

function setSession(response, account) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { accountId: account.id, expiresAt: Date.now() + SESSION_TTL_MS });
  response.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
}

function getAuthenticatedAccount(request) {
  const token = parseCookies(request)[SESSION_COOKIE];
  const session = token && sessions.get(token);
  if (!session || session.expiresAt < Date.now()) return null;
  const account = readAccounts().find(item => item.id === session.accountId);
  return account || null;
}

function clearSession(request, response) {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (token) sessions.delete(token);
  response.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 10000) throw new Error('Request body is too large.');
  }
  return body ? JSON.parse(body) : {};
}

function requireAdmin(request, response) {
  const account = getAuthenticatedAccount(request);
  if (!account || account.role !== 'admin') {
    sendError(response, 403, 'Admin access required.');
    return null;
  }
  return account;
}

async function handleApi(request, response, pathname) {
  try {
    if (request.method === 'POST' && pathname === '/api/register') {
      const { username, password } = await readJson(request);
      const cleanUsername = String(username || '').trim().toLowerCase();
      if (!/^[a-z0-9_]{3,18}$/.test(cleanUsername) || typeof password !== 'string' || password.length < 12) {
        return sendError(response, 400, 'Username must be 3-18 letters/numbers/underscores and password must be at least 12 characters.');
      }
      const accounts = readAccounts();
      if (accounts.some(account => account.username === cleanUsername)) return sendError(response, 409, 'Username already exists.');
      const passwordData = hashPassword(password);
      const account = { id: newId(), username: cleanUsername, role: 'player', passwordSalt: passwordData.salt, passwordHash: passwordData.hash, stats: { elo: 300, rankedGames: 0 } };
      accounts.push(account);
      writeAccounts(accounts);
      setSession(response, account);
      return sendJson(response, 201, { account: publicAccount(account) });
    }

    if (request.method === 'POST' && pathname === '/api/login') {
      const { username, password } = await readJson(request);
      const account = readAccounts().find(item => item.username === String(username || '').trim().toLowerCase());
      if (!account || typeof password !== 'string' || !verifyPassword(password, account)) return sendError(response, 401, 'Invalid username or password.');
      setSession(response, account);
      return sendJson(response, 200, { account: publicAccount(account) });
    }

    if (request.method === 'POST' && pathname === '/api/logout') {
      clearSession(request, response);
      return sendJson(response, 200, { ok: true });
    }

    if (request.method === 'GET' && pathname === '/api/me') {
      const account = getAuthenticatedAccount(request);
      return account ? sendJson(response, 200, { account: publicAccount(account) }) : sendError(response, 401, 'Not signed in.');
    }

    if (request.method === 'POST' && pathname === '/api/me/elo') {
      const account = getAuthenticatedAccount(request);
      if (!account) return sendError(response, 401, 'Not signed in.');
      const { delta } = await readJson(request);
      if (!Number.isInteger(delta) || delta < -100 || delta > 100) return sendError(response, 400, 'Elo change must be an integer from -100 to 100.');
      const accounts = readAccounts();
      const storedAccount = accounts.find(item => item.id === account.id);
      storedAccount.stats.elo = Math.max(0, storedAccount.stats.elo + delta);
      storedAccount.stats.rankedGames = (storedAccount.stats.rankedGames || 0) + 1;
      writeAccounts(accounts);
      return sendJson(response, 200, { account: publicAccount(storedAccount) });
    }

    if (request.method === 'POST' && pathname === '/api/admin/reset-elo') {
      if (!requireAdmin(request, response)) return;
      const accounts = readAccounts();
      accounts.forEach(account => { account.stats.elo = 300; });
      writeAccounts(accounts);
      return sendJson(response, 200, { ok: true, updated: accounts.length, elo: 300 });
    }

    const changeMatch = pathname.match(/^\/api\/admin\/accounts\/([^/]+)\/elo$/);
    if (request.method === 'PATCH' && changeMatch) {
      if (!requireAdmin(request, response)) return;
      const username = decodeURIComponent(changeMatch[1]).toLowerCase();
      const { elo } = await readJson(request);
      if (!Number.isInteger(elo) || elo < 0 || elo > 100000) return sendError(response, 400, 'Elo must be an integer from 0 to 100000.');
      const accounts = readAccounts();
      const account = accounts.find(item => item.username === username);
      if (!account) return sendError(response, 404, 'Account not found.');
      account.stats.elo = elo;
      writeAccounts(accounts);
      return sendJson(response, 200, { account: publicAccount(account) });
    }

    return sendError(response, 404, 'API route not found.');
  } catch (error) {
    return sendError(response, 400, error.message || 'Invalid request.');
  }
}

function serveStatic(response, pathname) {
  if (pathname !== '/' && pathname !== '/index.html' && !pathname.startsWith('/assets/')) return sendError(response, 404, 'File not found.');
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  const filePath = path.normalize(path.join(__dirname, relativePath));
  if (!filePath.startsWith(__dirname) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return sendError(response, 404, 'File not found.');
  const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
  response.writeHead(200, { 'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(response);
}

function handler(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    try {
      initializeStorage();
    } catch (error) {
      return sendError(response, 500, error.message);
    }
    return handleApi(request, response, url.pathname);
  }
  return serveStatic(response, url.pathname);
}

module.exports = handler;

if (require.main === module) {
  http.createServer(handler).listen(PORT, () => {
    console.log(`WikiRush server running at http://localhost:${PORT}`);
    console.log('Admin account: b (password supplied through ADMIN_PASSWORD)');
  });
}
