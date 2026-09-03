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
 *   v3 has no lifetime-stats endpoint. Statistics live at
 *   /marketing/v3/emails/statistics/list and REQUIRE a time span. To get per-email
 *   numbers you filter that endpoint to a single emailId and read `aggregate`.
 *   That is what this version does.
 *
 * Required credential:
 *   HUBSPOT_TOKEN (or HUBSPOT_ACCESS_TOKEN / HUBSPOT_SERVICE_KEY / HUBSPOT_API_KEY)
 *   Must be a private app access token sent as "Authorization: Bearer <token>".
 *
 * Required HubSpot scope: content
 *
 * Optional env:
 *   HUBSPOT_STATS_START     ISO date to treat as "all time". Default 2019-01-01.
 *   HUBSPOT_MAX_PAGES       Email list pages to walk. Default 60.
 *   HUBSPOT_PAGE_LIMIT      Emails per page. Default 100.
 *   HUBSPOT_REQUEST_DELAY_MS Delay between stat calls. Default 110 (approx 9/sec).
 *   HUBSPOT_STATS_LIMIT     Cap emails fetched for stats. Default 0 (no cap).
 *   OUTPUT_FILE             Default email_stats.json
 */

'use strict';

const fs = require('fs');

const BASE = 'https://api.hubapi.com';
const OUTPUT_FILE = process.env.OUTPUT_FILE || 'email_stats.json';
const MAX_PAGES = Number(process.env.HUBSPOT_MAX_PAGES || 60);
const PAGE_LIMIT = Number(process.env.HUBSPOT_PAGE_LIMIT || 100);
const REQUEST_DELAY_MS = Number(process.env.HUBSPOT_REQUEST_DELAY_MS || 110);
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
    return `${base} Authorization failed. Confirm the token has the "content" scope. See https://developers.hubspot.com/scopes`;
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

async function fetchAllEmails() {
  const all = [];
  let after, page = 0;
  do {
    const params = { limit: PAGE_LIMIT };
    if (after) params.after = after;
    const data = await hubspotGet('/marketing/v3/emails', params);
    const results = data?.results || [];
    all.push(...results);
    after = data?.paging?.next?.after;
    page++;
    console.log(`  Page ${page}: ${results.length} emails (total ${all.length})`);
  } while (after && page < MAX_PAGES);

  if (after) console.warn(`  WARN: stopped at HUBSPOT_MAX_PAGES=${MAX_PAGES}. Raise it to fetch more.`);
  return all;
}

/**
 * The statistics endpoint has had timestamp-parsing quirks across accounts.
 * Probe the accepted format once, then reuse it for every subsequent call.
 */
let TS_FORMAT = null;

function tsVariants(startISO, endISO) {
  const s = new Date(startISO), e = new Date(endISO);
  return [
    { name: 'iso-datetime', start: s.toISOString().replace(/\.\d{3}Z$/, 'Z'), end: e.toISOString().replace(/\.\d{3}Z$/, 'Z') },
    { name: 'epoch-millis', start: String(s.getTime()), end: String(e.getTime()) },
    { name: 'iso-date',     start: startISO.slice(0, 10), end: endISO.slice(0, 10) },
  ];
}

async function probeTimestampFormat(startISO, endISO) {
  for (const v of tsVariants(startISO, endISO)) {
    const res = await hubspotGet('/marketing/v3/emails/statistics/list',
      { startTimestamp: v.start, endTimestamp: v.end }, { allowBadRequest: true });
    if (res && !res.__error) {
      console.log(`  Timestamp format accepted: ${v.name}`);
      TS_FORMAT = v.name;
      return res;
    }
    console.warn(`  Format ${v.name} rejected: ${res?.__error?.slice(0, 110)}`);
    await sleep(REQUEST_DELAY_MS);
  }
  throw new Error('No accepted timestamp format for /marketing/v3/emails/statistics/list.');
}

function tsFor(startISO, endISO) {
  const v = tsVariants(startISO, endISO).find(x => x.name === TS_FORMAT);
  return { startTimestamp: v.start, endTimestamp: v.end };
}

