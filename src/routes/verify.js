'use strict';

/**
 * Fake-news-proof sharing.
 *   POST /api/verify/upload   source_url, trusted_domains, [expiry], THEN file
 * The file is encrypted and stored as usual, while an in-memory copy of the
 * plaintext (max VERIFY_MAX_BYTES) is analysed: text extraction -> NER, text
 * mining, ML classifier, source credibility (src/nlp/analyze.js).
 *   credible            -> 201, a normal self-destructing share link + the report
 *   uncertain / fake    -> 422 + the report; the stored file is deleted
 */
const { createUploadHandler, parseSettings, UploadError } = require('./upload');
const { extractText } = require('../nlp/extract');
const { analyzeDocument } = require('../nlp/analyze');
const { parseTrustedDomains } = require('../nlp/source');
const express = require('express');

function createVerifyRouter(deps) {
  const { config, limiters } = deps;
  const router = express.Router();

  const profile = {
    fields: new Set(['source_url', 'trusted_domains', 'expiry']),
    limit: config.VERIFY_MAX_BYTES,
    captureText: true,
    parse(fields) {
      const sourceUrl = String(fields.source_url || '').trim();
      if (sourceUrl.length > 2000) throw new UploadError(400, 'Source URL is too long.');
      const base = parseSettings({ expiry: fields.expiry || '7d', expiry_seconds: fields.expiry_seconds }, config);
      return {
        ...base,
        maxDownloads: null,
        password: null,
        kind: 'verified',
        sourceUrl,
        trustedDomains: parseTrustedDomains(fields.trusted_domains),
      };
    },
    finalize({ settings, captured, name }) {
      const extraction = extractText(captured || Buffer.alloc(0), name);
      const report = analyzeDocument({
        text: extraction.text,
        sourceUrl: settings.sourceUrl,
        trustedDomains: settings.trustedDomains,
        extraction,
      });
      if (!report.shareable) {
        const why = report.verdict === 'likely-fake' ? 'it looks like misinformation' : 'its credibility could not be confirmed';
        return {
          reject: {
            status: 422,
            body: { error: `Not shared: ${why} (credibility ${report.credibility}/100). The file was deleted.`, report },
          },
        };
      }
      return {
        meta: {
          verified: true,
          credibility: report.credibility,
          verdict: report.verdict,
          sourceDomain: report.components.source.domain || null,
          sourceCategory: report.components.source.category,
          keywords: report.keywords,
        },
        report,
      };
    },
    respond: ({ id, name, size, expiresAt, deleteToken, outcome }) => ({
      id,
      name,
      size,
      expiresAt,
      sharePath: `/f/${id}`,
      deletePath: `/f/${id}/delete?token=${deleteToken}`,
      report: outcome.report,
    }),
  };
  router.post('/api/verify/upload', limiters.upload, createUploadHandler(deps, profile));

  return router;
}

module.exports = { createVerifyRouter };
