#!/usr/bin/env node
/**
 * fetch-gads-stats.js
 * Pulls Google Ads campaign performance for the Psych Congress portfolio
 * and writes google_ads_stats.json for the Email Intelligence Dashboard.
 *
 * Runs inside GitHub Actions. Requires one secret:
 *   SUPERMETRICS_API_KEY   Supermetrics API key (hub.supermetrics.com > API)
 *
 * Optional overrides via env:
 *   GADS_ACCOUNT_ID        defaults to 3238274495 (HMP COMMUNICATIONS LLC)
 */

const fs = require('fs');

const API_KEY    = process.env.SUPERMETRICS_API_KEY;
const ACCOUNT_ID = process.env.GADS_ACCOUNT_ID || '3238274495';
const ENDPOINT   = 'https://api.supermetrics.com/enterprise/v2/query/data/json';

if (!API_KEY) {
  console.error('FATAL: SUPERMETRICS_API_KEY is not set.');
  process.exit(1);
}

// ---- Brand mapping keyed on the Google Ads campaign ID embedded in campaign names ----
const BRAND_MAP = {
  '462492177778': { code: 'USPC',    label: 'Psych Congress 2026',              hubspotCode: 'USPC 2026',      color: '#1e40af', bg: '#dbeafe' },
  '434313707032': { code: 'ELEVATE', label: 'Psych Congress Elevate 2026',      hubspotCode: 'Elevate 2026',   color: '#6b21a8', bg: '#f3e8ff' },
  '411814608312': { code: 'NPI',     label: 'Psych Congress NP Institute',      hubspotCode: 'NPI 2026',       color: '#92400e', bg: '#fef3c7' },
  '530249915653': { code: 'PAI',     label: 'PA Institute 2026',                hubspotCode: 'PAI 2026',       color: '#0369a1', bg: '#e0f2fe' },
  '522147924558': { code: 'PCR',     label: 'Psych Congress Regionals',         hubspotCode: 'PCR 2026',       color: '#9d174d', bg: '#fce7f3' },
  '518157066350': { code: 'PCCP',    label: 'Psych Congress Clinical Pearls',   hubspotCode: 'PCCP_26',        color: '#166534', bg: '#dcfce7' },
  '522563126180': { code: 'PUPC',    label: 'Psych Ultimate Psychopharm Course',hubspotCode: 'PUPC 2026',      color: '#30485f', bg: '#e2e8f0' },
  '525419094351': { code: 'MCDNPPA', label: 'Masterclass NP/PA 2026',           hubspotCode: 'MCD NP/PA 2026', color: '#7c2d12', bg: '#fed7aa' },
};

const CORE_SIX = ['USPC', 'ELEVATE', 'NPI', 'PAI', 'PCR', 'PCCP'];
const ALL_CODES = Object.values(BRAND_MAP).map(b => b.code);

const FIELDS = ['campaign', 'impressions', 'clicks', 'conversions', 'conversion_value', 'cost'];

function ymd(d) { return d.toISOString().slice(0, 10); }

async function query(startDate, endDate) {
  const payload = {
    ds_id: 'AW',
    ds_accounts: [ACCOUNT_ID],
    date_range_type: 'custom',
    start_date: startDate,
    end_date: endDate,
    fields: FIELDS,
    max_rows: 500,
    settings: {},
  };

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: payload }),
  });

  if (!res.ok) {
    throw new Error(`Supermetrics ${res.status}: ${await res.text()}`);
  }

  const json = await res.json();
  const rows = json?.data ?? json?.query?.data ?? [];
  if (!Array.isArray(rows) || rows.length < 2) {
    throw new Error('Unexpected Supermetrics response shape.');
  }
  return rows.slice(1); // drop header row
}

const r2 = n => Math.round(n * 100) / 100;
const r0 = n => Math.round(n);

/** Extract the trailing 12-digit campaign ID from a Google Ads campaign name. */
function campaignIdFrom(name) {
  const m = String(name).match(/(\d{12})\s*$/);
  return m ? m[1] : null;
}

