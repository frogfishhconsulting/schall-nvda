// Lead intake endpoint for the INTC landing page.
// Scores the lead from class-period cost basis, then fans out to whatever is configured:
//   LEAD_WEBHOOK_URL   -> CRM / Zapier / Make (full JSON lead)
//   SLACK_WEBHOOK_URL  -> Slack lead notification
//   META_PIXEL_ID + META_CAPI_TOKEN -> Meta Conversions API (Lead, plus QualifiedLead for tier A/B)
// Set these in Vercel: Project > Settings > Environment Variables.

const crypto = require('crypto');
const pd = require('../lib/pipedrive');

const CASE = { ticker: 'INTC', start: '2026-07-23', end: '2026-10-29' };

// Tier thresholds on cost basis in the class period (USD). Keep in sync with index.html.
const TIERS = [['A', 1000000], ['B', 500000], ['C', 100000], ['D', 0]];
// Value sent to ad platforms per tier, so bidding favors bigger investors. Relative weights, not dollars owed.
const TIER_VALUE = { A: 1000, B: 400, C: 100, D: 10 };
// Leads at or above this class-period cost basis get the priority booking link.
const PRIORITY_MIN = 500000;

const sha = (v) => crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');
const tierFor = (basis) => (TIERS.find(([, min]) => basis >= min) || ['D'])[0];

// Buckets mirror index.html. "min" is the conservative cost basis used for scoring.
const WINDOWS = { '2026-07': 'Jul 23 to 31', '2026-08': 'August', '2026-09': 'September', '2026-10': 'Oct 1 to 29', outside: 'Other dates' };
const AMOUNTS = {
  under_100k: ['Under $100K', 0], '100k_250k': ['$100K to $250K', 100000], '250k_500k': ['$250K to $500K', 250000],
  '500k_1m': ['$500K to $1M', 500000], '1m_5m': ['$1M to $5M', 1000000], over_5m: ['Over $5M', 5000000],
};

function score(lead) {
  const windows = (Array.isArray(lead.purchase_windows) ? lead.purchase_windows : []).filter((w) => WINDOWS[w]);
  const inPeriod = windows.filter((w) => w !== 'outside');
  const amt = AMOUNTS[lead.amount_bucket] || AMOUNTS.under_100k;
  const basis = inPeriod.length ? amt[1] : 0;
  const tier = tierFor(basis);
  return {
    purchase_windows: windows,
    purchase_window_labels: inPeriod.map((w) => WINDOWS[w]),
    also_bought_outside_period: windows.includes('outside'),
    amount_bucket: lead.amount_bucket || null,
    amount_label: amt[0],
    est_cost_basis_min: basis,
    lead_tier: tier,
    priority: basis >= PRIORITY_MIN,
    value: TIER_VALUE[tier],
  };
}

// Push the lead into Pipedrive (person + lead + note), if the firm has connected Pipedrive.
async function pushPipedrive(r, s) {
  const t = await pd.loadTokens().catch(() => null);
  if (!t) return false;
  const fmt = (n) => '$' + Number(n).toLocaleString('en-US');
  try {
    let personId;
    const found = await pd.api('GET', `/api/v2/persons/search?term=${encodeURIComponent(r.email)}&fields=email&exact_match=true&limit=1`);
    personId = found?.data?.items?.[0]?.item?.id;
    if (!personId) {
      const created = await pd.api('POST', '/api/v2/persons', {
        name: `${r.first_name} ${r.last_name}`.trim(),
        emails: [{ value: r.email, primary: true, label: 'work' }],
        phones: [{ value: r.phone, primary: true, label: 'mobile' }],
      });
      personId = created.data.id;
    }
    const lead = await pd.api('POST', '/api/v1/leads', {
      title: `INTC | Tier ${s.lead_tier}${s.priority ? ' PRIORITY' : ''} | ${r.first_name} ${r.last_name} | ${s.amount_label}`,
      person_id: personId,
      value: { amount: s.est_cost_basis_min, currency: 'USD' },
    });
    const src = [r.utm_source, r.utm_medium, r.utm_campaign].filter(Boolean).join(' / ') || (r.gclid ? 'google (gclid)' : r.fbclid ? 'meta (fbclid)' : 'direct');
    await pd.api('POST', '/api/v1/notes', {
      lead_id: lead.data.id,
      content: `<b>INTC intake: Tier ${s.lead_tier}${s.priority ? ' (priority, booking link shown)' : ''}</b><br>` +
        `Amount invested in class period: <b>${s.amount_label}</b><br>` +
        `Bought: ${s.purchase_window_labels.join(', ') || 'n/a'}${s.also_bought_outside_period ? ' (also bought outside the class period)' : ''}<br>` +
        `Source: ${src}<br>` +
        `Consent: SMS/calls ${r.consent?.sms_calls ? 'YES' : 'NO'}, email updates ${r.consent?.email_updates ? 'YES' : 'NO'} (captured ${r.consent?.captured_at || r.received_at}, IP ${r.consent?.ip || 'n/a'}, ${r.consent?.version || ''})<br>Lead ID: ${r.lead_id}`,
    });
    return true;
  } catch (e) {
    console.error('[lead] pipedrive', e.message);
    return false;
  }
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

  const s = score(lead);
  const record = {
    ...lead,
    ...s,
    case: CASE.ticker,
    received_at: new Date().toISOString(),
    consent: { ...(lead.consent || {}), ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null, user_agent: req.headers['user-agent'] || null },
    lead_id: lead.event_id,
  };

  const jobs = [];

  if (process.env.LEAD_WEBHOOK_URL) jobs.push(post(process.env.LEAD_WEBHOOK_URL, record, 'crm'));

  if (process.env.SLACK_WEBHOOK_URL) {
    const fmt = (n) => '$' + Number(n).toLocaleString('en-US');
    const src = [record.utm_source, record.utm_campaign].filter(Boolean).join(' / ') || (record.gclid ? 'google' : record.fbclid ? 'meta' : 'direct');
    jobs.push(post(process.env.SLACK_WEBHOOK_URL, {
      text: `${s.priority ? 'PRIORITY ' : ''}New INTC lead: Tier ${s.lead_tier} | ${s.amount_label} | ${record.first_name} ${record.last_name}`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `${s.priority ? ':star: *PRIORITY: booking link shown*\n' : ''}*New INTC lead: Tier ${s.lead_tier}*\n*${record.first_name} ${record.last_name}*  |  ${record.phone}  |  ${record.email}` } },
        { type: 'section', fields: [
          { type: 'mrkdwn', text: `*Amount invested*\n${s.amount_label}` },
          { type: 'mrkdwn', text: `*When bought*\n${s.purchase_window_labels.join(', ') || '-'}${s.also_bought_outside_period ? ' (+ outside period)' : ''}` },
          { type: 'mrkdwn', text: `*Source*\n${src}` },
          { type: 'mrkdwn', text: `*OK to text/call*\n${record.consent?.sms_calls ? 'Yes' : 'No'}` },
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

  jobs.push(pushPipedrive(record, s));

  await Promise.all(jobs);
  console.log(`[lead] ${record.lead_id} tier=${s.lead_tier} amount=${s.amount_bucket} src=${record.utm_source || record.gclid ? 'paid' : 'direct'}`);

  return res.status(200).json({ ok: true, lead_tier: s.lead_tier, priority: s.priority, value: s.value });
};
