import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { activateExtension, waitForActiveEditor, waitForGopls, positionOfToken } from './helpers';

function fixture(...parts: string[]): string {
  return path.resolve(__dirname, '..', '..', '..', '..', 'test', 'fixtures', 'workspace', ...parts);
}

describe('gorpc-lens CodeLens', () => {
  before(async () => activateExtension());

  afterEach(async () => {
    await vscode.workspace
      .getConfiguration('gorpcLens')
      .update('codeLens.handlers', undefined, vscode.ConfigurationTarget.Global);
  });

  it('shows nothing while the setting is off', async () => {
    const doc = await vscode.workspace.openTextDocument(fixture('handlersvc', 'handler.go'));
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      'vscode.executeCodeLensProvider',
      doc.uri,
      10,
    );
    const titles = (lenses ?? []).map((l) => l.command?.title).filter((t) => t);
    assert.deepStrictEqual(titles, [], `expected no gorpc-lens titles, got ${titles.join(', ')}`);
  });

  it('counts the cross-module caller once enabled', async () => {
    await vscode.workspace
      .getConfiguration('gorpcLens')
      .update('codeLens.handlers', true, vscode.ConfigurationTarget.Global);

    const doc = await vscode.workspace.openTextDocument(fixture('handlersvc', 'handler.go'));
    await waitForActiveEditor(doc);
    await waitForGopls(doc, positionOfToken(doc, 'func (h *EchoHandler) Echo(', 'Echo('));

    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      'vscode.executeCodeLensProvider',
      doc.uri,
      10,
    );
    const titles = (lenses ?? []).map((l) => l.command?.title).filter((t): t is string => !!t);
    assert.ok(
      titles.includes('1 caller in 1 service'),
      `expected a caller count, got: ${JSON.stringify(titles)}`,
    );
  });
});
