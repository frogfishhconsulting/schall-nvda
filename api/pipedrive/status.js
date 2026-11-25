// Quick check: is Pipedrive connected? Returns no secrets.
const { loadTokens, redisCfg } = require('../../lib/pipedrive');
module.exports = async (req, res) => {
  const env = { client_id: !!process.env.PIPEDRIVE_CLIENT_ID, client_secret: !!process.env.PIPEDRIVE_CLIENT_SECRET, database: !!redisCfg(), slack: !!process.env.SLACK_WEBHOOK_URL };
  env.storage_var_names = Object.keys(process.env).filter((k) => /REDIS|KV_|UPSTASH/.test(k));
  let t = null;
  try { t = await loadTokens(); } catch (e) { env.database_error = e.message; }
  res.status(200).json({ ready_to_share: env.client_id && env.client_secret && env.database && !env.database_error, connected: !!t, connected_at: t?.connected_at || null, env });
};
