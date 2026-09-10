import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  activateExtension, pathsOf, positionOfToken,
  waitForActiveEditor, waitForActivePathEndingWith, waitForGopls,
} from './helpers';

function fixture(...p: string[]): string {
  return path.resolve(__dirname, '..', '..', '..', '..', 'test', 'fixtures', 'workspace', ...p);
}

describe('gorpcLens.goToDefinition skips generated files', () => {
  before(async () => activateExtension());

  it('is registered', async () => {
    assert.ok((await vscode.commands.getCommands(true)).includes('gorpcLens.goToDefinition'));
  });

  it('lands on the handler, not the generated interface', async () => {
    const doc = await vscode.workspace.openTextDocument(fixture('callersvc', 'biz.go'));
    const editor = await waitForActiveEditor(doc);
    const pos = positionOfToken(doc, 'b.echoClient.Echo(', 'Echo(');
    editor.selection = new vscode.Selection(pos, pos);
    await waitForGopls(doc, pos);

    // Ctrl+Click would show both of these.
    const unfiltered = pathsOf(
      (await vscode.commands.executeCommand<unknown[]>(
        'vscode.executeDefinitionProvider', doc.uri, pos)) ?? []);
    assert.ok(unfiltered.some((p) => p.endsWith('echo_grpc.pb.go')),
      'precondition: gopls should be offering the generated file');

    await vscode.commands.executeCommand('gorpcLens.goToDefinition');

    const target = path.join('handlersvc', 'handler.go');
    const landed = await waitForActivePathEndingWith(target);
    assert.ok(landed.endsWith(target), `expected ${target}, landed on ${landed}`);
  });
});
