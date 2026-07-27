/**
 * fetch-hs-stats.js
 *
 * Fetches HubSpot Marketing Email statistics and writes email_stats.json.
 *
 * Required credential:
 *   HUBSPOT_TOKEN, HUBSPOT_ACCESS_TOKEN, HUBSPOT_SERVICE_KEY, or HUBSPOT_API_KEY
 *
 * Important:
 *   The value must be a HubSpot private app access token or service key that can
 *   be sent as "Authorization: Bearer <token>". Legacy hapikey/API-key auth is
 *   not supported by this script.
 *
 * Required HubSpot scope for the Marketing Emails v3 API: content.
 * See docs/refresh-hubspot-token.md in this repository for step-by-step token
 * and secret rotation instructions.
 */

'use strict';

const fs = require('fs');

const BASE = 'https://api.hubapi.com';
const OUTPUT_FILE = process.env.OUTPUT_FILE || 'email_stats.json';
const MAX_PAGES = Number(process.env.HUBSPOT_MAX_PAGES || 30);
const PAGE_LIMIT = Number(process.env.HUBSPOT_PAGE_LIMIT || 100);
const REQUEST_DELAY_MS = Number(process.env.HUBSPOT_REQUEST_DELAY_MS || 110);

const BRAND_RULES = [
  { pattern: /^(USPC|PC2|USPC2)/i, brand: 'USPC', label: 'Psych Congress' },
  { pattern: /^(Elevate)/i, brand: 'ELEVATE', label: 'Elevate' },
  { pattern: /^(NPI|NPI2|NP Institute)/i, brand: 'NPI', label: 'NP Institute' },
  { pattern: /^(PAI|PAI2|PA Institute)/i, brand: 'PAI', label: 'PA Institute' },
  { pattern: /^(PCR|PCR2)/i, brand: 'PCR', label: 'PC Regionals' },
  { pattern: /^(PCCP)/i, brand: 'PCCP', label: 'Clinical Pearls' },
];

function detectBrand(name = '') {
  for (const rule of BRAND_RULES) {
    if (rule.pattern.test(name.trim())) return { brand: rule.brand, label: rule.label };
  }
  return { brand: 'OTHER', label: 'Other' };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getToken() {
  const candidates = [
    'HUBSPOT_TOKEN',
    'HUBSPOT_ACCESS_TOKEN',
    'HUBSPOT_SERVICE_KEY',
    'HUBSPOT_API_KEY',
  ];

  for (const name of candidates) {
    const value = (process.env[name] || '').trim();
    if (value) return { name, value };
  }

  throw new Error(
    'No HubSpot credential found. Set HUBSPOT_TOKEN to a private app access token or service key.'
  );
}

let credential;

function scrubCredential(message = '') {
  if (!credential?.value) return message;
  return message.split(credential.value).join('[redacted]');
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return { rawBody: text };
  }
}

function getErrorMessage(status, body, url) {
  const hubSpotMessage = body?.message || body?.rawBody || '';
  const category = body?.category || '';
  const context = body?.context ? ` Context: ${JSON.stringify(body.context)}` : '';
  const baseMessage = `HubSpot request failed (${status}) for ${url}. ${hubSpotMessage}${context}`;

  if (status === 401) {
    return [
      baseMessage,
      'Authentication failed. This script needs a private app access token or service key used as a Bearer token.',
      'If you pasted a legacy HubSpot API key/hapikey, create a private app token or service key instead.',
    ].join(' ');
  }

  if (status === 403 || category === 'MISSING_SCOPES') {
    return [
      baseMessage,
      'Authorization failed. Confirm the credential has the content scope and that your HubSpot account has access to Marketing Emails API data.',
      'See docs/refresh-hubspot-token.md in this repository for instructions to create or rotate a private app token and update the HUBSPOT_TOKEN secret.',
      'HubSpot scopes docs: https://developers.hubspot.com/scopes',
    ].join(' ');
  }

  return baseMessage;
}

