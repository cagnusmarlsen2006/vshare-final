'use strict';

/**
 * Plain-text extraction from uploaded documents, dependency-free:
 *   .txt .md .csv .json .html/.htm  -> decode (+ strip tags)
 *   .docx .pptx                     -> minimal ZIP reader + XML text
 *   .pdf                            -> minimal PDF content-stream parser
 *                                      (FlateDecode, Tj/TJ/'/", ToUnicode CMaps)
 * Anything else (images, video, archives) yields no text.
 *
 * Defensive limits guard against zip/deflate bombs and pathological files.
 * The parsers only READ data; nothing in a document is ever executed.
 */
const path = require('path');
const zlib = require('zlib');

const MAX_INFLATED = 25 * 1024 * 1024; // per entry / stream
const MAX_TEXT = 400000; // characters returned

const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.json', '.log', '.rtf']);
const HTML_EXT = new Set(['.html', '.htm', '.xhtml']);

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function safeChar(code) {
  try {
    return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
  } catch {
    return ' ';
  }
}

function htmlToText(html) {
  return decodeEntities(String(html)
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

/* ------------------------------------------------------------------ */
/* Minimal ZIP reader (stored + deflate entries)                       */
/* ------------------------------------------------------------------ */
function readZip(buf) {
  const entries = new Map();
  // Find End Of Central Directory (scan back max 64 KB + 22).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, compSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: () => [...entries.keys()],
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      if (e.size > MAX_INFLATED) throw new Error('zip entry too large');
      const lh = e.localOffset;
      if (buf.readUInt32LE(lh) !== 0x04034b50) throw new Error('bad zip local header');
      const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
      const data = buf.subarray(start, start + e.compSize);
      if (e.method === 0) return data;
      if (e.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_INFLATED });
      throw new Error(`unsupported zip method ${e.method}`);
    },
  };
}

function xmlRunsToText(xml, paragraphTag) {
  return decodeEntities(xml
    .replace(new RegExp(`</${paragraphTag}>`, 'g'), '\n')
    .replace(/<w:tab\/>|<a:tab\/>/g, ' ')
    .replace(/<w:br\/>|<a:br\/>/g, '\n')
    .replace(/<[^>]+>/g, ''));
}

function docxToText(buf) {
  const zip = readZip(buf);
  const parts = zip.names().filter((n) => /^word\/(document|header\d*|footer\d*|footnotes)\.xml$/.test(n)).sort();
  return parts.map((n) => xmlRunsToText(zip.read(n).toString('utf8'), 'w:p')).join('\n');
}

function pptxToText(buf) {
  const zip = readZip(buf);
  const slides = zip.names()
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  return slides.map((n) => xmlRunsToText(zip.read(n).toString('utf8'), 'a:p')).join('\n\n');
}

/* ------------------------------------------------------------------ */
/* Minimal PDF text extractor                                          */
/* ------------------------------------------------------------------ */

/** Decode all streams; returns [{ dict, data }]. */
function pdfStreams(buf) {
  const s = buf.toString('latin1');
  const out = [];
  const re = /<<((?:[^<>]|<<(?:[^<>]|<<[^<>]*>>)*>>|<[^<>]*>)*)>>\s*stream\r?\n/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const dict = m[1];
    const start = m.index + m[0].length;
    const lenMatch = dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
    let end = lenMatch ? start + Number(lenMatch[1]) : -1;
    if (end < 0 || end > s.length || s.slice(end, end + 30).indexOf('endstream') < 0) {
      end = s.indexOf('endstream', start);
      if (end < 0) break;
    }
    let data = buf.subarray(start, end);
    if (/\/FlateDecode/.test(dict)) {
      try {
        data = zlib.inflateSync(data, { maxOutputLength: MAX_INFLATED });
      } catch {
        try {
          data = zlib.inflateRawSync(data.subarray(2), { maxOutputLength: MAX_INFLATED });
        } catch {
          continue;
        }
      }
    } else if (/\/Filter/.test(dict)) {
      continue; // DCT/JBIG2/etc: images, no text
    }
    out.push({ dict, data });
    re.lastIndex = end;
  }
  return out;
}

