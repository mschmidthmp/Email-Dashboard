/**
 * fetch-hs-stats.js
 *
 * Fetches HubSpot Marketing Email statistics and writes email_stats.json.
 *
 * WHY THIS WAS REWRITTEN
 *   The previous version fetched email metadata from /marketing/v3/emails and then
 *   looked for a `stats` object on the response. The v3 email object does not carry
 *   statistics, so every email fell through to "no stats object returned" and the
 *   output was always an empty list with no error raised.
 *
 *   HubSpot now publishes the statistics endpoint under a date-versioned route.
 *   Use the current route and the documented ISO 8601 date-time query values.
 *   Each request can still be filtered to a single emailId to read `aggregate`.
 *
 * Required credential:
 *   HUBSPOT_TOKEN (or HUBSPOT_ACCESS_TOKEN / HUBSPOT_SERVICE_KEY / HUBSPOT_API_KEY)
 *   Must be a private app access token sent as "Authorization: Bearer <token>".
 *
 * Required HubSpot scope: content, marketing-email, or transactional-email
 *
 * Optional env:
 *   HUBSPOT_STATS_START     ISO date to treat as "all time". Default 2019-01-01.
 *   HUBSPOT_MAX_PAGES       Email list pages to walk. Default 100.
 *   HUBSPOT_PAGE_LIMIT      Emails per page. Default 100.
 *   HUBSPOT_REQUEST_DELAY_MS Delay between stat batches. Default 110 ms.
 *   HUBSPOT_STATS_CONCURRENCY Parallel stat calls per batch. Default 8.
 *   HUBSPOT_STATS_LIMIT     Cap emails fetched for stats. Default 0 (no cap).
 *   OUTPUT_FILE             Default email_stats.json
 */

'use strict';

const fs = require('fs');

const BASE = process.env.HUBSPOT_API_BASE || 'https://api.hubapi.com';
const OUTPUT_FILE = process.env.OUTPUT_FILE || 'email_stats.json';
const MAX_PAGES = Number(process.env.HUBSPOT_MAX_PAGES || 100);
const STATS_API_VERSION = process.env.HUBSPOT_API_VERSION || '2026-03';
const STATS_PATH = process.env.HUBSPOT_STATS_PATH || `/marketing/emails/${STATS_API_VERSION}/statistics/list`;
const PAGE_LIMIT = Number(process.env.HUBSPOT_PAGE_LIMIT || 100);
const REQUEST_DELAY_MS = Number(process.env.HUBSPOT_REQUEST_DELAY_MS || 110);
const STATS_CONCURRENCY = Math.max(1, Number(process.env.HUBSPOT_STATS_CONCURRENCY || 8) || 8);
const STATS_LIMIT = Number(process.env.HUBSPOT_STATS_LIMIT || 0);
const STATS_START = process.env.HUBSPOT_STATS_START || '2019-01-01';

const BRAND_RULES = [
  { pattern: /^(USPC|PC2|USPC2|PUPC)/i, brand: 'USPC',    label: 'Psych Congress' },
  { pattern: /^(Elevate)/i,             brand: 'ELEVATE', label: 'Elevate' },
  { pattern: /^(NPI|NPI2|NP Institute)/i, brand: 'NPI',   label: 'NP Institute' },
  { pattern: /^(PAI|PAI2|PA Institute)/i, brand: 'PAI',   label: 'PA Institute' },
  { pattern: /^(PCR|PCR2)/i,            brand: 'PCR',     label: 'PC Regionals' },
  { pattern: /^(PCCP|CPC)/i,            brand: 'PCCP',    label: 'Clinical Pearls' },
];

function detectBrand(name = '') {
  for (const rule of BRAND_RULES) {
    if (rule.pattern.test(name.trim())) return { brand: rule.brand, label: rule.label };
  }
  return { brand: 'OTHER', label: 'Other' };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function getToken() {
  for (const name of ['HUBSPOT_TOKEN','HUBSPOT_ACCESS_TOKEN','HUBSPOT_SERVICE_KEY','HUBSPOT_API_KEY']) {
    const value = (process.env[name] || '').trim();
    if (value) return { name, value };
  }
  throw new Error('No HubSpot credential found. Set HUBSPOT_TOKEN to a private app access token.');
}

let credential;
const scrub = (m = '') => credential?.value ? m.split(credential.value).join('[redacted]') : m;

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { rawBody: text }; }
}

