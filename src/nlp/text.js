'use strict';

/**
 * Text-mining primitives (no dependencies):
 *   normalisation, sentence splitting, tokenisation, stop-word removal,
 *   Porter stemming, n-grams, term frequencies, readability and style signals.
 */

const STOPWORDS = new Set(`a about above after again against all am an and any are aren't as at be because been
before being below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down
during each few for from further had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers
herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself let's me more most
mustn't my myself no nor not of off on once only or other ought our ours ourselves out over own same shan't she
she'd she'll she's should shouldn't so some such than that that's the their theirs them themselves then there
there's these they they'd they'll they're they've this those through to too under until up very was wasn't we we'd
we'll we're we've were weren't what what's when when's where where's which while who who's whom why why's with
won't would wouldn't you you'd you'll you're you've your yours yourself yourselves also just will said says say one
two would could us mr mrs ms new like get got even many much may might must shall s t don`.split(/\s+/));

/** Unicode-normalise, unify quotes/dashes, collapse whitespace. */
function normalize(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[–—−]/g, '-')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Abbreviations whose period does not end a sentence ("Dr. Kluge", "U.S. officials").
const ABBREV = /\b(Dr|Mr|Mrs|Ms|Prof|Sr|Jr|St|Gen|Gov|Sen|Rep|Lt|Col|Capt|Inc|Ltd|Co|Corp|vs|etc|No|Fig|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|U\.S|U\.K|e\.g|i\.e)\./g;

function sentences(text) {
  return normalize(text)
    .replace(ABBREV, '$1\u2024') // protect: one-dot leader looks like "." but is not split on
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])|\n+/)
    .map((s) => s.replace(/\u2024/g, '.').trim())
    .filter((s) => s.length > 1);
}

