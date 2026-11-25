// Pipedrive OAuth + API helpers. Tokens live in Upstash Redis (Vercel Storage).
// Env: PIPEDRIVE_CLIENT_ID, PIPEDRIVE_CLIENT_SECRET,
//      KV_REST_API_URL + KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN)

const crypto = require('crypto');

const TOKEN_KEY = 'pipedrive:tokens';
const REDIRECT_URI = process.env.PIPEDRIVE_REDIRECT_URI || 'https://intc.schallfirm.com/api/pipedrive/callback';

/* ---------- Redis (Upstash REST) ---------- */
function redisCfg() {
  // Accepts Upstash/KV REST vars with any prefix Vercel adds (e.g. STORAGE_KV_REST_API_URL).
  const keys = Object.keys(process.env);
  const pick = (re) => { const k = keys.find((x) => re.test(x) && !/READ_ONLY/.test(x)); return k ? process.env[k] : null; };
  const url = pick(/(KV_REST_API_URL|UPSTASH_REDIS_REST_URL)$/);
  const token = pick(/(KV_REST_API_TOKEN|UPSTASH_REDIS_REST_TOKEN)$/);
  return url && token ? { url, token } : null;
}
async function redis(cmd) {
  const c = redisCfg();
  if (!c) throw new Error('redis_not_configured');
  const r = await fetch(c.url, { method: 'POST', headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(`redis: ${j.error}`);
  return j.result;
}
async function loadTokens() {
  const raw = await redis(['GET', TOKEN_KEY]);
  return raw ? JSON.parse(raw) : null;
}
async function saveTokens(t) {
  await redis(['SET', TOKEN_KEY, JSON.stringify(t)]);
}

/* ---------- OAuth ---------- */
function basicAuth() {
  return 'Basic ' + Buffer.from(`${process.env.PIPEDRIVE_CLIENT_ID}:${process.env.PIPEDRIVE_CLIENT_SECRET}`).toString('base64');
}
async function tokenRequest(params) {
  const r = await fetch('https://oauth.pipedrive.com/oauth/token', {
    method: 'POST',
    headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error(`token_error ${r.status}: ${JSON.stringify(j)}`);
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    api_domain: j.api_domain,
    scope: j.scope,
    expires_at: Date.now() + (Number(j.expires_in) || 3599) * 1000,
  };
}
async function exchangeCode(code) {
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
  t.connected_at = new Date().toISOString();
  await saveTokens(t);
  return t;
}
async function getAccess() {
  let t = await loadTokens();
  if (!t) return null;
  if (Date.now() > t.expires_at - 120000) {
    const n = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
    t = { ...t, ...n, refresh_token: n.refresh_token || t.refresh_token };
    await saveTokens(t);
  }
  return t;
}

/* ---------- API ---------- */
async function api(method, path, body) {
  const t = await getAccess();
  if (!t) throw new Error('pipedrive_not_connected');
  const r = await fetch(`${t.api_domain}${path}`, {
    method,
    headers: { Authorization: `Bearer ${t.access_token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) throw new Error(`pipedrive ${method} ${path} ${r.status}: ${JSON.stringify(j).slice(0, 400)}`);
  return j;
}

// Shared secret for webhook basic auth, derived so it needs no extra env var.
function webhookPassword() {
  return crypto.createHash('sha256').update('sbs-webhook:' + (process.env.PIPEDRIVE_CLIENT_SECRET || '')).digest('hex').slice(0, 32);
}

module.exports = { redisCfg, loadTokens, exchangeCode, getAccess, api, webhookPassword, REDIRECT_URI };
