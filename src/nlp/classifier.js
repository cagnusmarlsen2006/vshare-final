'use strict';

/**
 * Fake-news text classifier: TF-IDF features (stemmed unigrams + bigrams,
 * sublinear TF, L2-normalised) + logistic regression trained with SGD.
 * A multinomial Naive Bayes baseline is trained for comparison.
 *
 * Training lives here too so it can be unit-tested; the CLI wrapper is
 * scripts/train-fake-news.js. The trained model is a plain JSON file.
 */
const { terms, ngrams } = require('./text');

/* ------------------------------------------------------------------ */
/* Features                                                            */
/* ------------------------------------------------------------------ */

// Dataset artifacts that say WHEN or HOW an article was scraped, not whether it
// is true (month/day names, URL fragments, share widgets). Removing them makes
// the model generalise better to articles from other periods and sites.
const ARTIFACTS = new Set([
  'januari', 'februari', 'march', 'april', 'june', 'juli', 'august', 'septemb', 'octob', 'novemb', 'decemb',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'mondai', 'tuesdai', 'wednesdai', 'thursdai', 'fridai', 'saturdai', 'sundai',
  'http', 'https', 'www', 'com', 'org', 'html', 'php', 'share', 'articl', 'pic', 'twitter', 'via', 'subscrib', 'email',
]);

function featurize(text) {
  return ngrams(terms(text).filter((t) => !ARTIFACTS.has(t)), 2);
}

/** Sparse TF-IDF vector: Map<featureIndex, weight>, L2-normalised. */
function vectorize(tokens, index, idf) {
  const tf = new Map();
  for (const t of tokens) {
    const i = index.get(t);
    if (i !== undefined) tf.set(i, (tf.get(i) || 0) + 1);
  }
  let norm = 0;
  for (const [i, n] of tf) {
    const w = (1 + Math.log(n)) * idf[i]; // sublinear tf
    tf.set(i, w);
    norm += w * w;
  }
  norm = Math.sqrt(norm) || 1;
  for (const [i, w] of tf) tf.set(i, w / norm);
  return tf;
}

const sigmoid = (z) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

/* ------------------------------------------------------------------ */
/* Training                                                            */
/* ------------------------------------------------------------------ */

/** Deterministic PRNG (mulberry32) so training and splits are reproducible. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Stratified train/test split. Each sample: { text, label } with label 1 = FAKE, 0 = REAL. */
function stratifiedSplit(samples, testRatio, seed) {
  const rand = rng(seed);
  const train = [];
  const test = [];
  for (const label of [0, 1]) {
    const group = shuffle(samples.filter((s) => s.label === label), rand);
    const nTest = Math.round(group.length * testRatio);
    test.push(...group.slice(0, nTest));
    train.push(...group.slice(nTest));
  }
  return { train: shuffle(train, rand), test: shuffle(test, rand) };
}

/** Build the vocabulary from training documents only (no test leakage). */
function buildVocabulary(tokenLists, { minDf = 3, maxDfRatio = 0.9, maxFeatures = 30000 } = {}) {
  const df = new Map();
  for (const tokens of tokenLists) {
    for (const t of new Set(tokens)) df.set(t, (df.get(t) || 0) + 1);
  }
  const n = tokenLists.length;
  const kept = [...df.entries()]
    .filter(([, d]) => d >= minDf && d / n <= maxDfRatio)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, maxFeatures);
  const vocab = kept.map(([t]) => t);
  const idf = kept.map(([, d]) => Math.log((1 + n) / (1 + d)) + 1); // smoothed idf
  return { vocab, idf };
}

/** Logistic regression, SGD with L2 regularisation and a decaying learning rate. */
function trainLogistic(vectors, labels, dims, { epochs = 12, lr = 0.5, l2 = 1e-5, seed = 7 } = {}) {
  const w = new Float64Array(dims);
  let b = 0;
  const rand = rng(seed);
  const order = vectors.map((_, i) => i);
  let step = 0;
  for (let epoch = 0; epoch < epochs; epoch++) {
    for (const i of shuffle(order, rand)) {
      step += 1;
      const eta = lr / (1 + 0.0005 * step);
      const x = vectors[i];
      let z = b;
      for (const [j, v] of x) z += w[j] * v;
      const g = sigmoid(z) - labels[i];
      for (const [j, v] of x) w[j] -= eta * (g * v + l2 * w[j]);
      b -= eta * g;
    }
  }
  return { weights: w, bias: b };
}

/** Multinomial Naive Bayes on raw counts (Laplace smoothing). */
function trainNaiveBayes(tokenLists, labels, index, alpha = 1) {
  const dims = index.size;
  const counts = [new Float64Array(dims), new Float64Array(dims)];
  const totals = [0, 0];
  const docs = [0, 0];
  tokenLists.forEach((tokens, k) => {
    const y = labels[k];
    docs[y] += 1;
    for (const t of tokens) {
      const i = index.get(t);
      if (i !== undefined) {
        counts[y][i] += 1;
        totals[y] += 1;
      }
    }
  });
  const logPrior = docs.map((d) => Math.log(d / (docs[0] + docs[1])));
  const logLik = counts.map((c, y) => Float64Array.from(c, (n) => Math.log((n + alpha) / (totals[y] + alpha * dims))));
  return {
    predict(tokens) {
      const s = [logPrior[0], logPrior[1]];
      for (const t of tokens) {
        const i = index.get(t);
        if (i !== undefined) {
          s[0] += logLik[0][i];
          s[1] += logLik[1][i];
        }
      }
      return s[1] > s[0] ? 1 : 0;
    },
  };
}

