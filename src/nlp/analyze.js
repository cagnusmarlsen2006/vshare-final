'use strict';

/**
 * Credibility analysis pipeline for the "Fake-News-Proof" sharing system.
 *
 *   text ─┬─ ML classifier (TF-IDF + logistic regression)  -> P(fake)
 *         ├─ style signals (sensational words, caps, "!", attribution, readability)
 *         ├─ named entities (people / organisations / places / dates / numbers)
 *         ├─ keywords (TF-IDF) + extractive summary
 *   URL  ─┴─ source credibility (lists, institutional TLDs, look-alikes, trusted list)
 *
 * The three scores are fused with fixed, documented weights into a credibility
 * score (0-100) and a verdict. Every component explains itself in `reasons`.
 */
const path = require('path');
const fs = require('fs');
const { loadModel } = require('./classifier');
const { sentences, styleSignals, terms, termFrequencies, surfaceForms, readable } = require('./text');
const { extractEntities } = require('./ner');
const { assessSource } = require('./source');

const MODEL_FILE = path.join(__dirname, 'fake-news-model.json');
const MIN_WORDS = 40; // below this the text model is not meaningful

const THRESHOLDS = { credible: 65, uncertain: 45 }; // percent
// Weights for "no source" were chosen on the held-out test set
// (npm run eval:fusion; results in docs/ml-fusion-eval.txt).
const WEIGHTS = {
  withSource: { ml: 0.5, style: 0.15, source: 0.35 },
  noSource: { ml: 0.8, style: 0.2, source: 0 },
};
const GOOD_SOURCES = ['trusted-by-you', 'reputable', 'institutional'];

let model = null;
function getModel() {
  if (!model) model = loadModel(JSON.parse(fs.readFileSync(MODEL_FILE, 'utf8')));
  return model;
}

/** Interpretable 0..1 credibility from writing style. */
function styleScore(sig, entityCounts) {
  let s = 0.7;
  const reasons = [];
  if (sig.sensationalPer100Words > 1) {
    s -= Math.min(0.35, sig.sensationalPer100Words * 0.05);
    reasons.push(`Sensational / clickbait wording (${sig.sensationalTerms} terms).`);
  }
  const exclPerSentence = sig.sentences ? sig.exclamations / sig.sentences : 0;
  if (exclPerSentence > 0.2) {
    s -= Math.min(0.2, exclPerSentence * 0.2);
    reasons.push(`Many exclamation marks (${sig.exclamations}).`);
  }
  if (sig.capsWordRatio > 0.08) {
    s -= Math.min(0.2, sig.capsWordRatio);
    reasons.push(`Lots of ALL-CAPS words (${Math.round(sig.capsWordRatio * 100)}%).`);
  }
  if (sig.attributionPer100Words >= 0.5) {
    s += Math.min(0.2, sig.attributionPer100Words * 0.05);
    reasons.push('Attributes claims to sources ("according to", "said", "study").');
  } else if (sig.words > 150) {
    s -= 0.1;
    reasons.push('Long text with almost no attribution to sources.');
  }
  if (sig.quotes > 0) {
    s += Math.min(0.08, sig.quotes * 0.02);
    reasons.push(`Contains direct quotations (${sig.quotes}).`);
  }
  const named = (entityCounts.PERSON || 0) + (entityCounts.ORGANIZATION || 0);
  if (sig.words && named / sig.words > 0.01) {
    s += 0.05;
    reasons.push(`Names specific people and organisations (${named} mentions).`);
  }
  return { score: Math.max(0, Math.min(1, s)), reasons };
}

