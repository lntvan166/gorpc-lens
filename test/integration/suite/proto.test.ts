import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { activateExtension, pathsOf, waitForActiveEditor } from './helpers';

function fixture(...p: string[]): string {
  return path.resolve(__dirname, '..', '..', '..', '..', 'test', 'fixtures', 'workspace', ...p);
}

describe('proto -> handler', () => {
  before(async () => activateExtension());

  it('jumps from the rpc line to the Go handler', async () => {
    const proto = fixture('pb', 'echo.proto');
    const doc = await vscode.workspace.openTextDocument(proto);
    await waitForActiveEditor(doc);

    let line = -1;
    for (let i = 0; i < doc.lineCount; i++) {
      if (/^\s*rpc\s+Echo\s*\(/.test(doc.lineAt(i).text)) {
        line = i;
        break;
      }
    }
    assert.ok(line >= 0, 'no rpc Echo line in the fixture proto');
    const col = doc.lineAt(line).text.indexOf('Echo');

    const locs = await vscode.commands.executeCommand<unknown[]>(
      'vscode.executeDefinitionProvider',
      doc.uri,
      new vscode.Position(line, col + 1),
    );
    const paths = pathsOf(locs ?? []);

    assert.ok(
      paths.some((p) => p.endsWith(path.join('handlersvc', 'handler.go'))),
      `expected handlersvc/handler.go, got:\n${paths.join('\n') || '(none)'}`,
    );
  });

  it('offers nothing when the cursor is not on an rpc name', async () => {
    const doc = await vscode.workspace.openTextDocument(fixture('pb', 'echo.proto'));
    await waitForActiveEditor(doc);
    const locs = await vscode.commands.executeCommand<unknown[]>(
      'vscode.executeDefinitionProvider',
      doc.uri,
      new vscode.Position(0, 2),
    );
    assert.strictEqual(pathsOf(locs ?? []).length, 0);
  });
});