/** Shorten "Psych Congress 2026 - Brand - 462492177778" to "Brand". */
function campaignLabel(name) {
  return String(name)
    .replace(/\s*-\s*\d{12}\s*$/, '')
    .replace(/^.*?\s+-\s+/, '')
    .trim() || String(name);
}

function rollup(rows) {
  const out = {};

  for (const row of rows) {
    const [name, impr, clicks, conv, value, cost] = row;
    const cid = campaignIdFrom(name);
    if (!cid || !BRAND_MAP[cid]) continue; // not a Psych portfolio campaign

    const meta = BRAND_MAP[cid];
    const b = (out[meta.code] ||= {
      ...meta, campaignId: cid, campaigns: [],
      impressions: 0, clicks: 0, conversions: 0, conversionValue: 0, cost: 0,
    });

    const nImpr = Number(impr) || 0, nClicks = Number(clicks) || 0;
    const nConv = Number(conv) || 0, nVal = Number(value) || 0, nCost = Number(cost) || 0;

    b.campaigns.push({
      name: campaignLabel(name),
      impressions: nImpr,
      clicks: nClicks,
      ctr: nImpr ? r2((nClicks / nImpr) * 100) : 0,
      cpc: nClicks ? r2(nCost / nClicks) : 0,
      conversions: r2(nConv),
      conversionValue: r2(nVal),
      cost: r2(nCost),
      roas: nCost ? r0((nVal / nCost) * 100) : 0,
      valueTracking: (nVal > 0 || nConv === 0) ? 'OK' : 'MISSING',
    });

    b.impressions += nImpr; b.clicks += nClicks;
    b.conversions += nConv; b.conversionValue += nVal; b.cost += nCost;
  }

  // Represent every portfolio brand, including ones with no spend at all
  for (const meta of Object.values(BRAND_MAP)) {
    if (!out[meta.code]) {
      out[meta.code] = {
        ...meta, campaigns: [], impressions: 0, clicks: 0, conversions: 0,
        conversionValue: 0, cost: 0, ctr: 0, cpc: 0, roas: 0, cpa: 0, convRate: 0,
        alert: `ZERO Google Ads presence. No active campaign found for ${meta.label}.`,
      };
    }
  }

  for (const b of Object.values(out)) {
    b.campaigns.sort((x, y) => y.cost - x.cost);
    b.ctr      = b.impressions ? r2((b.clicks / b.impressions) * 100) : 0;
    b.cpc      = b.clicks ? r2(b.cost / b.clicks) : 0;
    b.roas     = b.cost ? r0((b.conversionValue / b.cost) * 100) : 0;
    b.cpa      = b.conversions ? r2(b.cost / b.conversions) : 0;
    b.convRate = b.clicks ? r2((b.conversions / b.clicks) * 100) : 0;
    b.conversions     = r2(b.conversions);
    b.conversionValue = r2(b.conversionValue);
    b.cost            = r2(b.cost);
  }

  return out;
}

function portfolio(bucket, codes) {
  const acc = { impressions: 0, clicks: 0, conversions: 0, conversionValue: 0, cost: 0 };
  for (const c of codes) {
    const b = bucket[c];
    if (!b) continue;
    acc.impressions += b.impressions; acc.clicks += b.clicks;
    acc.conversions += b.conversions; acc.conversionValue += b.conversionValue;
    acc.cost += b.cost;
  }
  return {
    ...acc,
    conversions: r2(acc.conversions),
    conversionValue: r2(acc.conversionValue),
    cost: r2(acc.cost),
    ctr: acc.impressions ? r2((acc.clicks / acc.impressions) * 100) : 0,
    cpc: acc.clicks ? r2(acc.cost / acc.clicks) : 0,
    roas: acc.cost ? r0((acc.conversionValue / acc.cost) * 100) : 0,
    cpa: acc.conversions ? r2(acc.cost / acc.conversions) : 0,
    convRate: acc.clicks ? r2((acc.conversions / acc.clicks) * 100) : 0,
  };
}

