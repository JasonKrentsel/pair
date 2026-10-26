'use strict';
const crypto = require('node:crypto');
const { sameReview, validReview } = require('./client.cjs');

const MAX_COMMENTS = 10;
const MAX_TEXT = 1500;
const validId = value => typeof value === 'string' && /^[\w-]{1,128}$/.test(value);
const validText = (value, max = MAX_TEXT) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(value);
const textFor = (change, side) => side === 'before' ? change.before : side === 'proposed' ? change.after : change.command;
const sourceLines = text => text.replace(/\r\n|\r/g, '\n').split('\n');

function validFeedback(value) {
  if (!value || value.version !== 1 || !validId(value.scopeId) || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !Array.isArray(value.reviews) || value.reviews.length > 8 || !value.reviews.every(validReview)
    || !Array.isArray(value.threads) || value.threads.length > 100) return false;
  const ids = new Set();
  return value.threads.every(thread => {
    if (!thread || !validId(thread.id) || ids.has(thread.id) || !validId(thread.batchId) || !validId(thread.reviewId)
      || !Number.isSafeInteger(thread.revision) || thread.revision < 1 || typeof thread.fingerprint !== 'string'
      || !Number.isInteger(thread.changeIndex) || thread.changeIndex < 0 || typeof thread.label !== 'string'
      || !['before', 'proposed', 'command'].includes(thread.side) || !Number.isInteger(thread.startLine) || !Number.isInteger(thread.endLine)
      || thread.startLine < 1 || thread.endLine < thread.startLine || thread.endLine - thread.startLine >= 40
      || !['ask', 'revise'].includes(thread.intent) || !validText(thread.text) || typeof thread.excerpt !== 'string' || thread.excerpt.length > 4000
      || typeof thread.snapshotHash !== 'string' || typeof thread.createdAt !== 'string'
      || !['submitted', 'revision-ready', 'answered', 'addressed', 'outdated'].includes(thread.status)
      || thread.latestReviewId !== undefined && !validId(thread.latestReviewId)
      || thread.reply !== undefined && (typeof thread.reply !== 'string' || thread.reply.length > 1200)) return false;
    ids.add(thread.id); return true;
  });
}

function anchorFor(review, changeIndex, side, startLine, endLine) {
  if (!validReview(review) || !Number.isInteger(changeIndex) || !review.changes[changeIndex]) throw new Error('Choose a file or command in this review.');
  if (!['before', 'proposed', 'command'].includes(side)) throw new Error('Choose an original, proposed, or command snapshot.');
  const change = review.changes[changeIndex];
  const text = textFor(change, side);
  if (typeof text !== 'string') throw new Error('That review has no source snapshot for this selection.');
  const lines = sourceLines(text);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > lines.length || endLine - startLine >= 40) throw new Error('Select between 1 and 40 lines from the reviewed snapshot.');
  const excerpt = lines.slice(startLine - 1, endLine).join('\n');
  if (excerpt.length > 4000) throw new Error('Select a smaller section: the excerpt must fit within 4,000 characters.');
  return { reviewId: review.id, revision: review.revision, fingerprint: review.fingerprint, changeIndex, label: change.label, side, startLine, endLine,
    excerpt, snapshotHash: crypto.createHash('sha256').update(text).digest('hex') };
}

function newDraft(review, input) {
  if (!validText(input.text)) throw new Error('Write feedback of 1–1,500 characters without terminal controls.');
  if (!['ask', 'revise'].includes(input.intent)) throw new Error('Choose Ask or Request change.');
  return { id: crypto.randomUUID(), ...anchorFor(review, input.changeIndex, input.side, input.startLine, input.endLine), intent: input.intent, text: input.text.trim(), createdAt: new Date().toISOString(), status: 'draft' };
}

function isCurrentDraft(draft, review) { return !!review?.pending && sameReview(review, draft); }
function submissionFor(review, drafts, batchId = crypto.randomUUID()) {
  if (!drafts.length || drafts.length > MAX_COMMENTS) throw new Error('Send between 1 and 10 draft comments together.');
  if (!drafts.every(draft => isCurrentDraft(draft, review))) throw new Error('Some drafts belong to an older proposal. Open them in Review Desk; remove or recreate them on the current code.');
  const comments = drafts.map(({ id, changeIndex, side, startLine, endLine, intent, text }) => ({ id, changeIndex, side, startLine, endLine, intent, text }));
  const body = { reviewId: review.id, revision: review.revision, fingerprint: review.fingerprint, batchId, comments };
  if (Buffer.byteLength(JSON.stringify(body)) > 15 * 1024) throw new Error('This feedback batch is too large. Shorten the notes before sending.');
  return body;
}

function loadLocalState(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.scopes)) return { version: 1, scopes: [] };
  return { version: 1, scopes: value.scopes.slice(-12).filter(scope => typeof scope.key === 'string' && Array.isArray(scope.drafts)).map(scope => ({
    key: scope.key, drafts: scope.drafts.slice(0, 40).filter(draft => draft && draft.status === 'draft' && validId(draft.id) && validId(draft.reviewId) && validText(draft.text)
      && ['ask', 'revise'].includes(draft.intent) && ['before', 'proposed', 'command'].includes(draft.side)
      && Number.isInteger(draft.changeIndex) && draft.changeIndex >= 0 && Number.isInteger(draft.startLine) && Number.isInteger(draft.endLine) && draft.startLine >= 1 && draft.endLine >= draft.startLine && draft.endLine - draft.startLine < 40
      && typeof draft.fingerprint === 'string' && Number.isInteger(draft.revision) && draft.revision >= 1 && typeof draft.label === 'string'
      && typeof draft.excerpt === 'string' && draft.excerpt.length <= 4000 && typeof draft.snapshotHash === 'string'),
    ...(validSubmission(scope.submission) ? { submission: structuredClone(scope.submission) } : {}),
  })) };
}

function validSubmission(value) {
  if (!value || !validId(value.reviewId) || !validId(value.batchId) || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.fingerprint !== 'string'
    || !Array.isArray(value.comments) || !value.comments.length || value.comments.length > MAX_COMMENTS || Buffer.byteLength(JSON.stringify(value)) > 15 * 1024) return false;
  const ids = new Set();
  return value.comments.every(comment => {
    if (!comment || !validId(comment.id) || ids.has(comment.id) || !Number.isInteger(comment.changeIndex) || comment.changeIndex < 0 || !['before', 'proposed', 'command'].includes(comment.side)
      || !Number.isInteger(comment.startLine) || !Number.isInteger(comment.endLine) || comment.startLine < 1 || comment.endLine < comment.startLine || comment.endLine - comment.startLine >= 40
      || !['ask', 'revise'].includes(comment.intent) || !validText(comment.text)) return false;
    ids.add(comment.id); return true;
  });
}

module.exports = { MAX_COMMENTS, MAX_TEXT, validFeedback, validText, textFor, sourceLines, anchorFor, newDraft, isCurrentDraft, submissionFor, loadLocalState };