function evaluate(predicted, actual) {
  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;
  predicted.forEach((p, i) => {
    if (p === 1 && actual[i] === 1) tp += 1;
    else if (p === 0 && actual[i] === 0) tn += 1;
    else if (p === 1) fp += 1;
    else fn += 1;
  });
  const precision = tp / (tp + fp || 1);
  const recall = tp / (tp + fn || 1);
  const r4 = (x) => Math.round(x * 10000) / 10000;
  return {
    n: actual.length,
    accuracy: r4((tp + tn) / (actual.length || 1)),
    precisionFake: r4(precision),
    recallFake: r4(recall),
    f1Fake: r4((2 * precision * recall) / (precision + recall || 1)),
    confusion: { truePositiveFake: tp, trueNegativeReal: tn, falsePositiveFake: fp, falseNegativeFake: fn },
  };
}

/**
 * Full training run. Returns { model, metrics }.
 * @param {Array<{text:string,label:0|1}>} samples
 */
function train(samples, { testRatio = 0.2, seed = 42, maxFeatures = 30000, dataset = 'unknown' } = {}) {
  const { train: tr, test: te } = stratifiedSplit(samples, testRatio, seed);
  const trTokens = tr.map((s) => featurize(s.text));
  const teTokens = te.map((s) => featurize(s.text));
  const { vocab, idf } = buildVocabulary(trTokens, { maxFeatures });
  const index = new Map(vocab.map((t, i) => [t, i]));
  const trVec = trTokens.map((t) => vectorize(t, index, idf));
  const teVec = teTokens.map((t) => vectorize(t, index, idf));
  const trY = tr.map((s) => s.label);
  const teY = te.map((s) => s.label);

  const lrModel = trainLogistic(trVec, trY, vocab.length, { seed });
  const lrPred = teVec.map((x) => {
    let z = lrModel.bias;
    for (const [j, v] of x) z += lrModel.weights[j] * v;
    return sigmoid(z) >= 0.5 ? 1 : 0;
  });
  const nb = trainNaiveBayes(trTokens, trY, index);
  const nbPred = teTokens.map((t) => nb.predict(t));

  const metrics = {
    dataset,
    trainSize: tr.length,
    testSize: te.length,
    features: vocab.length,
    seed,
    logisticRegression: evaluate(lrPred, teY),
    naiveBayesBaseline: evaluate(nbPred, teY),
  };

  // Strongest indicators (most positive weight = fake, most negative = real).
  const ranked = [...lrModel.weights].map((wt, i) => [vocab[i], wt]).sort((a, b) => b[1] - a[1]);
  metrics.topFakeIndicators = ranked.slice(0, 15).map(([t, wt]) => [t, Math.round(wt * 100) / 100]);
  metrics.topRealIndicators = ranked.slice(-15).reverse().map(([t, wt]) => [t, Math.round(wt * 100) / 100]);

  const round = (x) => Math.round(x * 1e4) / 1e4;
  const model = {
    type: 'tfidf-logistic-regression',
    version: 1,
    trainedAt: new Date().toISOString(),
    labels: { 0: 'REAL', 1: 'FAKE' },
    features: { ngram: 2, stemmer: 'porter', sublinearTf: true, norm: 'l2' },
    vocab,
    idf: idf.map(round),
    weights: [...lrModel.weights].map(round),
    bias: round(lrModel.bias),
    metrics,
  };
  return { model, metrics };
}

/* ------------------------------------------------------------------ */
/* Inference                                                           */
/* ------------------------------------------------------------------ */

/** Wrap a model JSON for fast repeated predictions. */
function loadModel(json) {
  const index = new Map(json.vocab.map((t, i) => [t, i]));
  return {
    meta: { type: json.type, trainedAt: json.trainedAt, metrics: json.metrics },
    /** IDF of a (stemmed) term, or undefined if it is not in the vocabulary. */
    idf: (term) => (index.has(term) ? json.idf[index.get(term)] : undefined),
    /** @returns {{ probabilityFake:number, knownFeatures:number, topTerms:Array }} */
    predict(text) {
      const tokens = featurize(text);
      const x = vectorize(tokens, index, json.idf);
      let z = json.bias;
      const contrib = [];
      for (const [j, v] of x) {
        const c = json.weights[j] * v;
        z += c;
        contrib.push([json.vocab[j], c]);
      }
      contrib.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
      return {
        probabilityFake: sigmoid(z),
        knownFeatures: x.size,
        topTerms: contrib.slice(0, 8).map(([t, cv]) => ({
          term: t.replace(/_/g, ' '),
          pushesTowards: cv > 0 ? 'FAKE' : 'REAL',
          weight: Math.round(cv * 1000) / 1000,
        })),
      };
    },
  };
}

module.exports = {
  featurize, vectorize, stratifiedSplit, buildVocabulary, trainLogistic, trainNaiveBayes, evaluate, train, loadModel, rng,
};