/** Derive data quality alerts from the numbers rather than hardcoding them. */
function buildAlerts(ytd) {
  const alerts = [];

  for (const code of ALL_CODES) {
    const b = ytd[code];
    if (!b) continue;

    if (b.cost === 0) {
      alerts.push({
        severity: 'critical', brand: code,
        issue: `No Google Ads campaign is running for ${b.label}.`,
        detail: 'Every other brand in the portfolio has at least one active campaign.',
        action: 'Launch a Brand campaign for this event.',
      });
      continue;
    }

    for (const c of b.campaigns) {
      if (c.valueTracking === 'MISSING') {
        alerts.push({
          severity: 'critical', brand: code,
          issue: `Conversion value is not tracking on ${b.label} ${c.name}.`,
          detail: `${c.conversions} conversions recorded with $0.00 attributed value on $${c.cost.toLocaleString()} spend. The campaign cannot be evaluated on ROAS.`,
          action: 'Assign a value-bearing conversion action to this campaign in Google Ads.',
        });
      }
      if (c.cost > 250 && c.conversions === 0) {
        alerts.push({
          severity: 'warning', brand: code,
          issue: `${b.label} ${c.name} is spending with zero return.`,
          detail: `$${c.cost.toLocaleString()} spent for zero conversions at a $${c.cpc} CPC.`,
          action: 'Pause this campaign and reallocate the budget to the Brand campaign.',
        });
      }
    }

    if (b.roas > 0 && b.roas < 200 && b.cost > 1000) {
      alerts.push({
        severity: 'warning', brand: code,
        issue: `${b.label} is returning below a 200% ROAS.`,
        detail: `$${b.cost.toLocaleString()} spent for ${b.conversions} conversions and $${b.conversionValue.toLocaleString()} of value, a ${b.roas}% ROAS.`,
        action: 'Pause the weakest campaigns and keep Brand only.',
      });
    }
  }

  const order = { critical: 0, warning: 1, info: 2 };
  return alerts.sort((a, b) => order[a.severity] - order[b.severity]);
}

(async () => {
  const today = new Date();
  const yStart = `${today.getFullYear()}-01-01`;
  const d30 = new Date(today); d30.setDate(d30.getDate() - 30);

  console.log(`Pulling Google Ads for account ${ACCOUNT_ID}...`);
  const [ytdRows, last30Rows] = await Promise.all([
    query(yStart, ymd(today)),
    query(ymd(d30), ymd(today)),
  ]);
  console.log(`  YTD rows: ${ytdRows.length} | Last 30 rows: ${last30Rows.length}`);

  const ytd = rollup(ytdRows);
  const last30 = rollup(last30Rows);

  const payload = {
    generatedAt: new Date().toISOString(),
    generatedBy: 'github-action-supermetrics',
    source: 'Google Ads via Supermetrics (ds_id AW)',
    account: { id: ACCOUNT_ID, name: 'HMP COMMUNICATIONS LLC', currency: 'USD' },
    periods: {
      ytd:    { label: `${today.getFullYear()} YTD`, startDate: yStart,   endDate: ymd(today) },
      last30: { label: 'Last 30 Days',               startDate: ymd(d30), endDate: ymd(today) },
    },
    portfolio: {
      ytd:    portfolio(ytd, CORE_SIX),
      last30: portfolio(last30, CORE_SIX),
    },
    portfolioAllPsych: {
      ytd:    portfolio(ytd, ALL_CODES),
      last30: portfolio(last30, ALL_CODES),
    },
    brands: { ytd, last30 },
    dataQualityAlerts: buildAlerts(ytd),
  };

  fs.writeFileSync('google_ads_stats.json', JSON.stringify(payload, null, 2));

  const p = payload.portfolio.ytd;
  console.log(`\nCore six: $${p.cost.toLocaleString()} spend -> $${p.conversionValue.toLocaleString()} value (${p.roas}% ROAS)`);
  console.log(`Alerts: ${payload.dataQualityAlerts.length}`);
  console.log('Wrote google_ads_stats.json');
})().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
