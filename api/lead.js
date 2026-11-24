// Lead intake endpoint for the INTC landing page.
// Scores the lead from class-period cost basis, then fans out to whatever is configured:
//   LEAD_WEBHOOK_URL   -> CRM / Zapier / Make (full JSON lead)
//   SLACK_WEBHOOK_URL  -> Slack lead notification
//   META_PIXEL_ID + META_CAPI_TOKEN -> Meta Conversions API (Lead, plus QualifiedLead for tier A/B)
// Set these in Vercel: Project > Settings > Environment Variables.

const crypto = require('crypto');

const CASE = { ticker: 'INTC', start: '2026-07-23', end: '2026-10-29' };

// Tier thresholds on cost basis in the class period (USD). Keep in sync with index.html.
const TIERS = [['A', 1000000], ['B', 500000], ['C', 100000], ['D', 0]];
// Value sent to ad platforms per tier, so bidding favors bigger investors. Relative weights, not dollars owed.
const TIER_VALUE = { A: 1000, B: 400, C: 100, D: 10 };

const sha = (v) => crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');
const tierFor = (basis) => (TIERS.find(([, min]) => basis >= min) || ['D'])[0];

function score(purchases) {
  const clean = (Array.isArray(purchases) ? purchases : [])
    .map((p) => ({ date: String(p.date || ''), shares: Number(p.shares) || 0, price: Number(p.price) || 0 }))
    .filter((p) => p.date && p.shares > 0 && p.price > 0)
    .slice(0, 50);
  const inPeriod = clean.filter((p) => p.date >= CASE.start && p.date <= CASE.end);
  const basis = inPeriod.reduce((sum, p) => sum + p.shares * p.price, 0);
  const shares = inPeriod.reduce((sum, p) => sum + p.shares, 0);
  const tier = tierFor(basis);
  return {
    purchases: clean,
    class_period_purchases: inPeriod.length,
    class_period_shares: shares,
    class_period_cost_basis: Math.round(basis),
    avg_cost_per_share: shares ? Math.round((basis / shares) * 100) / 100 : 0,
    first_purchase: inPeriod.map((p) => p.date).sort()[0] || null,
    last_purchase: inPeriod.map((p) => p.date).sort().slice(-1)[0] || null,
    lead_tier: tier,
    value: TIER_VALUE[tier],
  };
}

async function post(url, body, label) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) console.error(`[lead] ${label} failed: ${r.status} ${await r.text()}`);
    return r.ok;
  } catch (e) {
    console.error(`[lead] ${label} error: ${e.message}`);
    return false;
  }
}

function metaEvent(name, lead, s, req) {
  const ph = String(lead.phone || '').replace(/\D/g, '');
  return {
    event_name: name,
    event_time: Math.floor(Date.now() / 1000),
    event_id: name === 'Lead' ? lead.event_id : `${lead.event_id}_${name}`,
    action_source: 'website',
    event_source_url: lead.page_url,
    user_data: {
      em: lead.email ? [sha(lead.email)] : undefined,
      ph: ph ? [sha(ph.length === 10 ? '1' + ph : ph)] : undefined,
      fn: lead.first_name ? [sha(lead.first_name)] : undefined,
      ln: lead.last_name ? [sha(lead.last_name)] : undefined,
      fbp: lead.fbp || undefined,
      fbc: lead.fbc || undefined,
      client_ip_address: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || undefined,
      client_user_agent: req.headers['user-agent'] || undefined,
    },
    custom_data: { case: CASE.ticker, lead_tier: s.lead_tier, value: s.value, currency: 'USD' },
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });

  const lead = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  if (lead.company_website) return res.status(200).json({ ok: true }); // honeypot
  if (!lead.email || !lead.phone || !lead.first_name) return res.status(400).json({ ok: false, error: 'missing_fields' });

  const s = score(lead.purchases);
  const record = {
    ...lead,
    ...s,
    case: CASE.ticker,
    received_at: new Date().toISOString(),
    lead_id: lead.event_id,
  };

  const jobs = [];

  if (process.env.LEAD_WEBHOOK_URL) jobs.push(post(process.env.LEAD_WEBHOOK_URL, record, 'crm'));

  if (process.env.SLACK_WEBHOOK_URL) {
    const fmt = (n) => '$' + Number(n).toLocaleString('en-US');
    const src = [record.utm_source, record.utm_campaign].filter(Boolean).join(' / ') || (record.gclid ? 'google' : record.fbclid ? 'meta' : 'direct');
    jobs.push(post(process.env.SLACK_WEBHOOK_URL, {
      text: `New INTC lead: Tier ${s.lead_tier} | ${fmt(s.class_period_cost_basis)} cost basis | ${record.first_name} ${record.last_name}`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `*New INTC lead: Tier ${s.lead_tier}*\n*${record.first_name} ${record.last_name}*  |  ${record.phone}  |  ${record.email}` } },
        { type: 'section', fields: [
          { type: 'mrkdwn', text: `*Class period cost basis*\n${fmt(s.class_period_cost_basis)}` },
          { type: 'mrkdwn', text: `*Shares / avg cost*\n${s.class_period_shares.toLocaleString('en-US')} @ $${s.avg_cost_per_share}` },
          { type: 'mrkdwn', text: `*Purchases in period*\n${s.class_period_purchases} (${s.first_purchase || '-'} to ${s.last_purchase || '-'})` },
          { type: 'mrkdwn', text: `*Source*\n${src}` },
        ] },
      ],
    }, 'slack'));
  }

  if (process.env.META_PIXEL_ID && process.env.META_CAPI_TOKEN) {
    const events = [metaEvent('Lead', record, s, req)];
    if (s.lead_tier === 'A' || s.lead_tier === 'B') events.push(metaEvent('QualifiedLead', record, s, req));
    const v = process.env.META_API_VERSION || 'v21.0';
    const body = { data: events };
    if (process.env.META_TEST_EVENT_CODE) body.test_event_code = process.env.META_TEST_EVENT_CODE;
    jobs.push(post(`https://graph.facebook.com/${v}/${process.env.META_PIXEL_ID}/events?access_token=${process.env.META_CAPI_TOKEN}`, body, 'meta_capi'));
  }

  await Promise.all(jobs);
  console.log(`[lead] ${record.lead_id} tier=${s.lead_tier} basis=${s.class_period_cost_basis} src=${record.utm_source || record.gclid ? 'paid' : 'direct'}`);

  return res.status(200).json({ ok: true, lead_tier: s.lead_tier, value: s.value });
};