function getErrorMessage(status, body, url) {
  const msg = body?.message || body?.rawBody || '';
  const category = body?.category || '';
  const base = `HubSpot request failed (${status}) for ${url}. ${msg}`;
  if (status === 401) {
    return `${base} Authentication failed. This script needs a private app access token used as a Bearer token, not a legacy hapikey.`;
  }
  if (status === 403 || category === 'MISSING_SCOPES') {
    return `${base} Authorization failed. Confirm the token has one of the Marketing Emails API scopes: "content", "marketing-email", or "transactional-email". See https://developers.hubspot.com/scopes`;
  }
  return base;
}

/** GET with retry on 429. `repeatParams` sends the same key multiple times. */
async function hubspotGet(path, params = {}, options = {}) {
  const url = new URL(`${BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) value.forEach(v => url.searchParams.append(key, String(v)));
    else url.searchParams.set(key, String(value));
  }

  let attempt = 0;
  while (true) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${credential.value}`, Accept: 'application/json' },
    });
    const body = await readJson(response);

    if (response.ok) return body;
    if (response.status === 404 && options.allowNotFound) return null;
    if ((response.status === 400 || response.status === 500) && options.allowBadRequest) {
      return { __error: getErrorMessage(response.status, body, url.pathname) };
    }
    if (response.status === 429 && attempt < 5) {
      const wait = Math.max(1000, Number(response.headers.get('retry-after') || 1) * 1000);
      console.warn(`  WARN: rate limited, waiting ${wait}ms`);
      await sleep(wait);
      attempt++;
      continue;
    }
    throw new Error(scrub(getErrorMessage(response.status, body, url.pathname)));
  }
}

/**
 * Walk one page-cursor sequence to exhaustion (or MAX_PAGES), for a fixed set
 * of extra query params (e.g. a date window and/or sort order).
 * `allowBadRequest` lets the caller detect an unsupported param combo (HubSpot
 * returns 400) instead of crashing the whole run.
 */
async function walkEmailPages(extraParams, label) {
  const all = [];
  let after, page = 0;
  do {
    const params = { limit: PAGE_LIMIT, ...extraParams };
    if (after) params.after = after;
    const data = await hubspotGet('/marketing/v3/emails', params, { allowBadRequest: true });
    if (data && data.__error) return { results: all, error: data.__error };
    const results = data?.results || [];
    all.push(...results);
    after = data?.paging?.next?.after;
    page++;
  } while (after && page < MAX_PAGES);
  if (after) console.warn(`  WARN: ${label} stopped at HUBSPOT_MAX_PAGES=${MAX_PAGES} with more results remaining. Raise HUBSPOT_MAX_PAGES.`);
  return { results: all, error: null };
}

/**
 * WHY THIS IS WINDOWED BY YEAR (as opposed to one long walk)
 *   HubSpot's v3 list endpoints impose a hard ceiling (~10,000 records) on how
 *   far a single sequential `after`-cursor walk can advance, even when more
 *   matching rows exist beyond it — the cursor just stops. The previous
 *   version walked the entire portal history in one pass, in whatever order
 *   the API defaults to (observed to be oldest-created-first). Once the
 *   portal's total email count crossed that ceiling, the walk exhausted
 *   itself inside 2020-2022 and never reached 2023+ campaigns at all — which
 *   is exactly what a run of this script showed: 8,765 of 8,779 emails dated
 *   2020-2022, and only 14 total across 2023-2026.
 *
 *   Fixing this for good means no single walk should ever need to cross the
 *   ceiling. Splitting the fetch into one walk per calendar year (using the
 *   documented `createdAfter`/`createdBefore` filters, newest year first, and
 *   `sort=-createdAt` as a second line of defense) keeps every individual
 *   walk far under 10,000 rows — the busiest year on record so far is ~3,200.
 *
 *   Caveat: this windows on the email object's *creation* date, not its send
 *   date. For this portal's one-email-per-campaign pattern those are almost
 *   always close together, but a template object created long before a later
 *   reuse could in theory land in the wrong year's window. Recent-year totals
 *   should be sanity-checked against HubSpot's own reporting occasionally.
 *
 *   Resilience: if `createdAfter`/`createdBefore` ever turn out to be
 *   unsupported by the API (a 400 on the very first window), this falls back
 *   to a single walk sorted newest-first, and if even `sort` is rejected,
 *   falls back further to the original unsorted, unfiltered walk — so a
 *   documentation mismatch degrades gracefully instead of breaking the job.
 */
