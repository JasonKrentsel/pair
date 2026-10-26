'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { diffLines } = require('./media/vendor/diff.cjs');

const SCHEME = 'pair-revision';
const THREE_COLUMNS = { orientation: 0, groups: [{ size: 1 / 3 }, { size: 1 / 3 }, { size: 1 / 3 }] };
const MAX_DISK_BYTES = 2 * 1024 * 1024;

/**
 * Three immutable, native source editors. No merge markers, private merge API,
 * project writes, or changes to the user's persistent editor configuration.
 */
function createRevisionComparison(vscode, context) {
  const snapshots = new Map();
  let previousLayout;
  let sequence = 0;
  let opening = Promise.resolve();
  const lensesChanged = new vscode.EventEmitter();
  const added = vscode.window.createTextEditorDecorationType({
    isWholeLine: true, backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorGutter.addedBackground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  const removed = vscode.window.createTextEditorDecorationType({
    isWholeLine: true, backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorGutter.deletedBackground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  const revised = vscode.window.createTextEditorDecorationType({
    isWholeLine: true, borderWidth: '0 0 0 2px', borderStyle: 'solid',
    borderColor: new vscode.ThemeColor('editorGutter.modifiedBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorGutter.modifiedBackground'),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  context.subscriptions.push(added, removed, revised, lensesChanged);

  const documentKey = document => document.uri.toString();
  const snapshotFor = document => snapshots.get(documentKey(document));
  const range = (document, start, count) => {
    const first = Math.max(0, Math.min(document.lineCount - 1, start));
    const last = Math.max(first, Math.min(document.lineCount - 1, start + Math.max(1, count) - 1));
    return new vscode.Range(first, 0, last, Number.MAX_SAFE_INTEGER);
  };

  function decorate(editor) {
    const snapshot = snapshotFor(editor.document);
    if (!snapshot) return;
    // A foreign edit to a virtual document must not receive trusted diff marks.
    const unchanged = editor.document.getText() === snapshot.content;
    for (const [type, spans] of [[added, snapshot.added], [removed, snapshot.removed], [revised, snapshot.revised]]) {
      editor.setDecorations(type, unchanged ? spans.map(span => range(editor.document, span.start, span.count)) : []);
    }
  }

  function prune() {
    if (snapshots.size <= 48) return;
    const open = new Set(vscode.workspace.textDocuments.map(documentKey));
    for (const key of snapshots.keys()) {
      if (snapshots.size <= 48) break;
      if (open.has(key)) continue;
      snapshots.delete(key);
    }
  }

  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
    provideTextDocumentContent(uri) {
      const snapshot = snapshots.get(uri.toString());
      if (!snapshot) throw new Error('This comparison snapshot is no longer available. Compare the current revision again.');
      return snapshot.content;
    },
  }));
  context.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: SCHEME }, {
    onDidChangeCodeLenses: lensesChanged.event,
    provideCodeLenses(document) {
      const snapshot = snapshotFor(document);
      if (!snapshot) return [];
      const position = new vscode.Range(0, 0, 0, 0);
      const lenses = [new vscode.CodeLens(position, {
        title: snapshot.caption, command: 'pair.revisionComparisonInfo', arguments: [snapshot.comparisonId, snapshot.role],
        tooltip: snapshot.description,
      })];
      if (snapshot.role === 'current' && previousLayout) lenses.push(new vscode.CodeLens(position, {
        title: 'Restore editor layout', command: 'pair.restoreRevisionLayout', tooltip: 'Restore the previous grid without closing any tabs.',
      }));
      return lenses;
    },
  }));
  context.subscriptions.push(vscode.commands.registerCommand('pair.revisionComparisonInfo', (id, role) => {
    const snapshot = [...snapshots.values()].find(value => value.comparisonId === id && value.role === role);
    if (snapshot) return vscode.window.showInformationMessage(snapshot.description);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('pair.restoreRevisionLayout', async () => {
    if (!previousLayout) return;
    sequence++;
    const layout = previousLayout;
    await vscode.commands.executeCommand('vscode.setEditorLayout', layout);
    previousLayout = undefined;
    lensesChanged.fire();
  }));
  context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(editors => editors.forEach(decorate)));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
    if (event.document.uri.scheme === SCHEME) (vscode.window.visibleTextEditors || []).filter(editor => editor.document === event.document).forEach(decorate);
  }));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(prune));
  context.subscriptions.push({ dispose() { sequence++; snapshots.clear(); } });

  function snapshot(spec, role, title, content, metadata) {
    const filename = `${title} · ${path.posix.basename(spec.label.replace(/\\/g, '/'))}`;
    const uri = vscode.Uri.from({ scheme: SCHEME, authority: spec.sessionId, path: `/${spec.comparisonId}/${filename}` });
    snapshots.set(uri.toString(), { comparisonId: spec.comparisonId, role, content, added: [], removed: [], revised: [], ...metadata });
    return uri;
  }

  async function readDisk(uri) {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if ((stat.type & vscode.FileType.File) !== vscode.FileType.File) throw new Error('The current path is not a regular file.');
      if (stat.size > MAX_DISK_BYTES) throw new Error('The current file is too large for a focused revision comparison (2 MiB limit).');
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.byteLength > MAX_DISK_BYTES) throw new Error('The current file grew beyond the comparison limit. Compare it again after saving.');
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (content.includes('\0')) throw new Error('The current file is binary and cannot be compared as source.');
      return { content, missing: false };
    } catch (error) {
      if (error?.code === 'FileNotFound' || error?.code === 'ENOENT') return { content: '', missing: true };
      throw error;
    }
  }

  async function show(spec, currentSequence) {
    const isCurrent = () => currentSequence === sequence && spec.isCurrent();
    if (!isCurrent()) return;
    const diskUri = vscode.Uri.file(spec.file);
    const disk = await readDisk(diskUri);
    if (!isCurrent()) return;
    const dirty = vscode.workspace.textDocuments.some(document => document.uri.scheme === 'file'
      && document.isDirty && spec.isSameFile(document.uri.fsPath));
    const id = crypto.randomUUID();
    const full = { ...spec, comparisonId: id };
    const diskDelta = changedLines(disk.content, spec.original);
    const revisionDelta = changedLines(spec.original, spec.revised);
    const changedOnDisk = typeof spec.baseline === 'string' && disk.content !== spec.baseline;
    const currentTitle = disk.missing ? 'Current file (not on disk)' : dirty ? 'Current file (disk; unsaved buffer)' : 'Current file (disk)';
    const currentDescription = disk.missing ? 'This file does not currently exist on disk. The current snapshot is empty.'
      : `Read-only disk snapshot captured for this comparison.${dirty ? ' Unsaved editor changes are not included; save or discard them before adopting a revision.' : ''}${changedOnDisk ? ' The disk content changed after the original proposal was prepared; adoption must revalidate it.' : ''}`;
    const currentUri = snapshot(full, 'current', currentTitle, disk.content, {
      caption: `${currentTitle} · Read-only snapshot`, description: currentDescription, removed: diskDelta?.old || [],
    });
    const originalUri = snapshot(full, 'original', 'Original proposal', spec.original, {
      caption: `Original proposal${diskDelta ? ` · +${diskDelta.added} −${diskDelta.removed} from disk` : ' · Line highlighting unavailable for this comparison'}`,
      description: 'The exact original proposal before this follow-up revision. Green lines differ from disk; blue markers identify lines changed again by the revision.',
      added: diskDelta?.next || [], revised: revisionDelta?.old || [],
    });
    const revisedUri = snapshot(full, 'revised', 'Revised proposal', spec.revised, {
      caption: `Revised proposal${revisionDelta ? ` · +${revisionDelta.added} −${revisionDelta.removed} from original` : ' · Line highlighting unavailable for this comparison'}`,
      description: 'The suggested replacement after the follow-up chat. Highlighted lines differ from the original proposal. Nothing has been applied; using this revision still requires step approval.',
      added: revisionDelta?.next || [], revised: revisionDelta?.next || [],
    });
    const docs = [];
    for (const uri of [currentUri, originalUri, revisedUri]) {
      let document = await vscode.workspace.openTextDocument(uri);
      if (spec.language && document.languageId !== spec.language) document = await vscode.languages.setTextDocumentLanguage(document, spec.language);
      docs.push(document);
    }
    if (!isCurrent()) return;
    if (!previousLayout) previousLayout = await vscode.commands.executeCommand('vscode.getEditorLayout');
    if (!isCurrent()) return;
    await vscode.commands.executeCommand('vscode.setEditorLayout', THREE_COLUMNS);
    if (!isCurrent()) return;
    for (const [index, document] of docs.entries()) {
      if (!isCurrent()) return;
      const editor = await vscode.window.showTextDocument(document, {
        viewColumn: [vscode.ViewColumn.One, vscode.ViewColumn.Two, vscode.ViewColumn.Three][index],
        preview: true, preserveFocus: true,
      });
      decorate(editor);
      const spans = index === 0 ? diskDelta?.old : index === 1 ? revisionDelta?.old || diskDelta?.next : revisionDelta?.next;
      if (spans?.length) editor.revealRange(range(document, spans[0].start, 1), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
    lensesChanged.fire();
    prune();
  }

  return {
    open(spec) {
      const currentSequence = ++sequence;
      const result = opening.catch(() => {}).then(() => show(spec, currentSequence));
      opening = result;
      return result;
    },
  };
}

function changedLines(before, after) {
  // The established jsdiff line algorithm provides exact spans. Bound work on
  // unusually divergent files instead of approximating or blocking the host.
  const changes = diffLines(before, after, { timeout: 100, maxEditLength: 20000, stripTrailingCr: true });
  if (!changes) return;
  const result = { old: [], next: [], added: 0, removed: 0 };
  let old = 0, next = 0;
  for (const part of changes) {
    const count = part.count || 0;
    if (part.added) { result.next.push({ start: next, count }); result.added += count; next += count; }
    else if (part.removed) { result.old.push({ start: old, count }); result.removed += count; old += count; }
    else { old += count; next += count; }
  }
  return result;
}

module.exports = { createRevisionComparison };
