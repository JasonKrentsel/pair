'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');

function canonicalRoot(value, platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path;
  let result = paths.resolve(value);
  if (platform === process.platform) {
    try { result = fs.realpathSync.native(result); } catch { /* New files still get a stable lexical identity. */ }
  }
  result = result.replace(/[\\/]+$/, '');
  return platform === 'win32' ? result.toLowerCase() : result;
}

function containedFile(root, label) {
  if (typeof label !== 'string' || !label || label.includes('\0')) return undefined;
  const file = path.resolve(root, label);
  const relative = path.relative(canonicalRoot(root), canonicalRoot(file));
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) ? file : undefined;
}

function registryDirectory() {
  return process.env.PI_PAIR_BRIDGE_DIR || path.join(os.homedir(), '.pi', 'agent', 'pair-bridge');
}

function validRegistry(value) {
  return value && value.version === 1 && typeof value.sessionId === 'string' && /^[\w-]{8,128}$/.test(value.sessionId)
    && typeof value.root === 'string' && path.isAbsolute(value.root) && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535
    && typeof value.token === 'string' && /^[\w-]{32,256}$/.test(value.token) && Number.isInteger(value.pid) && value.pid > 0;
}

async function discoverSessions(roots, directory = registryDirectory()) {
  const accepted = new Set(roots.map(root => canonicalRoot(root)));
  let names;
  try { names = await fs.promises.readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const sessions = [];
  for (const name of names.filter(name => name.endsWith('.json')).slice(0, 100)) {
    try {
      const filename = path.join(directory, name);
      if ((await fs.promises.stat(filename)).size > 8192) continue;
      const value = JSON.parse(await fs.promises.readFile(filename, 'utf8'));
      if (!validRegistry(value) || !accepted.has(canonicalRoot(value.root))) continue;
      try { process.kill(value.pid, 0); } catch (error) { if (error.code === 'ESRCH') continue; }
      sessions.push(value);
    } catch { /* Another process may be publishing or removing its registry entry. */ }
  }
  return sessions.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
}

function request(session, method = 'GET', route = '/review', body, etag) {
  if (!validRegistry(session)) return Promise.reject(new Error('Invalid Pair session registration.'));
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const headers = { Authorization: `Bearer ${session.token}`, Accept: 'application/json' };
    if (encoded !== undefined) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(encoded); }
    if (etag) headers['If-None-Match'] = etag;
    const req = http.request({ host: '127.0.0.1', port: session.port, path: route, method, headers }, response => {
      const chunks = [];
      let length = 0;
      response.on('data', chunk => {
        length += chunk.length;
        if (length > 64 * 1024 * 1024) { response.destroy(new Error('Pair review exceeds the 64 MiB display limit.')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        if (response.statusCode === 304) return resolve({ unchanged: true, etag: response.headers.etag });
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reject(new Error('Pair returned an invalid response.')); }
        if (response.statusCode !== 200) {
          const error = new Error(typeof data.error === 'string' ? data.error : `Pair request failed (${response.statusCode}).`);
          error.status = response.statusCode;
          return reject(error);
        }
        resolve({ data, etag: response.headers.etag });
      });
    });
    req.setTimeout(3500, () => req.destroy(new Error('Pair connection timed out.')));
    req.on('error', reject);
    req.end(encoded);
  });
}

function validReview(value) {
  return value && typeof value.id === 'string' && Number.isInteger(value.revision) && typeof value.fingerprint === 'string'
    && typeof value.title === 'string' && typeof value.why === 'string' && typeof value.status === 'string' && typeof value.pending === 'boolean'
    && Array.isArray(value.changes) && value.changes.length <= 100 && value.changes.every(change => change && typeof change.label === 'string'
      && typeof change.kind === 'string' && ['before', 'after', 'text', 'command', 'cwd', 'status', 'why'].every(key => change[key] === undefined || typeof change[key] === 'string')
      && (change.annotations === undefined || Array.isArray(change.annotations) && change.annotations.length <= 8 && change.annotations.every(note => note && typeof note.title === 'string' && typeof note.why === 'string' && Number.isInteger(note.startLine) && Number.isInteger(note.endLine) && note.startLine >= 1 && note.endLine >= note.startLine)));
}

function validMemory(value) {
  if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !Array.isArray(value.constraints) || value.constraints.length > 12) return false;
  const ids = new Set();
  for (const constraint of value.constraints) {
    if (!constraint || typeof constraint.id !== 'string' || !constraint.id || ids.has(constraint.id)
      || typeof constraint.text !== 'string' || !constraint.text.trim() || constraint.text.length > 300
      || !['task', 'turn'].includes(constraint.scope) || typeof constraint.createdAt !== 'string'
      || constraint.pendingTurn !== undefined && (typeof constraint.pendingTurn !== 'boolean' || constraint.scope !== 'turn')) return false;
    ids.add(constraint.id);
  }
  if (value.checkpoint !== undefined) {
    const checkpoint = value.checkpoint;
    if (!checkpoint || !Number.isSafeInteger(checkpoint.revision) || checkpoint.revision < 1
      || typeof checkpoint.updatedAt !== 'string' || typeof checkpoint.stale !== 'boolean') return false;
    for (const [field, limit] of Object.entries({ objective: 240, implemented: 600, verification: 600, usable: 600, deferred: 600, next: 300 })) {
      if (typeof checkpoint[field] !== 'string' || checkpoint[field].length > limit) return false;
    }
  }
  return true;
}

function identity(review) {
  return review && { reviewId: review.id, revision: review.revision, fingerprint: review.fingerprint };
}

function sameReview(review, expected) {
  return !!review && !!expected && review.id === expected.reviewId && review.revision === expected.revision && review.fingerprint === expected.fingerprint;
}

function associatedLanguage(associations, filename, root) {
  const normalized = filename.replace(/\\/g, '/');
  const relative = path.relative(root, filename).replace(/\\/g, '/');
  let best;
  for (const [pattern, language] of Object.entries(associations || {})) {
    if (typeof language !== 'string' || !language) continue;
    const normalizedPattern = pattern.replace(/\\/g, '/');
    const expression = normalizedPattern.split('**').map(part => part.split('*').map(piece => piece.split('?').map(literal => literal.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('.')).join('[^/]*')).join('.*');
    let regex;
    try { regex = new RegExp('^' + expression + '$', process.platform === 'win32' ? 'i' : ''); } catch { continue; }
    const candidates = normalizedPattern.includes('/') ? [normalized, relative] : [path.basename(filename)];
    if (!candidates.some(candidate => regex.test(candidate))) continue;
    const specificity = normalizedPattern.replace(/[?*]/g, '').length;
    if (!best || specificity >= best.specificity) best = { language, specificity };
  }
  return best?.language;
}

module.exports = { canonicalRoot, containedFile, registryDirectory, validRegistry, discoverSessions, request, validReview, validMemory, identity, sameReview, associatedLanguage };