/** Merge every ToUnicode CMap into one code -> string table (keyed by hex code). */
function parseCMaps(streams) {
  const map = new Map();
  const hexToStr = (hex) => {
    let r = '';
    for (let i = 0; i + 4 <= hex.length; i += 4) r += safeChar(parseInt(hex.slice(i, i + 4), 16));
    return r;
  };
  for (const { data } of streams) {
    const t = data.toString('latin1');
    if (t.indexOf('begincmap') < 0) continue;
    for (const block of t.match(/beginbfchar([\s\S]*?)endbfchar/g) || []) {
      for (const [, src, dst] of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
        map.set(src.toLowerCase(), hexToStr(dst));
      }
    }
    for (const block of t.match(/beginbfrange([\s\S]*?)endbfrange/g) || []) {
      for (const [, lo, hi, rest] of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]+>|\[[^\]]*\])/g)) {
        const a = parseInt(lo, 16);
        const b = parseInt(hi, 16);
        if (b - a > 65535) continue;
        if (rest.startsWith('[')) {
          const dsts = rest.match(/<([0-9a-fA-F]*)>/g) || [];
          for (let k = 0; k <= b - a && k < dsts.length; k++) {
            map.set((a + k).toString(16).padStart(lo.length, '0'), hexToStr(dsts[k].slice(1, -1)));
          }
        } else {
          const base = parseInt(rest.slice(1, -1), 16);
          for (let k = 0; k <= b - a; k++) {
            map.set((a + k).toString(16).padStart(lo.length, '0'), safeChar(base + k));
          }
        }
      }
    }
  }
  return map;
}

function decodePdfString(bytes, cmap) {
  if (cmap.size) {
    const hex = Buffer.from(bytes).toString('hex');
    // Try 2-byte codes (Identity-H CID fonts), then 1-byte codes.
    for (const width of [4, 2]) {
      if (hex.length % width) continue;
      let ok = true;
      let out = '';
      for (let i = 0; i < hex.length; i += width) {
        const ch = cmap.get(hex.slice(i, i + width));
        if (ch === undefined) {
          ok = false;
          break;
        }
        out += ch;
      }
      if (ok) return out;
    }
  }
  return Buffer.from(bytes).toString('latin1');
}