/** Per-email stats: filter statistics/list to one emailId, read `aggregate`. */
async function fetchEmailStats(emailId, startISO, endISO) {
  const res = await hubspotGet('/marketing/v3/emails/statistics/list',
    { ...tsFor(startISO, endISO), emailIds: [emailId] }, { allowBadRequest: true });
  if (!res || res.__error) return null;
  return res.aggregate || null;
}

const pct = v => v ? +(Number(v) * 100).toFixed(2) : 0;
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
    // Prefer HubSpot's ratios; fall back to computing from counters.
    openRate: ratios.openratio != null ? pct(ratios.openratio)
            : ratios.openRate  != null ? pct(ratios.openRate)
            : delivered ? +((opens / delivered) * 100).toFixed(2) : 0,
    clickRate: ratios.clickratio != null ? pct(ratios.clickratio)
             : ratios.clickRate  != null ? pct(ratios.clickRate)
             : delivered ? +((clicks / delivered) * 100).toFixed(2) : 0,
    ctor: ratios.clickthroughratio != null ? pct(ratios.clickthroughratio)
        : ratios.clickThroughRate  != null ? pct(ratios.clickThroughRate)
        : opens ? +((clicks / opens) * 100).toFixed(2) : 0,
    bounceRate: pct(ratios.bounceratio ?? ratios.bounceRate),
    unsubRate: pct(ratios.unsubscribedratio ?? ratios.unsubscribedRate),
    spamRate: pct(ratios.spamreportratio ?? ratios.spamreportRate),
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
    throw new Error('Email list came back empty. The token is valid but sees no marketing emails. Check that it belongs to the correct HubSpot portal and has the "content" scope.');
  }

  // Only emails that actually went out can have stats.
  const candidates = allEmails.filter(e =>
    e.state === 'SENT' || e.state === 'PUBLISHED' || e.state === 'AUTOMATED_SENDING' || e.publishDate);
  console.log(`Sent/published candidates: ${candidates.length}`);

  const targets = STATS_LIMIT > 0 ? candidates.slice(0, STATS_LIMIT) : candidates;
  if (STATS_LIMIT > 0) console.log(`Capped to ${targets.length} by HUBSPOT_STATS_LIMIT`);

  console.log('\n[2/4] Probing statistics endpoint...');
  const portalAggregate = await probeTimestampFormat(STATS_START, endISO);
  const pc = portalAggregate?.aggregate?.counters || {};
  console.log(`  Portal-wide check: ${(pc.delivered ?? 0).toLocaleString()} delivered, ${(pc.open ?? 0).toLocaleString()} opens`);

  console.log(`\n[3/4] Fetching per-email statistics for ${targets.length} emails...`);
  const results = [];
  let noStats = 0;

  for (const [i, email] of targets.entries()) {
    const aggregate = await fetchEmailStats(email.id, STATS_START, endISO);
    if (aggregate?.counters && (aggregate.counters.delivered > 0 || aggregate.counters.sent > 0)) {
      results.push(buildEmailResult(email, aggregate));
    } else {
      noStats++;
    }
    await sleep(REQUEST_DELAY_MS);
    const n = i + 1;
    if (n % 100 === 0 || n === targets.length) {
      console.log(`  ${n}/${targets.length} · kept ${results.length} · skipped ${noStats}`);
    }
  }

  if (!results.length) {
    throw new Error('Statistics endpoint responded but returned no delivered volume for any email. Widen HUBSPOT_STATS_START or confirm this portal has sent marketing emails.');
  }

  results.sort((a, b) => new Date(b.sendDate) - new Date(a.sendDate));

  console.log('\n[4/4] Writing output...');
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
  console.error('Token setup: the HUBSPOT_TOKEN secret must be a HubSpot Private App access token with the "content" scope.');
  console.error('HubSpot scopes: https://developers.hubspot.com/scopes');
  process.exitCode = 1;
});
