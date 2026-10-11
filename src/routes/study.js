'use strict';

/**
 * Study-material smart distribution.
 *   Faculty:  POST /api/study/upload   department, year, subject, material_type, [expiry], THEN file
 *   Students: GET  /api/study/materials?department=CSE&year=1
 * Files are encrypted like every other upload and downloaded through their
 * normal /f/:id page (no download limit, long expiry). Text documents are
 * auto-tagged with TF-IDF keywords (text mining) so students can scan the list.
 */
const express = require('express');
const { createUploadHandler, parseSettings, UploadError } = require('./upload');
const { extractText } = require('../nlp/extract');
const { extractKeywords } = require('../nlp/analyze');
const log = require('../logger');

const TEXT_DOC_RE = /\.(pdf|docx|pptx|txt|md|html?|csv)$/i;

function createStudyRouter(deps) {
  const { config, repo, limiters } = deps;
  const router = express.Router();

  const profile = {
    fields: new Set(['department', 'year', 'subject', 'material_type', 'expiry']),
    captureText: (name) => TEXT_DOC_RE.test(name),
    captureMax: 10 * 1024 * 1024,
    parse(fields) {
      if (!config.DEPARTMENTS.includes(fields.department)) throw new UploadError(400, 'Choose a valid department.');
      if (!config.YEARS.includes(fields.year)) throw new UploadError(400, 'Choose a valid year (1-4).');
      if (!config.MATERIAL_TYPES.includes(fields.material_type)) throw new UploadError(400, 'Choose a valid material type.');
      const subject = String(fields.subject || '').trim().replace(/\s+/g, ' ');
      if (subject.length < 2 || subject.length > 80) throw new UploadError(400, 'Enter a subject (2-80 characters).');
      let expiryMs;
      if (config.TEST_HOOKS && fields.expiry_seconds !== undefined) {
        ({ expiryMs } = parseSettings({ expiry_seconds: fields.expiry_seconds }, config));
      } else {
        const expiry = fields.expiry || config.DEFAULT_STUDY_EXPIRY;
        if (!Object.prototype.hasOwnProperty.call(config.STUDY_EXPIRY_OPTIONS, expiry)) {
          throw new UploadError(400, `Invalid expiry. Choose one of: ${Object.keys(config.STUDY_EXPIRY_OPTIONS).join(', ')}.`);
        }
        expiryMs = config.STUDY_EXPIRY_OPTIONS[expiry];
      }
      return {
        expiryMs,
        maxDownloads: null,
        password: null,
        kind: 'study',
        meta: { department: fields.department, year: fields.year, subject, materialType: fields.material_type },
      };
    },
    finalize({ settings, captured, name }) {
      if (!captured) return {};
      try {
        const { text } = extractText(captured, name);
        const keywords = text && text.split(/\s+/).length >= 20 ? extractKeywords(text, 6) : [];
        return { meta: { ...settings.meta, keywords } };
      } catch (err) {
        log.warn(`keyword extraction failed: ${err.message}`);
        return {};
      }
    },
    respond: ({ id, name, size, expiresAt, meta, deleteToken }) => ({
      id, name, size, expiresAt, ...meta, sharePath: `/f/${id}`, deletePath: `/f/${id}/delete?token=${deleteToken}`,
    }),
  };
  router.post('/api/study/upload', limiters.upload, deps.auth.requireFaculty, createUploadHandler(deps, profile));

  router.get('/api/study/materials', (req, res) => {
    const { department, year } = req.query;
    if (!config.DEPARTMENTS.includes(department) || !config.YEARS.includes(year)) {
      res.status(400).json({ error: 'Choose a valid department and year.' });
      return;
    }
    const materials = repo.listStudy(department, year, Date.now()).map((r) => {
      let meta = {};
      try {
        meta = JSON.parse(r.meta || '{}');
      } catch {
        meta = {};
      }
      return {
        id: r.id,
        name: r.original_name,
        size: r.size,
        subject: meta.subject,
        materialType: meta.materialType,
        keywords: meta.keywords || [],
        uploadedAt: r.created_at,
        expiresAt: r.expires_at,
        path: `/f/${r.id}`,
      };
    });
    res.set('Cache-Control', 'no-store').json({ department, year, materials });
  });

  return router;
}

module.exports = { createStudyRouter };
