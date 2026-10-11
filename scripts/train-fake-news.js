'use strict';

/**
 * Train the fake-news classifier and write src/nlp/fake-news-model.json.
 *   npm run train:model                       # downloads the dataset if needed
 *   npm run train:model -- path/to/dataset.csv
 *
 * Dataset: "fake_or_real_news.csv" (6,335 labelled news articles, columns
 * id,title,text,label with label FAKE/REAL), mirrored at
 * https://github.com/lutzhamel/fake-news. It is downloaded to data/datasets/
 * (git-ignored) and is NOT redistributed in this repository.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { train } = require('../src/nlp/classifier');

const ROOT = path.resolve(__dirname, '..');
const DATA_URL = 'https://raw.githubusercontent.com/lutzhamel/fake-news/master/data/fake_or_real_news.csv';
const DEFAULT_CSV = path.join(ROOT, 'data', 'datasets', 'fake_or_real_news.csv');
const MODEL_OUT = path.join(ROOT, 'src', 'nlp', 'fake-news-model.json');
const METRICS_OUT = path.join(ROOT, 'docs', 'ml-metrics.json');

/** RFC 4180 CSV parser (quoted fields, escaped quotes, embedded newlines). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function download(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(download(res.headers.location, dest));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`download failed: HTTP ${res.statusCode}`));
        return;
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
    }).on('error', reject);
  });
}

async function main() {
  const csvPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_CSV;
  if (!fs.existsSync(csvPath)) {
    console.log(`Downloading dataset to ${csvPath} …`);
    await download(DATA_URL, csvPath);
  }
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const header = rows.shift().map((h) => h.trim().toLowerCase());
  const iTitle = header.indexOf('title');
  const iText = header.indexOf('text');
  const iLabel = header.indexOf('label');
  if (iText < 0 || iLabel < 0) throw new Error('CSV needs "text" and "label" columns');

  const samples = [];
  for (const r of rows) {
    const label = String(r[iLabel] || '').trim().toUpperCase();
    if (label !== 'FAKE' && label !== 'REAL') continue;
    const text = `${iTitle >= 0 ? r[iTitle] : ''}\n${r[iText] || ''}`.trim();
    if (text.length < 40) continue;
    samples.push({ text, label: label === 'FAKE' ? 1 : 0 });
  }
  const fake = samples.filter((s) => s.label === 1).length;
  console.log(`Loaded ${samples.length} articles (${fake} FAKE, ${samples.length - fake} REAL).`);

  const t0 = Date.now();
  const { model, metrics } = train(samples, { dataset: 'fake_or_real_news.csv (McIntire, 6,335 articles)' });
  metrics.trainingSeconds = Math.round((Date.now() - t0) / 100) / 10;

  fs.writeFileSync(MODEL_OUT, JSON.stringify(model));
  fs.mkdirSync(path.dirname(METRICS_OUT), { recursive: true });
  fs.writeFileSync(METRICS_OUT, `${JSON.stringify(metrics, null, 2)}\n`);

  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const show = (name, m) => console.log(
    `${name.padEnd(22)} accuracy ${pct(m.accuracy)}  precision(FAKE) ${pct(m.precisionFake)}  `
    + `recall(FAKE) ${pct(m.recallFake)}  F1 ${pct(m.f1Fake)}`,
  );
  console.log(`\nHeld-out test set: ${metrics.testSize} articles (train ${metrics.trainSize}), ${metrics.features} features`);
  show('Logistic regression', metrics.logisticRegression);
  show('Naive Bayes baseline', metrics.naiveBayesBaseline);
  console.log('Confusion (LR):', metrics.logisticRegression.confusion);
  console.log(`\nModel written to ${path.relative(ROOT, MODEL_OUT)} (${Math.round(fs.statSync(MODEL_OUT).size / 1024)} KB)`);
  console.log(`Metrics written to ${path.relative(ROOT, METRICS_OUT)} (training took ${metrics.trainingSeconds}s)`);
}

module.exports = { parseCsv };

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