async function fetchAllEmails() {
  const byId = new Map();
  const startYear = Number(STATS_START.slice(0, 4)) || 2019;
  const endYear = new Date().getUTCFullYear();
  const nowISO = new Date().toISOString();

  let windowingWorked = true;
  for (let y = endYear; y >= startYear; y--) {
    const wStartISO = new Date(y === startYear ? STATS_START : `${y}-01-01T00:00:00.000Z`).toISOString();
    const wEndISO = y === endYear ? nowISO : new Date(`${y + 1}-01-01T00:00:00.000Z`).toISOString();

    const { results, error } = await walkEmailPages(
      { sort: '-createdAt', createdAfter: wStartISO, createdBefore: wEndISO },
      `${y} window`
    );

    if (error) {
      console.warn(`  WARN: date-windowed email listing failed for ${y} (${error}). Abandoning per-year windowing and falling back to a single sorted walk.`);
      windowingWorked = false;
      byId.clear();
      break;
    }

    let added = 0;
    for (const r of results) if (!byId.has(r.id)) { byId.set(r.id, r); added++; }
    console.log(`  ${y}: ${results.length} emails returned, ${added} new (running total ${byId.size})`);

    // Cheap self-check, run once we have a window with a real (non-"now")
    // upper bound: if createdBefore isn't actually being enforced by the API,
    // this year's results will include emails created after wEndISO. If so,
    // that single walk already contains the full newest-first history (bounded
    // by MAX_PAGES), so further per-year windows would just be redundant,
    // rate-limit-risking repeats of the same request. Stop here instead.
    if (y < endYear) {
      const leaked = results.some(r => r.createdAt && new Date(r.createdAt).toISOString() > wEndISO);
      if (leaked) {
        // IMPORTANT: don't just keep what this window happened to return — it
        // was requested with createdAfter=${y}-01-01, so even though it's not
        // respecting createdBefore, it's still MISSING everything created
        // before ${y}-01-01 (all older years). The only safe move is to
        // discard the partial per-year results and fall through to the Tier-2
        // fallback below, which re-fetches from the true start of the whole
        // STATS_START..now range in one sorted walk.
        console.warn(`  WARN: createdBefore does not appear to be enforced by the API — the ${y} window returned newer emails too. Abandoning per-year windowing (it would miss everything before ${y}) and falling back to one full sorted walk instead.`);
        windowingWorked = false;
        byId.clear();
        break;
      }
    }
  }

  // --- Fallback tiers, only used if per-year windowing itself errored out. ---
  if (!windowingWorked) {
    const { results, error } = await walkEmailPages({ sort: '-createdAt' }, 'full sorted walk');
    if (!error) {
      for (const r of results) if (!byId.has(r.id)) byId.set(r.id, r);
    } else {
      console.warn(`  WARN: sorted email listing failed (${error}). Falling back to the original unsorted walk — recent years may be under-represented if the portal exceeds the API's pagination ceiling.`);
      const { results: legacyResults } = await walkEmailPages({}, 'legacy unsorted walk');
      for (const r of legacyResults) if (!byId.has(r.id)) byId.set(r.id, r);
    }
  }

  const all = Array.from(byId.values());

  // Diagnostic breakdown so future runs surface coverage gaps immediately in
  // the Action log, instead of silently shipping a partial dataset again.
  const byYear = {};
  for (const e of all) {
    const y = String(e.createdAt || e.updatedAt || '').slice(0, 4) || 'unknown';
    byYear[y] = (byYear[y] || 0) + 1;
  }
  console.log(`  Coverage by created-year: ${Object.entries(byYear).sort(([a], [b]) => a.localeCompare(b)).map(([y, n]) => `${y}=${n}`).join(', ')}`);

  return all;
}