async function hubspotGet(path, params = {}, options = {}) {
  const url = new URL(`${BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  let attempt = 0;
  while (true) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${credential.value}`,
        Accept: 'application/json',
      },
    });
    const body = await readJson(response);

    if (response.ok) return body;

    if (response.status === 404 && options.allowNotFound) return null;

    if (response.status === 429 && attempt < 4) {
      const retryAfterSeconds = Number(response.headers.get('retry-after') || 1);
      const retryDelayMs = Math.max(1000, retryAfterSeconds * 1000);
      console.warn(`  WARN: rate limited. Waiting ${retryDelayMs} ms before retrying...`);
      await sleep(retryDelayMs);
      attempt++;
      continue;
    }

    throw new Error(scrubCredential(getErrorMessage(response.status, body, url.pathname)));
  }
}

async function fetchAllEmails() {
  const all = [];
  let after;
  let page = 0;

  do {
    const params = { limit: PAGE_LIMIT };
    if (after) params.after = after;

    const data = await hubspotGet('/marketing/v3/emails', params);
    const results = data?.results || [];
    all.push(...results);
    after = data?.paging?.next?.after;
    page++;

    console.log(`  Page ${page}: fetched ${results.length} emails (total: ${all.length})`);
  } while (after && page < MAX_PAGES);

  if (after) {
    console.warn(`  WARN: stopped after HUBSPOT_MAX_PAGES=${MAX_PAGES}. Increase it to fetch more.`);
  }

  return all;
}

async function fetchEmailDetail(emailId) {
  return hubspotGet(`/marketing/v3/emails/${encodeURIComponent(emailId)}`, {}, { allowNotFound: true });
}

function getStatsContainer(emailOrDetail) {
  if (!emailOrDetail) return null;
  if (emailOrDetail.stats) return emailOrDetail.stats;
  if (emailOrDetail.counters || emailOrDetail.ratios) return emailOrDetail;
  return null;
}

function firstValue(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '') || '';
}

function isSentEmail(email) {
  const stats = getStatsContainer(email);
  const counters = stats?.counters || {};
  return email.state === 'SENT' || counters.processed > 0 || counters.sent > 0;
}

function percent(value) {
  return value ? +(Number(value) * 100).toFixed(2) : 0;
}

function buildEmailResult(email, stats) {
  const counters = stats?.counters || {};
  const ratios = stats?.ratios || {};
  const { brand, label } = detectBrand(email.name);

  return {
    id: email.id,
    name: email.name || '',
    subject: email.subject || '',
    sendDate: firstValue(email.sendDate, email.publishDate, email.publishedAt, email.updatedAt, email.createdAt),
    fromName: email.fromName || '',
    fromEmail: email.fromEmail || '',
    campaignName: email.campaignName || '',
    brand,
    brandLabel: label,
    state: email.state || '',
    delivered: counters.delivered ?? 0,
    sent: counters.sent ?? counters.processed ?? 0,
    opens: counters.open ?? counters.opens ?? 0,
    clicks: counters.click ?? counters.clicks ?? 0,
    hardBounces: counters.hardBounced ?? counters.hardBounces ?? 0,
    softBounces: counters.softBounced ?? counters.softBounces ?? 0,
    unsubscribes: counters.unsubscribed ?? counters.unsubscribes ?? 0,
    spamReports: counters.spamreport ?? counters.spamReports ?? 0,
    openRate: percent(ratios.openRate),
    clickRate: percent(ratios.clickRate),
    ctor: percent(ratios.clickThroughRate),
    bounceRate: percent(ratios.bounceRate),
    unsubRate: percent(ratios.unsubscribedRate),
    spamRate: percent(ratios.spamreportRate),
  };
}

function average(values) {
  return values.length ? +(values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2) : 0;
}

