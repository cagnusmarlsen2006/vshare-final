'use strict';

/**
 * Offline help chatbot. Intent classification with text mining:
 *   message -> tokens -> stop words removed -> Porter stems -> TF-IDF vector
 *   -> cosine similarity against each intent's example phrases -> best intent.
 * Answers are templated from live configuration (sizes, campuses, model metrics).
 * No network, no external AI service, nothing is stored.
 */
const { terms } = require('./text');

const fmtMb = (bytes) => `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;

/** Intents: example phrases + answer builder. */
function buildIntents(config, modelMetrics) {
  const acc = modelMetrics ? `${(modelMetrics.logisticRegression.accuracy * 100).toFixed(1)}%` : 'about 90%';
  return [
    {
      id: 'greeting',
      examples: ['hi', 'hello', 'hey there', 'good morning', 'hello bot', 'yo'],
      answer: () => 'Hi! I am the Vshare helper. Ask me how to share a self-destructing file, use a campus key, find study material, or verify a document.',
    },
    {
      id: 'thanks',
      examples: ['thanks', 'thank you', 'great thanks', 'cool that helps', 'awesome'],
      answer: () => 'You are welcome! Anything else?',
    },
    {
      id: 'about',
      examples: ['what is vshare', 'what can you do', 'what does this site do', 'features', 'what systems are there', 'help me'],
      answer: () => 'Vshare has four systems: (1) Self-destructing file sharing, (2) Context-based (campus-locked) sharing with one-time keys, '
        + '(3) Study material distribution by department and year, and (4) Fake-news-proof sharing that checks credibility with NLP and machine learning before sharing.',
      links: [{ label: 'Open the hub', href: '/' }],
    },
    {
      id: 'share_how',
      examples: ['how do i share a file', 'how to upload', 'upload a file', 'send a file to someone', 'create share link', 'make a self destructing share link'],
      answer: () => 'Open "Self-Destructing File Sharing", drop your file, choose when it self-destructs (10 min to 7 days) and/or after how many downloads (1-10), optionally add a password, then copy the share link.',
      links: [{ label: 'Share a file', href: '/share.html' }],
    },
    {
      id: 'expiry',
      examples: ['when does the file expire', 'how long does a link last', 'download limit', 'how many downloads', 'expiry options', 'self destruct time'],
      answer: () => `Choose a time limit (${Object.keys(config.EXPIRY_OPTIONS).join(', ')}) and/or a download limit (1-10). Whichever comes first destroys the file. Opening the link never uses a download; only pressing Download does.`,
    },
    {
      id: 'size',
      examples: ['max file size', 'file too large', 'how big can a file be', 'size limit', 'upload limit mb'],
      answer: () => `The maximum file size is ${fmtMb(config.MAX_FILE_SIZE_BYTES)} (fake-news verification: ${fmtMb(config.VERIFY_MAX_BYTES)}, because the file is analysed in memory).`,
    },
    {
      id: 'password',
      examples: ['password protect file', 'wrong password', 'locked file', 'forgot password', 'too many attempts', 'file is locked'],
      answer: () => 'You can add a password when sharing. After 5 wrong attempts the file is locked for 15 minutes (it is never deleted because of wrong passwords). Passwords are hashed with scrypt.',
    },
    {
      id: 'delete',
      examples: ['delete my file', 'remove file early', 'delete link', 'destroy file now', 'cancel share'],
      answer: () => 'After uploading you get a private "delete now" link. Open it and confirm to destroy the file immediately. Keep that link to yourself.',
    },
    {
      id: 'gone',
      examples: ['file has self destructed', 'my link self destructed', 'it says self destructed', 'link not working', 'link expired', '410 gone', 'cannot download anymore', 'file disappeared'],
      answer: () => 'That file self-destructed: its time ran out, its downloads were used up, or the owner deleted it. It cannot be recovered. Ask the sender to share it again.',
    },
    {
      id: 'security',
      examples: ['is it secure', 'encryption', 'how is my file protected', 'aes', 'who can see my file', 'privacy', 'is my data safe', 'cloudinary'],
      answer: () => 'Every file gets its own random 256-bit key and is encrypted with AES-256-GCM before it leaves the server, so the storage provider only sees ciphertext. Links are random and unguessable, and files are deleted when they expire.',
    },
    {
      id: 'context_faculty',
      examples: ['campus locked sharing', 'generate access key', 'faculty upload key', 'context based sharing', 'share with my campus', 'how do i create a key'],
      answer: () => `In "Context-Based File Sharing", faculty choose a campus (${config.CAMPUSES.join(', ')}), press Generate Key, upload the file and give students the key. The key works only for that campus and only once.`,
      links: [{ label: 'Context-based sharing', href: '/context.html' }],
    },
    {
      id: 'context_student',
      examples: ['i have an access key', 'student access file', 'enter key', 'key not working', 'different campus', 'key already used'],
      answer: () => 'Students select their campus, paste the access key (VS-XXXX-XXXX-XXXX-XXXX) and press Access File. A key works only with the campus it was made for and expires after one download.',
      links: [{ label: 'Access a file', href: '/context.html' }],
    },
    {
      id: 'study_faculty',
      examples: ['distribute study material', 'upload notes for students', 'share question bank', 'send assignment to class', 'faculty distribute material'],
      answer: () => `In "Study Material Distribution", pick the department (${config.DEPARTMENTS.join(', ')}) and year, enter the subject, choose the material type (${config.MATERIAL_TYPES.join(', ')}) and upload. Documents are auto-tagged with keywords.`,
      links: [{ label: 'Distribute material', href: '/study.html' }],
    },
    {
      id: 'study_student',
      examples: ['find notes', 'where are my study materials', 'download syllabus', 'materials for my year', 'question bank for cse'],
      answer: () => 'Open "Study Material Distribution", choose your department and year in the Students section and press Show materials. Each item links to its download page.',
      links: [{ label: 'Find materials', href: '/study.html' }],
    },
    {
      id: 'verify',
      examples: ['fake news', 'verify a file', 'check if news is true', 'fake news detection', 'verify and share', 'misinformation', 'is this news real'],
      answer: () => 'In "Fake News Proof File Sharing", upload a document (PDF, DOCX, PPTX, TXT, HTML) with its source URL. Vshare extracts the text, runs named-entity recognition, text mining and a machine-learning classifier, checks the source, and only shares it if the credibility score is high enough.',
      links: [{ label: 'Verify & share', href: '/verify.html' }],
    },
    {
      id: 'verify_how',
      examples: ['how does the ai work', 'what model do you use', 'machine learning accuracy', 'ner', 'named entity recognition', 'text mining', 'tf idf', 'how accurate is it'],
      answer: () => `The classifier is TF-IDF (stemmed words and word pairs) + logistic regression, trained on 6,335 labelled news articles; held-out test accuracy is ${acc}. NER finds people, organisations, places, dates, money and percentages. The final score also uses writing-style signals (clickbait words, ALL-CAPS, "!", attribution) and the source domain.`,
    },
    {
      id: 'verify_rejected',
      examples: ['why was my file rejected', 'not shared', 'credibility too low', 'my file failed verification', 'uncertain verdict', 'likely fake'],
      answer: () => 'Files are shared only when the credibility score is 65/100 or more. Common reasons for a low score: sensational wording, no attribution to sources, a missing or unknown source URL, a look-alike or known unreliable domain, or too little readable text (scanned images have none). Add the original source URL, or your trusted domains, and try again.',
    },
    {
      id: 'signin',
      examples: ['how do i sign in', 'login with google', 'why cant i upload', 'sign in required', 'how do i become faculty', 'faculty account', 'log out', 'sign out'],
      answer: () => (config.AUTH && config.AUTH.enabled
        ? 'Use "Sign in with Google" at the top right. Signed-in users can upload; faculty actions (campus keys, study material) need an account listed by the administrator in FACULTY_EMAILS. Recipients never need an account. Sign out from the same menu.'
        : 'Sign-in is not configured on this server, so uploading is open to everyone. The administrator can enable Google sign-in with GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.'),
    },
    {
      id: 'theme',
      examples: ['dark mode', 'night theme', 'change theme', 'light mode'],
      answer: () => 'Use the round moon / sun button at the top right to switch between the light and night themes. Your choice is remembered on this device.',
    },
    {
      id: 'goodbye',
      examples: ['bye', 'goodbye', 'see you', 'that is all'],
      answer: () => 'Goodbye! Your files will self-destruct on schedule.',
    },
  ];
}

const SUGGESTIONS = ['How do I share a file?', 'How do campus keys work?', 'Where are my study materials?', 'How does fake news detection work?'];

function createChatbot(config, modelMetrics) {
  const intents = buildIntents(config, modelMetrics);
  // Document frequency over all example phrases.
  const docs = intents.flatMap((it) => it.examples.map((ex) => ({ intent: it, terms: terms(ex) })));
  const df = new Map();
  for (const d of docs) for (const t of new Set(d.terms)) df.set(t, (df.get(t) || 0) + 1);
  const idf = (t) => Math.log((1 + docs.length) / (1 + (df.get(t) || 0))) + 1;
  const vec = (list) => {
    const v = new Map();
    for (const t of list) v.set(t, (v.get(t) || 0) + 1);
    let norm = 0;
    for (const [t, n] of v) {
      const w = n * idf(t);
      v.set(t, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of v) v.set(t, w / norm);
    return v;
  };
  const indexed = docs.map((d) => ({ intent: d.intent, v: vec(d.terms) }));

  return {
    /** @returns {{ reply:string, intent:string, confidence:number, links:Array, suggestions:string[] }} */
    respond(message) {
      const text = String(message || '').slice(0, 500);
      const t = terms(text);
      // Very short greetings are mostly stop words; catch them directly.
      if (!t.length && /^\s*(hi|hey|hello|yo|hii+)\b/i.test(text)) {
        const g = intents.find((i) => i.id === 'greeting');
        return { reply: g.answer(), intent: 'greeting', confidence: 1, links: [], suggestions: SUGGESTIONS };
      }
      const q = vec(t);
      const best = new Map();
      for (const d of indexed) {
        let sim = 0;
        for (const [term, w] of q) sim += w * (d.v.get(term) || 0);
        if (sim > (best.get(d.intent.id)?.sim || 0)) best.set(d.intent.id, { intent: d.intent, sim });
      }
      const ranked = [...best.values()].sort((a, b) => b.sim - a.sim);
      const top = ranked[0];
      if (!top || top.sim < 0.25) {
        return {
          reply: "Sorry, I didn't catch that. I can help with sharing files, campus keys, study materials and fake-news verification. Try one of these:",
          intent: 'fallback',
          confidence: top ? Math.round(top.sim * 100) / 100 : 0,
          links: [],
          suggestions: SUGGESTIONS,
        };
      }
      return {
        reply: top.intent.answer(),
        intent: top.intent.id,
        confidence: Math.round(top.sim * 100) / 100,
        links: top.intent.links || [],
        suggestions: SUGGESTIONS.filter((s) => !terms(s).every((w) => t.includes(w))).slice(0, 3),
      };
    },
  };
}

module.exports = { createChatbot };