/**
 * The date-versioned statistics endpoint requires ISO 8601 date-time values.
 */
const TS_FORMAT = 'iso-datetime';

function statsParams(startISO, endISO, emailId) {
  const start = new Date(startISO);
  const end = new Date(endISO);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error(`Invalid stats window. Start: ${startISO}; end: ${endISO}`);
  }

  return {
    startTimestamp: start.toISOString(),
    endTimestamp: end.toISOString(),
    ...(emailId !== undefined ? { emailIds: [emailId] } : {}),
  };
}

/** Per-email stats: filter statistics/list to one emailId, read aggregate. */
async function fetchEmailStats(emailId, startISO, endISO) {
  const res = await hubspotGet(
    STATS_PATH,
    statsParams(startISO, endISO, emailId),
    { allowBadRequest: true }
  );
  if (!res || res.__error) return null;
  return res.aggregate || null;
}

const firstValue = (...v) => v.find(x => x !== undefined && x !== null && x !== '') || '';

function buildEmailResult(email, aggregate) {
  const counters = aggregate?.counters || {};
  const ratios = aggregate?.ratios || {};
  const { brand, label } = detectBrand(email.name);
  const delivered = counters.delivered ?? 0;
  const opens = counters.open ?? counters.opens ?? 0;
  const clicks = counters.click ?? counters.clicks ?? 0;

  return {
    id: email.id,
    name: email.name || '',
    subject: email.subject || '',
    sendDate: firstValue(email.publishDate, email.publishedAt, email.updatedAt, email.createdAt),
    fromName: email.from?.fromName || email.fromName || '',
    fromEmail: email.from?.replyTo || email.fromEmail || '',
    campaignName: email.campaignName || '',
    brand,
    brandLabel: label,
    state: email.state || '',
    delivered,
    sent: counters.sent ?? counters.processed ?? 0,
    opens,
    clicks,
    hardBounces: counters.hardbounced ?? counters.hardBounced ?? 0,
    softBounces: counters.softbounced ?? counters.softBounced ?? 0,
    unsubscribes: counters.unsubscribed ?? 0,
    spamReports: counters.spamreport ?? 0,
    // NOTE: HubSpot's `ratios` object is inconsistent across email types/API
    // versions — for most PUBLISHED emails it comes back already expressed as
    // a 0-100 percentage, not a 0-1 fraction. The previous version always did
    // pct(v) = v*100 on it, which double-scaled those values (e.g. a real
    // 26.27% open rate was stored as 2627). Raw counters are unambiguous
    // integers, so every rate is computed directly from them instead of
    // trusting the ratios object's scale.
    openRate: delivered ? +((opens / delivered) * 100).toFixed(2) : 0,
    clickRate: delivered ? +((clicks / delivered) * 100).toFixed(2) : 0,
    ctor: opens ? +((clicks / opens) * 100).toFixed(2) : 0,
    bounceRate: delivered ? +(((counters.hardbounced ?? counters.hardBounced ?? 0) + (counters.softbounced ?? counters.softBounced ?? 0)) / delivered * 100).toFixed(2) : 0,
    unsubRate: delivered ? +((counters.unsubscribed ?? 0) / delivered * 100).toFixed(2) : 0,
    spamRate: delivered ? +((counters.spamreport ?? 0) / delivered * 100).toFixed(2) : 0,
  };
}

const average = a => a.length ? +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(2) : 0;

function buildBrandStats(results) {
  const summary = {};
  for (const e of results) {
    const b = (summary[e.brand] ||= {
      brand: e.brand, label: e.brandLabel, totalSent: 0, totalDelivered: 0,
      openRates: [], clickRates: [], sent2026: 0, delivered2026: 0,
      openRates2026: [], clickRates2026: [],
    });
    b.totalSent++;
    b.totalDelivered += e.delivered;
    if (e.delivered > 0) { b.openRates.push(e.openRate); b.clickRates.push(e.clickRate); }
    if (String(e.sendDate).startsWith('2026')) {
      b.sent2026++;
      b.delivered2026 += e.delivered;
      if (e.delivered > 0) { b.openRates2026.push(e.openRate); b.clickRates2026.push(e.clickRate); }
    }
  }
  return Object.values(summary).map(b => ({
    brand: b.brand, label: b.label,
    totalSent: b.totalSent, totalDelivered: b.totalDelivered,
    avgOpenRate: average(b.openRates), avgClickRate: average(b.clickRates),
    sent2026: b.sent2026, delivered2026: b.delivered2026,
    avgOpenRate2026: average(b.openRates2026), avgClickRate2026: average(b.clickRates2026),
  })).sort((a, b) => b.totalDelivered - a.totalDelivered);
}

