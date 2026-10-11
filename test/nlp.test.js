'use strict';

/**
 * Unit tests for the NLP / ML modules (no server needed).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const text = require('../src/nlp/text');
const { extractEntities } = require('../src/nlp/ner');
const { assessSource, parseTrustedDomains } = require('../src/nlp/source');
const { extractText } = require('../src/nlp/extract');
const classifier = require('../src/nlp/classifier');
const { analyzeDocument } = require('../src/nlp/analyze');
const { createChatbot } = require('../src/nlp/chatbot');
const { makeDocx, makePdf, makeZip, makePng } = require('./fixtures');

const FIX = path.join(__dirname, 'fixtures');
const REAL = fs.readFileSync(path.join(FIX, 'real-article.txt'), 'utf8');
const FAKE = fs.readFileSync(path.join(FIX, 'fake-article.txt'), 'utf8');

describe('text mining primitives', () => {
  it('Porter stemmer matches the reference algorithm', () => {
    const pairs = {
      caresses: 'caress', ponies: 'poni', cats: 'cat', agreed: 'agre', plastered: 'plaster', motoring: 'motor',
      hopping: 'hop', falling: 'fall', happy: 'happi', relational: 'relat', conditional: 'condit',
      generalization: 'gener', hopefulness: 'hope', electrical: 'electr', adjustment: 'adjust', effective: 'effect',
    };
    for (const [w, s] of Object.entries(pairs)) assert.equal(text.stem(w), s, w);
  });

  it('tokenises, removes stop words and stems', () => {
    assert.deepEqual(text.terms('The researchers were running studies on connected networks.'),
      ['research', 'run', 'studi', 'connect', 'network']);
  });

  it('builds unigrams + bigrams', () => {
    assert.deepEqual(text.ngrams(['a', 'b', 'c']), ['a', 'b', 'c', 'a_b', 'b_c']);
  });

  it('splits sentences without breaking on abbreviations', () => {
    assert.deepEqual(text.sentences('Dr. Hans Kluge met U.S. officials. Then he left!'),
      ['Dr. Hans Kluge met U.S. officials.', 'Then he left!']);
  });

  it('style signals separate clickbait from attributed reporting', () => {
    const fake = text.styleSignals(FAKE);
    const real = text.styleSignals(REAL);
    assert.ok(fake.sensationalTerms > 5 && fake.exclamations > 3);
    assert.ok(real.attributionTerms > 5 && real.sensationalTerms === 0);
    assert.equal(typeof real.readability, 'number');
  });

  it('maps stems back to readable words', () => {
    const forms = text.surfaceForms('Measles cases rose. Measles is back.');
    assert.equal(text.readable('measl_case', forms), 'measles cases');
  });
});

describe('named-entity recognition', () => {
  it('finds people, organisations, places, dates, money, percentages, emails and URLs', () => {
    const { entities, counts } = extractEntities(
      'On March 3, 2024 the World Health Organization said in Geneva that Dr. Tedros Adhanom met Prime Minister '
      + 'Narendra Modi. India pledged $2.5 billion and cases fell 12% since 2019. Reuters reported it. Contact press@who.int '
      + 'or see https://www.who.int/news.',
    );
    const has = (type, t) => entities.some((e) => e.type === type && e.text === t);
    assert.ok(has('PERSON', 'Tedros Adhanom'));
    assert.ok(has('PERSON', 'Narendra Modi'));
    assert.ok(has('ORGANIZATION', 'World Health Organization'));
    assert.ok(has('ORGANIZATION', 'Reuters'));
    assert.ok(has('PLACE', 'Geneva'));
    assert.ok(has('DATE', 'March 3, 2024'));
    assert.ok(has('MONEY', '$2.5 billion'));
    assert.ok(has('PERCENT', '12%'));
    assert.ok(has('EMAIL', 'press@who.int'));
    assert.ok(has('URL', 'https://www.who.int/news'));
    assert.ok(counts.PERSON >= 2);
  });

  it('counts repeated mentions once per extractor and merges "the X" with "X"', () => {
    const { entities } = extractEntities('Reuters said it. Reuters again. The WHO and WHO agreed.');
    assert.equal(entities.find((e) => e.text === 'Reuters').count, 2);
    assert.equal(entities.filter((e) => e.type === 'ORGANIZATION' && /who/i.test(e.text)).length, 1);
  });
});

describe('source credibility', () => {
  const cases = [
    ['https://www.reuters.com/world/x', 'reputable'],
    ['https://news.bbc.co.uk/x', 'reputable'],
    ['https://pib.gov.in/x', 'reputable'],
    ['https://www.cdc.gov.example.org/x', 'unknown'],
    ['https://dept.mit.edu/x', 'institutional'],
    ['https://infowars.com/x', 'unreliable'],
    ['https://abcnews.com.co/x', 'unreliable'],
    ['https://theonion.com/x', 'satire'],
    ['https://bbc-news.co/x', 'suspicious'],
    ['https://reuterz.com/x', 'suspicious'],
    ['https://cnn-breaking-news.com', 'suspicious'],
    ['https://free-news.xyz', 'suspicious'],
    ['http://203.0.113.9/x', 'suspicious'],
    ['javascript:alert(1)', 'invalid'],
    ['https://someblog.net', 'unknown'],
  ];
  for (const [url, category] of cases) {
    it(`${url} -> ${category}`, () => assert.equal(assessSource(url, []).category, category));
  }

  it('honours the uploader\'s trusted domains (and their subdomains)', () => {
    const trusted = parseTrustedDomains('https://www.mycollege.edu.in/, example.org  bad_domain');
    assert.deepEqual(trusted, ['mycollege.edu.in', 'example.org']);
    assert.equal(assessSource('https://news.example.org/a', trusted).category, 'trusted-by-you');
  });

  it('reports "none" when no URL is given', () => {
    assert.equal(assessSource('', []).provided, false);
  });
});

describe('text extraction', () => {
  it('DOCX (zip + XML)', () => {
    assert.match(extractText(makeDocx(), 'a.docx').text, /Vshare test document/);
  });

  it('PPTX slides', () => {
    const slide = '<p:sld xmlns:a="a" xmlns:p="p"><a:p><a:r><a:t>Lecture 4: Graphs</a:t></a:r></a:p><a:p><a:r><a:t>BFS and DFS</a:t></a:r></a:p></p:sld>';
    const pptx = makeZip([['ppt/slides/slide1.xml', slide], ['ppt/slides/slide2.xml', slide.replace('4', '5')]]);
    const { text: t } = extractText(pptx, 'deck.pptx');
    assert.match(t, /Lecture 4: Graphs\nBFS and DFS/);
    assert.match(t, /Lecture 5/);
  });

  it('simple PDF (literal strings)', () => {
    assert.match(extractText(makePdf(), 'a.pdf').text, /Vshare test PDF/);
  });

  it('Chrome-generated PDF with embedded CID fonts (ToUnicode CMaps)', () => {
    const { text: t } = extractText(fs.readFileSync(path.join(FIX, 'chrome-cid-fonts.pdf')), 'r.pdf');
    assert.match(t, /Researchers at Stanford University published a peer-reviewed study in Nature on Tuesday\./);
    assert.match(t, /reduced symptoms by 31 percent/);
  });

  it('HTML without scripts or styles', () => {
    const { text: t } = extractText(Buffer.from('<style>x{}</style><p>Hello &amp; <b>world</b></p><script>alert(1)</script>'), 'a.html');
    assert.equal(t, 'Hello & world');
  });

  it('unsupported or corrupt files yield no text and no exception', () => {
    assert.deepEqual(extractText(makePng(8, 8), 'a.png'), { text: '', method: 'png', supported: false });
    const bad = extractText(Buffer.from('not a zip'), 'a.docx');
    assert.equal(bad.text, '');
    assert.ok(bad.error);
  });
});

describe('classifier', () => {
  it('learns a separable toy problem and reports metrics', () => {
    const samples = [];
    for (let i = 0; i < 60; i++) {
      samples.push({ text: `shocking secret miracle cure banned hoax number ${i} wow`, label: 1 });
      samples.push({ text: `officials said the committee published quarterly report data ${i}`, label: 0 });
    }
    const { model, metrics } = classifier.train(samples, { testRatio: 0.25, seed: 1 });
    assert.equal(metrics.logisticRegression.accuracy, 1);
    const m = classifier.loadModel(model);
    assert.ok(m.predict('a shocking miracle cure').probabilityFake > 0.5);
    assert.ok(m.predict('the committee published a report').probabilityFake < 0.5);
  });

  it('stratified split is deterministic and keeps class balance', () => {
    const samples = Array.from({ length: 100 }, (_, i) => ({ text: `t${i}`, label: i % 2 }));
    const a = classifier.stratifiedSplit(samples, 0.2, 7);
    const b = classifier.stratifiedSplit(samples, 0.2, 7);
    assert.deepEqual(a.test.map((s) => s.text), b.test.map((s) => s.text));
    assert.equal(a.test.filter((s) => s.label === 1).length, 10);
  });

  it('drops scraping/date artifacts from features', () => {
    const f = classifier.featurize('Posted October 12 via Twitter: share this article http://x.com');
    assert.ok(!f.some((t) => /octob|twitter|share|articl|http/.test(t)), f.join(','));
  });

  it('the shipped model reports >= 85% held-out accuracy and separates the samples', () => {
    const json = require('../src/nlp/fake-news-model.json');
    assert.ok(json.metrics.logisticRegression.accuracy >= 0.85);
    assert.ok(json.metrics.testSize > 1000);
    const m = classifier.loadModel(json);
    assert.ok(m.predict(FAKE).probabilityFake > 0.8);
  });
});

describe('credibility analysis (fusion)', () => {
  it('clickbait from a throwaway domain is likely fake and not shareable', () => {
    const r = analyzeDocument({ text: FAKE, sourceUrl: 'https://truth-news-now.xyz/cure' });
    assert.equal(r.verdict, 'likely-fake');
    assert.equal(r.shareable, false);
    assert.ok(r.credibility < 45);
  });

  it('attributed reporting from a reputable source is credible and shareable', () => {
    const r = analyzeDocument({ text: REAL, sourceUrl: 'https://www.reuters.com/world/europe/measles' });
    assert.equal(r.verdict, 'credible');
    assert.equal(r.shareable, true);
    assert.ok(r.keywords.includes('measles'));
    assert.ok(r.summary.length >= 1);
    assert.ok(r.entities.some((e) => e.type === 'PERSON' && e.text === 'Hans Kluge'));
  });

  it('a reputable source cannot rescue text the model is sure is fake', () => {
    const r = analyzeDocument({ text: FAKE, sourceUrl: 'https://www.reuters.com/x' });
    assert.equal(r.shareable, false);
  });

  it('satire and look-alike sources are capped even for sober text', () => {
    for (const u of ['https://theonion.com/x', 'https://reuterss.com/x']) {
      const r = analyzeDocument({ text: REAL, sourceUrl: u });
      assert.equal(r.shareable, false, u);
      assert.ok(r.credibility <= 35, u);
    }
  });

  it('too little text: no ML score, not shareable without a strong source', () => {
    const r = analyzeDocument({ text: 'Just a caption.', sourceUrl: '' });
    assert.equal(r.components.ml, null);
    assert.equal(r.shareable, false);
  });
});

describe('help chatbot', () => {
  const config = require('../src/config');
  const bot = createChatbot(config, null);
  const expect = {
    hi: 'greeting',
    'how do I upload a file?': 'share_how',
    'what is the max file size': 'size',
    'I forgot my password and the file is locked': 'password',
    'my link says it self-destructed': 'gone',
    'it says different campus': 'context_student',
    'how do I generate a key for my students': 'context_faculty',
    'where can I find CSE year 2 notes': 'study_student',
    'how accurate is your machine learning model?': 'verify_how',
    'why was my document rejected': 'verify_rejected',
    'is my data encrypted': 'security',
  };
  for (const [q, intent] of Object.entries(expect)) {
    it(`"${q}" -> ${intent}`, () => assert.equal(bot.respond(q).intent, intent));
  }
  it('falls back with suggestions for off-topic questions', () => {
    const r = bot.respond('what is the weather in Paris');
    assert.equal(r.intent, 'fallback');
    assert.ok(r.suggestions.length > 0);
  });
});