/** Lower-case word tokens (letters, digits, inner apostrophes). */
function tokenize(text) {
  return normalize(text).toLowerCase().match(/[a-z0-9]+(?:'[a-z]+)?/g) || [];
}

/* ------------------------------------------------------------------ */
/* Porter stemmer (M. F. Porter, 1980)                                 */
/* ------------------------------------------------------------------ */
const step2list = {
  ational: 'ate', tional: 'tion', enci: 'ence', anci: 'ance', izer: 'ize', bli: 'ble', alli: 'al',
  entli: 'ent', eli: 'e', ousli: 'ous', ization: 'ize', ation: 'ate', ator: 'ate', alism: 'al',
  iveness: 'ive', fulness: 'ful', ousness: 'ous', aliti: 'al', iviti: 'ive', biliti: 'ble', logi: 'log',
};
const step3list = { icate: 'ic', ative: '', alize: 'al', iciti: 'ic', ical: 'ic', ful: '', ness: '' };
const c = '[^aeiou]';
const v = '[aeiouy]';
const C = `${c}[^aeiouy]*`;
const V = `${v}[aeiou]*`;
const mgr0 = new RegExp(`^(${C})?${V}${C}`);
const meq1 = new RegExp(`^(${C})?${V}${C}(${V})?$`);
const mgr1 = new RegExp(`^(${C})?${V}${C}${V}${C}`);
const sV = new RegExp(`^(${C})?${v}`);

function stem(word) {
  let w = word;
  if (w.length < 3) return w;
  let re;
  let re2;
  let re3;
  let re4;
  const firstch = w[0];
  if (firstch === 'y') w = firstch.toUpperCase() + w.slice(1);

  // Step 1a
  re = /^(.+?)(ss|i)es$/;
  re2 = /^(.+?)([^s])s$/;
  if (re.test(w)) w = w.replace(re, '$1$2');
  else if (re2.test(w)) w = w.replace(re2, '$1$2');

  // Step 1b
  re = /^(.+?)eed$/;
  re2 = /^(.+?)(ed|ing)$/;
  if (re.test(w)) {
    const fp = re.exec(w);
    if (mgr0.test(fp[1])) w = w.replace(/.$/, '');
  } else if (re2.test(w)) {
    const fp = re2.exec(w);
    const s = fp[1];
    if (sV.test(s)) {
      w = s;
      re2 = /(at|bl|iz)$/;
      re3 = /([^aeiouylsz])\1$/;
      re4 = new RegExp(`^${C}${v}[^aeiouwxy]$`);
      if (re2.test(w)) w += 'e';
      else if (re3.test(w)) w = w.replace(/.$/, '');
      else if (re4.test(w)) w += 'e';
    }
  }

  // Step 1c
  re = /^(.+?)y$/;
  if (re.test(w)) {
    const fp = re.exec(w);
    if (sV.test(fp[1])) w = `${fp[1]}i`;
  }

  // Step 2
  re = /^(.+?)(ational|tional|enci|anci|izer|bli|alli|entli|eli|ousli|ization|ation|ator|alism|iveness|fulness|ousness|aliti|iviti|biliti|logi)$/;
  if (re.test(w)) {
    const fp = re.exec(w);
    if (mgr0.test(fp[1])) w = fp[1] + step2list[fp[2]];
  }

  // Step 3
  re = /^(.+?)(icate|ative|alize|iciti|ical|ful|ness)$/;
  if (re.test(w)) {
    const fp = re.exec(w);
    if (mgr0.test(fp[1])) w = fp[1] + step3list[fp[2]];
  }

  // Step 4
  re = /^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/;
  re2 = /^(.+?)(s|t)(ion)$/;
  if (re.test(w)) {
    const fp = re.exec(w);
    if (mgr1.test(fp[1])) w = fp[1];
  } else if (re2.test(w)) {
    const fp = re2.exec(w);
    const s = fp[1] + fp[2];
    if (mgr1.test(s)) w = s;
  }

  // Step 5
  re = /^(.+?)e$/;
  if (re.test(w)) {
    const fp = re.exec(w);
    const s = fp[1];
    re3 = new RegExp(`^${C}${v}[^aeiouwxy]$`);
    if (mgr1.test(s) || (meq1.test(s) && !re3.test(s))) w = s;
  }
  if (/ll$/.test(w) && mgr1.test(w)) w = w.replace(/.$/, '');

  if (firstch === 'y') w = firstch.toLowerCase() + w.slice(1);
  return w;
}

/** Tokens -> stop words removed -> stemmed. Digits-only tokens are dropped. */
function terms(text) {
  return tokenize(text)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t) && !/^\d+$/.test(t))
    .map((t) => stem(t.replace(/'.*$/, '')));
}

/** Unigrams + bigrams (bigrams joined with "_"). */
/** Map each stem to the surface word it most often came from ("measl" -> "measles"). */
function surfaceForms(text) {
  const counts = new Map();
  for (const t of tokenize(text)) {
    if (t.length < 2 || STOPWORDS.has(t) || /^\d+$/.test(t)) continue;
    const word = t.replace(/'.*$/, '');
    const st = stem(word);
    if (!counts.has(st)) counts.set(st, new Map());
    const m = counts.get(st);
    m.set(word, (m.get(word) || 0) + 1);
  }
  const out = new Map();
  for (const [st, m] of counts) out.set(st, [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0][0]);
  return out;
}

/** Human-readable form of a feature ("public_health" stems -> "public health"). */
function readable(feature, forms) {
  return feature.split('_').map((st) => forms.get(st) || st).join(' ');
}

function ngrams(tokens, n = 2) {
  const out = tokens.slice();
  for (let k = 2; k <= n; k++) {
    for (let i = 0; i + k <= tokens.length; i++) out.push(tokens.slice(i, i + k).join('_'));
  }
  return out;
}

function termFrequencies(list) {
  const tf = new Map();
  for (const t of list) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

function countSyllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '').match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

/** Flesch reading ease (higher = easier). */
function readability(text) {
  const sents = sentences(text);
  const words = tokenize(text).filter((t) => /[a-z]/.test(t));
  if (!sents.length || !words.length) return null;
  const syll = words.reduce((n, w) => n + countSyllables(w), 0);
  const score = 206.835 - 1.015 * (words.length / sents.length) - 84.6 * (syll / words.length);
  return Math.round(Math.max(-50, Math.min(120, score)) * 10) / 10;
}

// Sensational / clickbait vocabulary (common in low-credibility writing).
const SENSATIONAL = [
  'shocking', 'shock', 'unbelievable', 'you won\'t believe', 'miracle', 'secret', 'exposed', 'breaking',
  'bombshell', 'outrage', 'destroyed', 'slams', 'hoax', 'cover-up', 'coverup', 'conspiracy', 'they don\'t want you',
  'mainstream media', 'wake up', 'share before', 'banned', 'censored', 'deep state', 'globalist', 'crisis actor',
  'big pharma', '100% proof', 'proof', 'insane', 'jaw-dropping', 'must see', 'viral', 'urgent', 'leaked',
];
const HEDGES = ['according to', 'reported', 'said', 'study', 'researchers', 'data', 'percent', 'survey',
  'spokesperson', 'statement', 'official', 'published', 'analysis', 'evidence', 'source'];

/** Stylometric signals used as interpretable credibility features. */
function styleSignals(text) {
  const raw = normalize(text);
  const lower = raw.toLowerCase();
  const words = raw.match(/[A-Za-z][A-Za-z']*/g) || [];
  const sents = sentences(raw);
  const capsWords = words.filter((w) => w.length > 2 && w === w.toUpperCase()).length;
  const count = (list) => list.reduce((n, p) => n + (lower.split(p).length - 1), 0);
  const per100 = (n) => (words.length ? Math.round((n / words.length) * 1000) / 10 : 0);
  return {
    words: words.length,
    sentences: sents.length,
    avgSentenceLength: sents.length ? Math.round((words.length / sents.length) * 10) / 10 : 0,
    exclamations: (raw.match(/!/g) || []).length,
    questionMarks: (raw.match(/\?/g) || []).length,
    capsWordRatio: words.length ? Math.round((capsWords / words.length) * 1000) / 1000 : 0,
    sensationalTerms: count(SENSATIONAL),
    sensationalPer100Words: per100(count(SENSATIONAL)),
    attributionTerms: count(HEDGES),
    attributionPer100Words: per100(count(HEDGES)),
    quotes: (raw.match(/"[^"]{8,}"/g) || []).length,
    readability: readability(raw),
  };
}

module.exports = {
  STOPWORDS, normalize, sentences, tokenize, stem, terms, ngrams, surfaceForms, readable, termFrequencies, readability, styleSignals,
};