async function main() {
  credential = getToken();
  const endISO = new Date().toISOString();

  console.log('=== HubSpot Email Stats Refresh ===');
  console.log(`Started: ${endISO}`);
  console.log(`Credential source: ${credential.name}`);
  console.log(`Stats window: ${STATS_START} to ${endISO.slice(0, 10)}`);

  console.log('\n[1/4] Fetching email list...');
  const allEmails = await fetchAllEmails();
  console.log(`Total emails: ${allEmails.length}`);

  if (!allEmails.length) {
    throw new Error('Email list came back empty. The token is valid but sees no marketing emails. Check that it belongs to the correct HubSpot portal and has one of the Marketing Emails API scopes.');
  }

  // Only emails that actually went out can have stats.
  const candidates = allEmails.filter(e =>
    e.state === 'SENT' || e.state === 'PUBLISHED' || e.state === 'AUTOMATED_SENDING' || e.publishDate);
  console.log(`Sent/published candidates: ${candidates.length}`);

  const targets = STATS_LIMIT > 0 ? candidates.slice(0, STATS_LIMIT) : candidates;
  if (STATS_LIMIT > 0) console.log(`Capped to ${targets.length} by HUBSPOT_STATS_LIMIT`);

  console.log(`
[2/4] Fetching per-email statistics for ${targets.length} emails...`);
  const results = [];
  let noStats = 0;

  for (let i = 0; i < targets.length; i += STATS_CONCURRENCY) {
    const batch = targets.slice(i, i + STATS_CONCURRENCY);
    const batchResults = await Promise.all(batch.map(async email => {
      const aggregate = await fetchEmailStats(email.id, STATS_START, endISO);
      if (aggregate?.counters && (aggregate.counters.delivered > 0 || aggregate.counters.sent > 0)) {
        return buildEmailResult(email, aggregate);
      }
      return null;
    }));

    for (const item of batchResults) {
      if (item) results.push(item);
      else noStats++;
    }

    await sleep(REQUEST_DELAY_MS);
    const n = Math.min(i + batch.length, targets.length);
    if (n % 100 === 0 || n === targets.length) {
      console.log(`  ${n}/${targets.length} · kept ${results.length} · skipped ${noStats}`);
    }
  }


  if (!results.length) {
    throw new Error('Statistics endpoint responded but returned no delivered volume for any email. Widen HUBSPOT_STATS_START or confirm this portal has sent marketing emails.');
  }

  results.sort((a, b) => new Date(b.sendDate) - new Date(a.sendDate));

  console.log('\n[3/3] Writing output...');
  const brandStats = buildBrandStats(results);
  const totalDelivered = results.reduce((s, e) => s + e.delivered, 0);

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({
    generatedAt: new Date().toISOString(),
    generatedBy: 'fetch-hs-stats',
    statsWindow: { start: STATS_START, end: endISO },
    timestampFormat: TS_FORMAT,
    totalEmails: results.length,
    totalDelivered,
    emailsWithoutStats: noStats,
    brandStats,
    emails: results,
  }, null, 2), 'utf8');

  console.log(`Done. ${results.length} emails, ${totalDelivered.toLocaleString()} delivered -> ${OUTPUT_FILE}`);
  console.log(`Brands: ${brandStats.map(b => `${b.brand}(${b.totalSent})`).join(', ')}`);
}

main().catch(error => {
  console.error('\nFatal error:', scrub(error.message));
  console.error('Token setup: the HUBSPOT_TOKEN secret must be a HubSpot Private App access token with one of the Marketing Emails API scopes: "content", "marketing-email", or "transactional-email".');
  console.error('HubSpot scopes: https://developers.hubspot.com/scopes');
  process.exitCode = 1;
});
