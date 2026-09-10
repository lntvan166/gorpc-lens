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
