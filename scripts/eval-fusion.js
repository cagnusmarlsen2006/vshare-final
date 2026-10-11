'use strict';

/**
 * Evaluate the fused credibility score (ML + style, no source URL) on the SAME
 * held-out test split the model was evaluated on, for several weightings.
 *   npm run eval:fusion [-- path/to/fake_or_real_news.csv]
 * Writes docs/ml-fusion-eval.txt. Used to choose WEIGHTS.noSource in analyze.js.
 */
const fs = require('fs');
const path = require('path');
const { parseCsv } = require('./train-fake-news');
const { stratifiedSplit, loadModel } = require('../src/nlp/classifier');
const { styleSignals } = require('../src/nlp/text');
const { extractEntities } = require('../src/nlp/ner');
const { styleScore, THRESHOLDS } = require('../src/nlp/analyze');

const ROOT = path.resolve(__dirname, '..');
const csvPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'data', 'datasets', 'fake_or_real_news.csv');
if (!fs.existsSync(csvPath)) {
  console.error(`Dataset not found at ${csvPath}. Run "npm run train:model" first (it downloads it).`);
  process.exit(1);
}
const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
rows.shift();
const samples = rows
  .filter((r) => r[3] === 'FAKE' || r[3] === 'REAL')
  .map((r) => ({ text: `${r[1]}\n${r[2]}`.trim(), label: r[3] === 'FAKE' ? 1 : 0 }))
  .filter((s) => s.text.length >= 40);
const { test } = stratifiedSplit(samples, 0.2, 42); // same split as training
const model = loadModel(JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'nlp', 'fake-news-model.json'), 'utf8')));

console.log(`Scoring ${test.length} held-out articles …`);
const scored = test.map((s) => ({
  y: s.label,
  p: model.predict(s.text).probabilityFake,
  style: styleScore(styleSignals(s.text), extractEntities(s.text.slice(0, 20000)).counts).score,
}));

const lines = [
  `Fused credibility on the held-out test set (${test.length} articles, no source URL).`,
  `Verdict bands: credible >= ${THRESHOLDS.credible}, uncertain >= ${THRESHOLDS.uncertain}, else likely-fake.`,
  'Only "credible" files are shared. "fake share-through" = fake articles among the shared ones.',
  '',
  'ML weight | style weight | accuracy@50 | shared real/fake | uncertain real/fake | likely-fake real/fake | fake share-through',
];
for (const w of [1, 0.9, 0.8, 0.7, 0.6, 0.5]) {
  let ok = 0;
  const band = { credible: [0, 0], uncertain: [0, 0], fake: [0, 0] };
  for (const r of scored) {
    const c = w * (1 - r.p) + (1 - w) * r.style;
    if ((c >= 0.5 ? 0 : 1) === r.y) ok += 1;
    const b = c * 100 >= THRESHOLDS.credible ? 'credible' : c * 100 >= THRESHOLDS.uncertain ? 'uncertain' : 'fake';
    band[b][r.y] += 1;
  }
  const through = (band.credible[1] / (band.credible[0] + band.credible[1] || 1)) * 100;
  lines.push(`${w.toFixed(1).padStart(9)} | ${(1 - w).toFixed(1).padStart(12)} | ${((ok / scored.length) * 100).toFixed(1).padStart(10)}% | `
    + `${`${band.credible[0]}/${band.credible[1]}`.padStart(16)} | ${`${band.uncertain[0]}/${band.uncertain[1]}`.padStart(19)} | `
    + `${`${band.fake[0]}/${band.fake[1]}`.padStart(21)} | ${through.toFixed(1).padStart(17)}%`);
}
const out = `${lines.join('\n')}\n`;
fs.writeFileSync(path.join(ROOT, 'docs', 'ml-fusion-eval.txt'), out);
console.log(out);