function buildBrandStats(results) {
  const brandSummary = {};

  for (const email of results) {
    if (!brandSummary[email.brand]) {
      brandSummary[email.brand] = {
        brand: email.brand,
        label: email.brandLabel,
        totalSent: 0,
        totalDelivered: 0,
        openRates: [],
        clickRates: [],
        sent2026: 0,
        delivered2026: 0,
        openRates2026: [],
        clickRates2026: [],
      };
    }

    const brand = brandSummary[email.brand];
    brand.totalSent++;
    brand.totalDelivered += email.delivered;

    if (email.delivered > 0) {
      brand.openRates.push(email.openRate);
      brand.clickRates.push(email.clickRate);
    }

    if (String(email.sendDate).startsWith('2026')) {
      brand.sent2026++;
      brand.delivered2026 += email.delivered;

      if (email.delivered > 0) {
        brand.openRates2026.push(email.openRate);
        brand.clickRates2026.push(email.clickRate);
      }
    }
  }

  return Object.values(brandSummary).map(brand => ({
    brand: brand.brand,
    label: brand.label,
    totalSent: brand.totalSent,
    totalDelivered: brand.totalDelivered,
    avgOpenRate: average(brand.openRates),
    avgClickRate: average(brand.clickRates),
    sent2026: brand.sent2026,
    delivered2026: brand.delivered2026,
    avgOpenRate2026: average(brand.openRates2026),
    avgClickRate2026: average(brand.clickRates2026),
  }));
}

async function main() {
  credential = getToken();

  console.log('=== HubSpot Email Stats Refresh ===');
  console.log(`Started: ${new Date().toISOString()}`);
  console.log(`Credential source: ${credential.name}`);

  if (credential.name === 'HUBSPOT_API_KEY') {
    console.warn('WARN: HUBSPOT_API_KEY is accepted as an env var name, but the value still must be a Bearer-token credential, not a legacy hapikey.');
  }

  console.log('\n[1/3] Fetching email list...');
  const allEmails = await fetchAllEmails();
  console.log(`Total emails: ${allEmails.length}`);

  const sent = allEmails.filter(isSentEmail);
  console.log(`Sent emails: ${sent.length}`);

  console.log('\n[2/3] Normalizing email statistics...');
  const results = [];

  for (const [index, email] of sent.entries()) {
    let stats = getStatsContainer(email);
    let detail = null;

    if (!stats) {
      detail = await fetchEmailDetail(email.id);
      stats = getStatsContainer(detail);
      await sleep(REQUEST_DELAY_MS);
    }

    if (stats) {
      results.push(buildEmailResult({ ...email, ...detail }, stats));
    } else {
      console.warn(`  WARN: ${email.id}: no stats object returned`);
    }

    const processed = index + 1;
    if (processed % 50 === 0) console.log(`  Progress: ${processed}/${sent.length}...`);
  }

  results.sort((a, b) => new Date(b.sendDate) - new Date(a.sendDate));

  console.log('\n[3/3] Writing email_stats.json...');
  const brandStats = buildBrandStats(results);
  const output = {
    generatedAt: new Date().toISOString(),
    generatedBy: 'fetch-hs-stats',
    totalEmails: results.length,
    brandStats,
    emails: results,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');
  console.log(`Done. Wrote ${results.length} emails to ${OUTPUT_FILE}`);
  console.log(`Brands: ${brandStats.map(brand => `${brand.brand}(${brand.totalSent})`).join(', ')}`);
  console.log(`Finished: ${new Date().toISOString()}`);
}

main().catch(error => {
  console.error('\nFatal error:', scrubCredential(error.message));
  console.error('If this is a 403/MISSING_SCOPES error, ensure the HUBSPOT_TOKEN secret belongs to a HubSpot Private App with the required scopes (Marketing Emails / content).');
  console.error('See docs/refresh-hubspot-token.md in this repository for step-by-step instructions and the HubSpot scopes docs: https://developers.hubspot.com/scopes');
  process.exitCode = 1;
});
