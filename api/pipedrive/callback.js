// OAuth callback: Pipedrive sends the installing user here after they click "Allow and install".
// Saves tokens, then registers webhooks for deal changes and new activities.

const { exchangeCode, api, webhookPassword, redisCfg } = require('../../lib/pipedrive');

const page = (title, body, ok = true) => `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500&display=swap" rel="stylesheet">
<style>body{margin:0;font-family:Roboto,system-ui,sans-serif;background:#f5f7fb;color:#1f2937;display:grid;place-items:center;min-height:100vh}
.c{background:#fff;max-width:460px;padding:40px 36px;border-radius:12px;box-shadow:0 20px 50px -20px rgba(21,39,78,.25);text-align:center}
.i{width:56px;height:56px;border-radius:50%;margin:0 auto 18px;display:grid;place-items:center;background:${ok ? '#e8f3ec' : '#fbefef'}}
h1{font-weight:500;font-size:22px;color:#15274e;margin:0 0 8px}p{color:#5f6b7a;font-weight:300;line-height:1.6;margin:0}</style></head>
<body><div class="c"><div class="i">${ok
  ? '<svg width="26" height="26" viewBox="0 0 20 20" fill="none"><path d="M4 10.5l4 4 8-9" stroke="#2f6b4f" stroke-width="2.2"/></svg>'
  : '<svg width="24" height="24" viewBox="0 0 16 16" fill="none"><path d="M8 4.5v4.2M8 11v.5" stroke="#9d2121" stroke-width="1.8" stroke-linecap="round"/></svg>'}</div>
<h1>${title}</h1><p>${body}</p></div></body></html>`;

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const { code, error } = req.query || {};

  if (error || !code) {
    return res.status(400).send(page('Connection not completed', 'Pipedrive did not return an authorization. Please try the install link again, or reach out to FrogFish.', false));
  }
  if (!process.env.PIPEDRIVE_CLIENT_ID || !process.env.PIPEDRIVE_CLIENT_SECRET || !redisCfg()) {
    console.error('[pipedrive] missing env: client id/secret or redis');
    return res.status(500).send(page('Setup incomplete', 'The connection is not fully configured yet. Please let FrogFish know and try again shortly.', false));
  }

  try {
    await exchangeCode(code);
  } catch (e) {
    console.error('[pipedrive] token exchange failed', e.message);
    return res.status(500).send(page('Connection failed', 'Something went wrong connecting to Pipedrive. Please try the install link again.', false));
  }

  // Register webhooks (best effort). Pipedrive posts here when deals change or activities are added.
  const host = `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
  const subs = [['deal', 'change'], ['deal', 'create'], ['activity', 'create']];
  try {
    const existing = await api('GET', '/api/v1/webhooks');
    const have = new Set((existing.data || []).map((w) => `${w.event_object}:${w.event_action}:${w.subscription_url}`));
    for (const [obj, action] of subs) {
      const url = `${host}/api/pipedrive/webhook`;
      if (have.has(`${obj}:${action}:${url}`)) continue;
      await api('POST', '/api/v1/webhooks', {
        subscription_url: url, event_object: obj, event_action: action,
        http_auth_user: 'pipedrive', http_auth_password: webhookPassword(), version: '2.0',
      });
    }
  } catch (e) {
    console.error('[pipedrive] webhook registration failed', e.message);
  }

  return res.status(200).send(page('Pipedrive connected', 'Thank you. New Intel case leads will now flow into your Pipedrive automatically. You can close this window.'));
};
