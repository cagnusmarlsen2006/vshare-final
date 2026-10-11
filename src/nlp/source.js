'use strict';

/**
 * Source credibility from the URL alone. The URL is NEVER fetched (no SSRF,
 * works offline); only its structure and domain are analysed:
 *   - trusted domains given by the uploader
 *   - built-in lists of reputable outlets / known unreliable or satire sites
 *   - institutional TLDs (.gov, .edu, .int, .gov.in, .ac.in, .nic.in)
 *   - look-alike domains (typosquatting, brand + extra words, ".com.co" tricks)
 *   - IP-address hosts, suspicious TLDs, plain http
 */

const REPUTABLE = [
  'reuters.com', 'apnews.com', 'bbc.com', 'bbc.co.uk', 'npr.org', 'pbs.org', 'nytimes.com', 'washingtonpost.com',
  'wsj.com', 'theguardian.com', 'economist.com', 'bloomberg.com', 'ft.com', 'aljazeera.com', 'cnn.com', 'cbsnews.com',
  'nbcnews.com', 'abcnews.go.com', 'usatoday.com', 'latimes.com', 'theatlantic.com', 'time.com', 'forbes.com',
  'thehindu.com', 'indianexpress.com', 'hindustantimes.com', 'ndtv.com', 'livemint.com', 'timesofindia.indiatimes.com',
  'thewire.in', 'scroll.in', 'deccanherald.com', 'business-standard.com', 'pib.gov.in',
  'nature.com', 'science.org', 'sciencedirect.com', 'thelancet.com', 'nejm.org', 'bmj.com', 'who.int', 'un.org',
  'cdc.gov', 'nih.gov', 'nasa.gov', 'isro.gov.in', 'factcheck.org', 'snopes.com', 'politifact.com', 'altnews.in',
  'boomlive.in', 'fullfact.org', 'wikipedia.org',
];
const UNRELIABLE = [
  'infowars.com', 'naturalnews.com', 'beforeitsnews.com', 'worldnewsdailyreport.com', 'yournewswire.com',
  'newspunch.com', 'abcnews.com.co', 'nationalreport.net', 'empirenews.net', 'realnewsrightnow.com', 'dcgazette.com',
  'prntly.com', 'zerohedge.com', 'thegatewaypundit.com', 'collective-evolution.com', 'worldtruth.tv', 'neonnettle.com',
  'postcard.news', 'newsexaminer.net',
];
const SATIRE = ['theonion.com', 'babylonbee.com', 'clickhole.com', 'thebeaverton.com', 'fauxy.com', 'thefauxy.com'];
const INSTITUTIONAL = /\.(gov|edu|mil|int)$|\.(gov|ac|edu|nic|res)\.[a-z]{2}$/;
const SUSPICIOUS_TLD = /\.(xyz|top|click|buzz|loan|win|bid|rest|icu|cfd|sbs|monster|cyou|gq|ml|tk|cf|ga)$/;
const TWO_LEVEL = /\.(co|com|org|net|gov|ac|edu|nic|res)\.[a-z]{2}$/;

/** Registrable domain, e.g. "news.bbc.co.uk" -> "bbc.co.uk". */
function registrable(host) {
  const parts = host.split('.');
  return parts.slice(TWO_LEVEL.test(host) ? -3 : -2).join('.');
}

const matches = (host, domain) => host === domain || host.endsWith(`.${domain}`);

function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

/** "bbc-news.co" or "reuterss.com" pretending to be a reputable outlet. */
function lookAlike(host) {
  const brand = (d) => d.split('.')[0];
  const label = registrable(host).split('.')[0];
  for (const d of REPUTABLE) {
    const b = brand(d);
    if (b.length < 3 || matches(host, d)) continue;
    if (label === b && registrable(host) !== registrable(d)) return d; // same brand, wrong TLD (abcnews.com.co)
    if (label !== b && label.split('-').includes(b)) return d; // "bbc-news", "cnn-breaking-news"
    if (b.length >= 4 && label !== b && label.includes(b)) return d; // brand + extra words
    if (b.length >= 5 && levenshtein(label, b) === 1) return d; // one typo away
  }
  return null;
}

/** Parse the uploader's comma/space separated trusted-domain list. */
function parseTrustedDomains(input) {
  return String(input || '')
    .toLowerCase()
    .split(/[\s,;]+/)
    .map((d) => d.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').trim())
    .filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))
    .slice(0, 50);
}

/**
 * @returns {{ provided:boolean, url?:string, domain?:string, category:string, score:number|null, reasons:string[] }}
 */
function assessSource(sourceUrl, trustedDomains = []) {
  const raw = String(sourceUrl || '').trim();
  if (!raw) return { provided: false, category: 'none', score: null, reasons: ['No source URL was given.'] };
  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { provided: true, category: 'invalid', score: 0.2, reasons: ['The source URL is not a valid web address.'] };
  }
  if (!/^https?:$/.test(url.protocol)) {
    return { provided: true, category: 'invalid', score: 0.2, reasons: ['Only http(s) source URLs are accepted.'] };
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const reasons = [];
  let category = 'unknown';
  let score = 0.5;

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
    category = 'suspicious';
    score = 0.2;
    reasons.push('The source is a raw IP address, not a named publisher.');
  } else if (trustedDomains.some((d) => matches(host, d))) {
    category = 'trusted-by-you';
    score = 0.95;
    reasons.push(`${host} is in your trusted domains.`);
  } else if (SATIRE.some((d) => matches(host, d))) {
    category = 'satire';
    score = 0.1;
    reasons.push(`${host} is a known satire site: its stories are intentionally fictional.`);
  } else if (UNRELIABLE.some((d) => matches(host, d))) {
    category = 'unreliable';
    score = 0.05;
    reasons.push(`${host} is on the list of known unreliable / fake-news sites.`);
  } else if (REPUTABLE.some((d) => matches(host, d))) {
    category = 'reputable';
    score = 0.9;
    reasons.push(`${host} is an established news, science or fact-checking publisher.`);
  } else if (INSTITUTIONAL.test(host)) {
    category = 'institutional';
    score = 0.85;
    reasons.push(`${host} is a government, academic or intergovernmental domain.`);
  } else {
    const twin = lookAlike(host);
    if (twin) {
      category = 'suspicious';
      score = 0.1;
      reasons.push(`${host} imitates ${twin} (look-alike domain).`);
    } else if (SUSPICIOUS_TLD.test(host)) {
      category = 'suspicious';
      score = 0.25;
      reasons.push(`${host} uses a top-level domain that is common for throwaway sites.`);
    } else {
      reasons.push(`${host} is not on any list; its reputation is unknown.`);
    }
  }
  if (url.protocol === 'http:' && score > 0.3) {
    score -= 0.05;
    reasons.push('The link uses plain http (no TLS).');
  }
  return { provided: true, url: url.toString(), domain: host, category, score: Math.round(score * 100) / 100, reasons };
}

module.exports = { assessSource, parseTrustedDomains, registrable, lookAlike, REPUTABLE, UNRELIABLE, SATIRE };