/** Top keywords by TF-IDF using the model's IDF table; plus a 2-sentence extractive summary. */
function keywordsAndSummary(text, idfLookup) {
  const tf = termFrequencies(terms(text));
  const scored = [...tf.entries()]
    .map(([t, n]) => [t, (1 + Math.log(n)) * (idfLookup(t) || 1)])
    .sort((a, b) => b[1] - a[1]);
  const forms = surfaceForms(text);
  const keywords = scored.slice(0, 10).map(([t]) => readable(t, forms));
  const weight = new Map(scored.slice(0, 25));
  // Summary candidates: complete sentences (headlines without end punctuation are skipped).
  const sents = sentences(text).filter((s) => s.split(/\s+/).length >= 6 && s.length < 400 && /[.!?"')]$/.test(s));
  const ranked = sents
    .map((s, i) => {
      const ts = terms(s);
      const sc = ts.reduce((acc, t) => acc + (weight.get(t) || 0), 0) / Math.sqrt(ts.length || 1);
      return { s, i, sc };
    })
    .sort((a, b) => b.sc - a.sc)
    .slice(0, 2)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.s);
  return { keywords, summary: ranked };
}

/**
 * @param {{ text:string, sourceUrl?:string, trustedDomains?:string[], extraction?:object }} input
 */
function analyzeDocument({ text, sourceUrl, trustedDomains = [], extraction = {} }) {
  const m = getModel();
  const sig = styleSignals(text || '');
  const ner = extractEntities(text || '');
  const source = assessSource(sourceUrl, trustedDomains);
  const reasons = [];
  const hasText = sig.words >= MIN_WORDS;

  let ml = null;
  if (hasText) {
    const p = m.predict(text);
    const forms = surfaceForms(text);
    ml = {
      probabilityFake: Math.round(p.probabilityFake * 1000) / 1000,
      knownFeatures: p.knownFeatures,
      topTerms: p.topTerms.map((t) => ({ ...t, term: readable(t.term.replace(/ /g, '_'), forms) })),
    };
    reasons.push(`ML model: ${Math.round(p.probabilityFake * 100)}% probability that the text is fake news.`);
  } else {
    reasons.push(`Only ${sig.words} words of readable text: too little for the ML model (needs ${MIN_WORDS}).`);
  }
  const style = styleScore(sig, ner.counts);
  reasons.push(...style.reasons);
  reasons.push(...source.reasons);

  // Fuse the component scores.
  let credibility;
  if (hasText) {
    const w = source.provided ? WEIGHTS.withSource : WEIGHTS.noSource;
    credibility = w.ml * (1 - ml.probabilityFake) + w.style * style.score + w.source * (source.score ?? 0);
  } else {
    // Nothing to read: the content itself cannot be verified, and the source URL is
    // only self-reported. Never "credible"; at best "uncertain".
    credibility = Math.min(source.provided ? source.score * 0.8 : 0.3, 0.55);
    reasons.push('The content could not be checked (no readable text), so it cannot be verified.');
  }
  // Provenance rule: a reputable / trusted source plus sober writing passes, as long
  // as the model is not confident the text is fake. The model was trained on
  // political news and is weaker on other topics (e.g. health, science).
  if (hasText && GOOD_SOURCES.includes(source.category) && style.score >= 0.75 && ml.probabilityFake < 0.8) {
    if (credibility < THRESHOLDS.credible / 100) {
      credibility = THRESHOLDS.credible / 100;
      reasons.push('Provenance rule: trusted source and sober, attributed writing outweigh the topic-based ML score.');
    }
  }
  // Hard rules. The source URL is self-reported (never fetched), so it can never
  // rescue text the model is very sure is fake, and a known bad source never passes.
  if (hasText && ml.probabilityFake >= 0.9) {
    credibility = Math.min(credibility, 0.4);
  }
  if (['unreliable', 'satire', 'suspicious', 'invalid'].includes(source.category)) {
    credibility = Math.min(credibility, 0.35);
  }
  const percent = Math.round(credibility * 100);
  const verdict = percent >= THRESHOLDS.credible ? 'credible' : percent >= THRESHOLDS.uncertain ? 'uncertain' : 'likely-fake';

  const { keywords, summary } = hasText
    ? keywordsAndSummary(text, m.idf)
    : { keywords: [], summary: [] };

  return {
    verdict,
    shareable: verdict === 'credible',
    credibility: percent,
    thresholds: THRESHOLDS,
    reasons,
    components: {
      ml,
      style: { score: Math.round(style.score * 100), signals: sig },
      source,
    },
    entities: ner.entities.slice(0, 25),
    entityCounts: ner.counts,
    keywords,
    summary,
    extraction: { method: extraction.method || 'text', words: sig.words, error: extraction.error },
    model: {
      type: m.meta.type,
      trainedAt: m.meta.trainedAt,
      dataset: m.meta.metrics.dataset,
      testAccuracy: m.meta.metrics.logisticRegression.accuracy,
      note: 'Trained on 2015-2016 English political news; less reliable on other topics or languages.',
    },
  };
}

/** Top TF-IDF keywords of a text (stemmed terms), e.g. for tagging study material. */
function extractKeywords(text, n = 6) {
  return keywordsAndSummary(text, getModel().idf).keywords.slice(0, n);
}

module.exports = { analyzeDocument, extractKeywords, styleScore, THRESHOLDS, WEIGHTS, MIN_WORDS };
