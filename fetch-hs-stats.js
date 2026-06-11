/**
 * fetch-hs-stats.js
 * Runs inside GitHub Actions (or locally with HUBSPOT_TOKEN set).
 * Calls the HubSpot Marketing Hub API, collects per-email statistics
 * for every sent email, and writes email_stats.json to the repo root.
 *
 * Required HubSpot Private App scope: content
 * Rate limit: 110 requests / 10 seconds  →  we sleep 100 ms between stat calls
 */

const axios = require('axios');
const fs    = require('fs');

const TOKEN = process.env.HUBSPOT_TOKEN;
if (!TOKEN) {
  console.error('ERROR: HUBSPOT_TOKEN environment variable is not set.');
  process.exit(1);
}

const BASE    = 'https://api.hubapi.com';
const HEADERS = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

const BRAND_RULES = [
  { pattern: /^(USPC|PC2|USPC2)/i,       brand: 'USPC',    label: 'Psych Congress'  },
  { pattern: /^(Elevate)/i,               brand: 'ELEVATE', label: 'Elevate'         },
  { pattern: /^(NPI|NPI2|NP Institute)/i, brand: 'NPI',     label: 'NP Institute'    },
  { pattern: /^(PAI|PAI2|PA Institute)/i, brand: 'PAI',     label: 'PA Institute'    },
  { pattern: /^(PCR|PCR2)/i,              brand: 'PCR',     label: 'PC Regionals'    },
  { pattern: /^(PCCP)/i,                  brand: 'PCCP',    label: 'Clinical Pearls' },
];

function detectBrand(name = '') {
  for (const r of BRAND_RULES) {
    if (r.pattern.test(name.trim())) return { brand: r.brand, label: r.label };
  }
  return { brand: 'OTHER', label: 'Other' };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchAllEmails() {
  const all = [];
  let after;
  let page = 0;
  do {
    const params = { limit: 100 };
    if (after) params.after = after;
    const res = await axios.get(`${BASE}/marketing/v3/emails`, { headers: HEADERS, params });
    all.push(...(res.data.results || []));
    after = res.data.paging?.next?.after;
    page++;
    console.log(`  Page ${page}: fetched ${res.data.results?.length ?? 0} emails (total: ${all.length})`);
  } while (after && page < 30);
  return all;
}

async function fetchStats(emailId) {
  try {
    const res = await axios.get(
      `${BASE}/marketing/v3/emails/${emailId}/statistics`,
      { headers: HEADERS, params: { period: 'TOTAL' } }
    );
    return res.data;
  } catch (e) {
    if (e.response?.status !== 404) {
      console.warn(`  WARN: ${emailId}: ${e.response?.status} ${e.response?.data?.message || ''}`);
    }
    return null;
  }
}

async function main() {
  console.log('=== HubSpot Email Stats Refresh ===');
  console.log(`Started: ${new Date().toISOString()}`);

  console.log('\n[1/3] Fetching email list...');
  const allEmails = await fetchAllEmails();
  console.log(`Total emails: ${allEmails.length}`);

  const sent = allEmails.filter(e => e.state === 'SENT' || e.stats?.processed > 0);
  console.log(`Sent emails: ${sent.length}`);

  console.log('\n[2/3] Fetching per-email statistics...');
  const results = [];
  let processed = 0;

  for (const email of sent) {
    const stats = await fetchStats(email.id);
    processed++;
    if (stats) {
      const c = stats.counters || {};
      const r = stats.ratios   || {};
      const { brand, label } = detectBrand(email.name);
      results.push({
        id:           email.id,
        name:         email.name         || '',
        subject:      email.subject      || '',
        sendDate:     email.sendDate     || '',
        fromName:     email.fromName     || '',
        fromEmail:    email.fromEmail    || '',
        campaignName: email.campaignName || '',
        brand,
        brandLabel:   label,
        state:        email.state        || '',
        delivered:    c.delivered        ?? 0,
        sent:         c.sent             ?? 0,
        opens:        c.open             ?? 0,
        clicks:       c.click            ?? 0,
        hardBounces:  c.hardBounced      ?? 0,
        softBounces:  c.softBounced      ?? 0,
        unsubscribes: c.unsubscribed     ?? 0,
        spamReports:  c.spamreport       ?? 0,
        openRate:     r.openRate             ? +((r.openRate)             * 100).toFixed(2) : 0,
        clickRate:    r.clickRate            ? +((r.clickRate)            * 100).toFixed(2) : 0,
        ctor:         r.clickThroughRate     ? +((r.clickThroughRate)     * 100).toFixed(2) : 0,
        bounceRate:   r.bounceRate           ? +((r.bounceRate)           * 100).toFixed(2) : 0,
        unsubRate:    r.unsubscribedRate     ? +((r.unsubscribedRate)     * 100).toFixed(2) : 0,
        spamRate:     r.spamreportRate       ? +((r.spamreportRate)       * 100).toFixed(2) : 0,
      });
    }
    if (processed % 50 === 0) console.log(`  Progress: ${processed}/${sent.length}...`);
    await sleep(100);
  }

  results.sort((a, b) => new Date(b.sendDate) - new Date(a.sendDate));

  const brandSummary = {};
  for (const e of results) {
    if (!brandSummary[e.brand]) {
      brandSummary[e.brand] = { brand: e.brand, label: e.brandLabel,
        totalSent: 0, totalDelivered: 0, openRates: [], clickRates: [],
        sent2026: 0, delivered2026: 0, openRates2026: [], clickRates2026: [] };
    }
    const b = brandSummary[e.brand];
    b.totalSent++;
    b.totalDelivered += e.delivered;
    if (e.delivered > 0) { b.openRates.push(e.openRate); b.clickRates.push(e.clickRate); }
    if (e.sendDate && e.sendDate.startsWith('2026')) {
      b.sent2026++; b.delivered2026 += e.delivered;
      if (e.delivered > 0) { b.openRates2026.push(e.openRate); b.clickRates2026.push(e.clickRate); }
    }
  }

  const avg = arr => arr.length ? +(arr.reduce((s,v)=>s+v,0)/arr.length).toFixed(2) : 0;
  const brandStats = Object.values(brandSummary).map(b => ({
    brand: b.brand, label: b.label,
    totalSent: b.totalSent, totalDelivered: b.totalDelivered,
    avgOpenRate: avg(b.openRates), avgClickRate: avg(b.clickRates),
    sent2026: b.sent2026, delivered2026: b.delivered2026,
    avgOpenRate2026: avg(b.openRates2026), avgClickRate2026: avg(b.clickRates2026),
  }));

  console.log('\n[3/3] Writing email_stats.json...');
  const output = {
    generatedAt: new Date().toISOString(),
    generatedBy: 'github-actions/refresh-hs-data',
    totalEmails: results.length,
    brandStats,
    emails: results,
  };

  fs.writeFileSync('email_stats.json', JSON.stringify(output, null, 2), 'utf8');
  console.log(`\n✅ Done. Wrote ${results.length} emails to email_stats.json`);
  console.log(`   Brands: ${brandStats.map(b=>`${b.brand}(${b.totalSent})`).join(', ')}`);
  console.log(`   Finished: ${new Date().toISOString()}`);
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err.message);
  if (err.response) {
    console.error('   Status:', err.response.status);
    console.error('   Body:', JSON.stringify(err.response.data));
  }
  process.exit(1);
});
