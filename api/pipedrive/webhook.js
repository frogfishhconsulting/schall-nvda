// Receives Pipedrive webhooks (v2 payloads, v1 tolerated) and posts Slack alerts for:
//  - deal stage changes
//  - call activities logged
// Env: SLACK_WEBHOOK_URL (falls back to logging only)

const { api, webhookPassword } = require('../../lib/pipedrive');

const cache = {};
async function lookup(kind, id) {
  if (!id) return null;
  const k = `${kind}:${id}`;
  if (cache[k]) return cache[k];
  try {
    const path = kind === 'stage' ? `/api/v2/stages/${id}` : kind === 'user' ? `/api/v1/users/${id}` : `/api/v2/deals/${id}`;
    const j = await api('GET', path);
    cache[k] = j.data;
    return j.data;
  } catch (e) {
    console.error('[webhook] lookup', k, e.message);
    return null;
  }
}

async function slack(text) {
  if (!process.env.SLACK_WEBHOOK_URL) { console.log('[webhook] slack (not configured):', text); return; }
  await fetch(process.env.SLACK_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
    .catch((e) => console.error('[webhook] slack', e.message));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const expected = 'Basic ' + Buffer.from(`pipedrive:${webhookPassword()}`).toString('base64');
  if (req.headers.authorization !== expected) return res.status(401).end();

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const meta = body.meta || {};
  const entity = meta.entity || meta.object;               // v2: entity, v1: object
  const action = meta.action;                                // v2: create/change, v1: added/updated
  const cur = body.data || body.current || {};
  const prev = body.previous || {};

  try {
    if (entity === 'deal' && /change|updated/.test(action) && prev.stage_id != null && prev.stage_id !== cur.stage_id) {
      const [to, from, who] = await Promise.all([lookup('stage', cur.stage_id), lookup('stage', prev.stage_id), lookup('user', meta.user_id || cur.user_id)]);
      await slack(`:arrow_right: *${cur.title || 'Deal'}* moved from *${from?.name || prev.stage_id}* to *${to?.name || cur.stage_id}*${who?.name ? ` by ${who.name}` : ''}`);
    } else if (entity === 'deal' && /create|added/.test(action)) {
      await slack(`:new: New deal: *${cur.title || 'Untitled'}*`);
    } else if (entity === 'activity' && /create|added/.test(action) && cur.type === 'call') {
      const [deal, who] = await Promise.all([lookup('deal', cur.deal_id), lookup('user', cur.owner_id || cur.user_id)]);
      await slack(`:telephone_receiver: Call logged${who?.name ? ` by ${who.name}` : ''}${deal?.title ? ` on *${deal.title}*` : ''}: ${cur.subject || ''}`);
    }
  } catch (e) {
    console.error('[webhook] handler', e.message);
  }
  return res.status(200).json({ ok: true });
};
