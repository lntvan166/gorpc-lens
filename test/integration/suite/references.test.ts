import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  activateExtension,
  pathsOf,
  positionOfToken,
  waitForActiveEditor,
  waitForGopls,
} from './helpers';

function fixture(...parts: string[]): string {
  return path.resolve(__dirname, '..', '..', '..', '..', 'test', 'fixtures', 'workspace', ...parts);
}

describe('gorpc-lens reference provider', () => {
  before(async () => activateExtension());

  it('finds the cross-module caller when standing on the handler', async () => {
    const doc = await vscode.workspace.openTextDocument(fixture('handlersvc', 'handler.go'));
    const editor = await waitForActiveEditor(doc);
    const pos = positionOfToken(doc, 'func (h *EchoHandler) Echo(', 'Echo(');
    editor.selection = new vscode.Selection(pos, pos);
    await waitForGopls(doc, pos);

    const locs = await vscode.commands.executeCommand<unknown[]>(
      'vscode.executeReferenceProvider',
      doc.uri,
      pos,
    );
    const paths = pathsOf(locs ?? []);

    assert.ok(
      paths.some((p) => p.endsWith(path.join('callersvc', 'biz.go'))),
      `expected the caller in callersvc/biz.go, got:\n${paths.join('\n')}`,
    );
  });

  it('does not recurse or hang when the reference query re-enters the provider', async () => {
    const doc = await vscode.workspace.openTextDocument(fixture('handlersvc', 'handler.go'));
    const editor = await waitForActiveEditor(doc);
    const pos = positionOfToken(doc, 'func (h *EchoHandler) Echo(', 'Echo(');
    editor.selection = new vscode.Selection(pos, pos);

    const started = Date.now();
    await vscode.commands.executeCommand('vscode.executeReferenceProvider', doc.uri, pos);
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 10000, `reference query took ${elapsed}ms, suspiciously slow`);
  });

  it('registers the Find gRPC Callers command', async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes('gorpcLens.findCallers'), 'command not registered');
  });
});
