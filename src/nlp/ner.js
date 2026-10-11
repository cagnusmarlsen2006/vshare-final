'use strict';

/**
 * Named-entity recognition.
 *   - PERSON / PLACE / ORGANIZATION: the "compromise" NLP library (rule-based
 *     part-of-speech tagging + lexicon, fully offline)
 *   - DATE / MONEY / PERCENT / EMAIL / URL: regular-expression extractors
 * Returns de-duplicated entities with mention counts, most frequent first.
 */
const nlp = require('compromise');
const { normalize } = require('./text');

const MAX_CHARS = 50000; // keep NER fast (it runs synchronously) on long documents

const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const DAYS = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday';
const REGEX = {
  DATE: new RegExp(
    `\\b(?:(?:${MONTHS})\\.? \\d{1,2}(?:st|nd|rd|th)?(?:,? \\d{4})?|\\d{1,2}(?:st|nd|rd|th)? (?:${MONTHS})\\.?(?:,? \\d{4})?|`
    + `\\d{4}-\\d{2}-\\d{2}|\\d{1,2}/\\d{1,2}/\\d{2,4}|(?:${DAYS})|(?:in|since|by|during) (?:19|20)\\d{2})\\b`, 'gi',
  ),
  MONEY: /(?:[$€£₹]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:million|billion|trillion|crore|lakh|k|m|bn))?|\b\d[\d,]*(?:\.\d+)?\s?(?:million|billion|trillion)?\s?(?:dollars|usd|euros|rupees|inr|pounds)\b)/gi,
  PERCENT: /\b\d+(?:\.\d+)?\s?(?:%|percent\b|per cent\b)/gi,
  EMAIL: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  URL: /\bhttps?:\/\/[^\s<>"')]+/gi,
};

// Gazetteer of news organisations / agencies the lexicon often misses.
const ORG_GAZETTEER = /\b(?:Reuters|Associated Press|AP|AFP|BBC|CNN|NPR|PTI|ANI|Al Jazeera|Bloomberg|The Hindu|Times of India|New York Times|Washington Post|Wall Street Journal|Guardian|Fox News|NDTV|WHO|UNICEF|UNESCO|NASA|ISRO|FBI|CIA|EU|UN|IMF|World Bank|Supreme Court|Parliament|Congress|Senate)\b/g;
// Honorific / title followed by capitalised name tokens -> PERSON.
const TITLED_PERSON = /\b(?:President|Prime Minister|Chief Minister|Minister|Senator|Governor|Judge|Justice|CEO|Dr|Mr|Mrs|Ms|Prof|Professor|Sir)\.? ((?:[A-Z][a-z]+(?:-[A-Z][a-z]+)? ?){1,3})/g;

/** Count mentions found by ONE extractor. */
function tally(list, type) {
  const out = new Map();
  for (const raw of list) {
    const text = String(raw).replace(/[\s,.;:'"!?()-]+$/g, '').replace(/^[\s,.;:'"(]+/, '')
      .replace(/^(?:Dr|Mr|Mrs|Ms|Prof)\.?\s+/, '') // "Dr. X" and "X" are the same entity
      .replace(/^the\s+/i, '') // "the WHO" and "WHO" too
      .trim();
    if (text.length < 2 || text.length > 80) continue;
    const key = `${type}|${text.toLowerCase()}`;
    const e = out.get(key);
    if (e) e.count += 1;
    else out.set(key, { type, text, count: 1 });
  }
  return out;
}

/** Merge extractor results; when two extractors find the same entity, keep the higher count. */
function merge(into, part) {
  for (const [key, e] of part) {
    const cur = into.get(key);
    if (!cur) into.set(key, e);
    else cur.count = Math.max(cur.count, e.count);
  }
}

/**
 * @param {string} text
 * @returns {{ entities: Array<{type:string,text:string,count:number}>, counts: Record<string, number> }}
 */
function extractEntities(text) {
  const t = normalize(text).slice(0, MAX_CHARS);
  const found = new Map();
  if (t) {
    const doc = nlp(t);
    merge(found, tally(doc.people().out('array'), 'PERSON'));
    merge(found, tally(doc.places().out('array'), 'PLACE'));
    merge(found, tally(doc.organizations().out('array'), 'ORGANIZATION'));
    merge(found, tally([...t.matchAll(TITLED_PERSON)].map((m) => m[1]), 'PERSON'));
    merge(found, tally(t.match(ORG_GAZETTEER) || [], 'ORGANIZATION'));
    for (const [type, re] of Object.entries(REGEX)) merge(found, tally(t.match(re) || [], type));
  }
  const entities = [...found.values()].sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
  const counts = {};
  for (const e of entities) counts[e.type] = (counts[e.type] || 0) + e.count;
  return { entities, counts };
}

module.exports = { extractEntities };