/** Tokenise a content stream and collect text from text-showing operators. */
function contentToText(content, cmap) {
  const s = content.toString('latin1');
  let out = '';
  let i = 0;
  const operands = [];
  const readLiteral = () => {
    // at '(' ; handles nesting and escapes
    const bytes = [];
    let depth = 1;
    i += 1;
    while (i < s.length && depth > 0) {
      let ch = s[i];
      if (ch === '\\') {
        i += 1;
        ch = s[i];
        const esc = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
        if (ch in esc) bytes.push(esc[ch]);
        else if (/[0-7]/.test(ch)) {
          let oct = ch;
          while (oct.length < 3 && /[0-7]/.test(s[i + 1])) oct += s[++i];
          bytes.push(parseInt(oct, 8) & 0xff);
        } else if (ch === '\r' || ch === '\n') {
          if (ch === '\r' && s[i + 1] === '\n') i += 1;
        } else bytes.push(ch.charCodeAt(0) & 0xff);
      } else if (ch === '(') {
        depth += 1;
        bytes.push(40);
      } else if (ch === ')') {
        depth -= 1;
        if (depth > 0) bytes.push(41);
      } else bytes.push(ch.charCodeAt(0) & 0xff);
      i += 1;
    }
    return { str: bytes };
  };
  const readHex = () => {
    const end = s.indexOf('>', i);
    const hex = s.slice(i + 1, end < 0 ? s.length : end).replace(/\s+/g, '');
    i = end < 0 ? s.length : end + 1;
    const padded = hex.length % 2 ? `${hex}0` : hex;
    return { str: [...Buffer.from(padded, 'hex')] };
  };
  let fontSize = 12;
  let charsSinceMove = 0; // glyphs drawn since the last positioning operator
  let lastY = null;
  const show = (operand) => {
    if (operand && operand.str) {
      const t = decodePdfString(operand.str, cmap);
      out += t;
      charsSinceMove += t.length;
    }
  };
  // A same-line move counts as a word gap only if it jumps clearly further than
  // the text drawn since the last move (~0.6 em per glyph); otherwise it is kerning.
  const horizontalMove = (tx) => {
    if (tx > charsSinceMove * 0.6 * fontSize + 0.35 * fontSize && !/\s$/.test(out)) out += ' ';
    charsSinceMove = 0;
  };
  while (i < s.length) {
    const ch = s[i];
    if (ch === '(') {
      operands.push(readLiteral());
    } else if (ch === '<' && s[i + 1] !== '<') {
      operands.push(readHex());
    } else if (ch === '[') {
      operands.push({ arrayStart: true });
      i += 1;
    } else if (ch === ']') {
      const arr = [];
      while (operands.length && !operands[operands.length - 1].arrayStart) arr.unshift(operands.pop());
      operands.pop();
      operands.push({ array: arr });
      i += 1;
    } else if (ch === '%') {
      while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i += 1;
    } else if (/\s/.test(ch)) {
      i += 1;
    } else {
      let j = i;
      while (j < s.length && !/[\s()<>[\]/%]/.test(s[j])) j += 1;
      if (j === i) j = i + 1; // '/' or stray delimiter
      const tok = s.slice(i, j);
      i = j;
      if (/^[-+.\d]/.test(tok) || tok.startsWith('/') || tok === '/') {
        operands.push({ num: Number(tok) });
        continue;
      }
      switch (tok) {
        case 'Tj':
          show(operands[operands.length - 1]);
          break;
        case "'":
        case '"':
          out += '\n';
          show(operands[operands.length - 1]);
          break;
        case 'TJ': {
          const arr = operands[operands.length - 1];
          for (const el of (arr && arr.array) || []) {
            if (el.str) show(el);
            else if (typeof el.num === 'number' && el.num < -200) out += ' '; // big kern = word gap
          }
          break;
        }
        case 'Tf': {
          const size = operands[operands.length - 1];
          if (size && typeof size.num === 'number' && Math.abs(size.num) > 0) fontSize = Math.abs(size.num);
          break;
        }
        case 'Td':
        case 'TD': {
          const tx = operands[operands.length - 2];
          const ty = operands[operands.length - 1];
          if (ty && ty.num) {
            out += '\n';
            charsSinceMove = 0;
          } else horizontalMove(tx && typeof tx.num === 'number' ? tx.num : Infinity);
          break;
        }
        case 'T*':
        case 'ET':
          out += '\n';
          charsSinceMove = 0;
          break;
        case 'Tm': {
          const y = operands[operands.length - 1];
          const yv = y && typeof y.num === 'number' ? y.num : null;
          if (lastY !== null && yv !== lastY) out += '\n';
          else if (!/\s$/.test(out)) out += ' ';
          lastY = yv;
          charsSinceMove = 0;
          break;
        }
        default:
      }
      operands.length = 0;
    }
  }
  return out;
}

function pdfToText(buf) {
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('not a PDF');
  const streams = pdfStreams(buf);
  const cmap = parseCMaps(streams);
  return streams
    .filter(({ data }) => {
      const t = data.subarray(0, 200000).toString('latin1');
      return /\bBT\b/.test(t) && /T[jJ]\b/.test(t) && t.indexOf('begincmap') < 0;
    })
    .map(({ data }) => contentToText(data, cmap))
    .join('\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * @returns {{ text: string, method: string, supported: boolean, error?: string }}
 */
function extractText(buffer, filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  const cap = (t) => String(t).slice(0, MAX_TEXT);
  try {
    if (TEXT_EXT.has(ext)) return { text: cap(buffer.toString('utf8')), method: 'plain', supported: true };
    if (HTML_EXT.has(ext)) return { text: cap(htmlToText(buffer.toString('utf8'))), method: 'html', supported: true };
    if (ext === '.docx') return { text: cap(docxToText(buffer)), method: 'docx', supported: true };
    if (ext === '.pptx') return { text: cap(pptxToText(buffer)), method: 'pptx', supported: true };
    if (ext === '.pdf') return { text: cap(pdfToText(buffer)), method: 'pdf', supported: true };
  } catch (err) {
    return { text: '', method: ext.slice(1) || 'unknown', supported: true, error: err.message };
  }
  return { text: '', method: ext.slice(1) || 'unknown', supported: false };
}

module.exports = { extractText, htmlToText, readZip, pdfToText, docxToText, pptxToText };
