import * as assert from 'assert';
import * as vscode from 'vscode';

export function positionOfToken(
  doc: vscode.TextDocument,
  lineNeedle: string,
  token: string,
): vscode.Position {
  for (let i = 0; i < doc.lineCount; i++) {
    const text = doc.lineAt(i).text;
    if (!text.includes(lineNeedle)) {
      continue;
    }
    const col = text.indexOf(token);
    assert.ok(col >= 0, `token "${token}" not on the line containing "${lineNeedle}"`);
    return new vscode.Position(i, col + 1);
  }
  throw new Error(`no line containing "${lineNeedle}"`);
}

/**
 * gopls indexes the workspace asynchronously. Poll a plain definition request
 * until it answers, so tests measure gorpc-lens rather than startup.
 */
export async function waitForGopls(
  doc: vscode.TextDocument,
  pos: vscode.Position,
  timeoutMs = 150000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const locs = await vscode.commands.executeCommand<unknown[]>(
      'vscode.executeDefinitionProvider',
      doc.uri,
      pos,
    );
    if (locs && locs.length > 0) {
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('gopls did not answer a definition request in time');
}

export function pathsOf(locs: unknown[]): string[] {
  return (locs as Array<Record<string, { fsPath?: string }>>)
    .map((l) => (l.targetUri ?? l.uri)?.fsPath)
    .filter((p): p is string => typeof p === 'string');
}

/** Activate gorpc-lens explicitly, so tests do not depend on whether some
 *  earlier test happened to open a Go file and trigger onLanguage:go. */
export async function activateExtension(): Promise<void> {
  const ext = vscode.extensions.getExtension('lntvan166.gorpc-lens');
  assert.ok(ext, 'gorpc-lens extension not found in the test host');
  await ext.activate();
}

/** The first showTextDocument after the test host launches can resolve before
 *  the editor is actually active, so poll until it really is. */
export async function waitForActiveEditor(
  doc: vscode.TextDocument,
  timeoutMs = 20000,
): Promise<vscode.TextEditor> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.fsPath === doc.uri.fsPath) {
      return editor;
    }
    await vscode.window.showTextDocument(doc, { preview: false });
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`editor for ${doc.uri.fsPath} never became active`);
}

/** Poll until the active editor is a file whose path ends with `suffix`.
 *  Returns the last path actually seen, so a genuine navigation failure still
 *  reports something legible rather than an empty string. */
export async function waitForActivePathEndingWith(
  suffix: string,
  timeoutMs = 15000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let seen = '<no active editor>';
  while (Date.now() < deadline) {
    const p = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (p) {
      seen = p;
      if (p.endsWith(suffix)) {
        return p;
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return seen;
}
