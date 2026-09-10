import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  activateExtension,
  positionOfToken,
  waitForActiveEditor,
  waitForActivePathEndingWith,
  waitForGopls,
} from './helpers';

function fixture(...parts: string[]): string {
  return path.resolve(__dirname, '..', '..', '..', '..', 'test', 'fixtures', 'workspace', ...parts);
}

async function openAt(file: string[], lineNeedle: string, token: string): Promise<vscode.Position> {
  const doc = await vscode.workspace.openTextDocument(fixture(...file));
  const editor = await waitForActiveEditor(doc);
  const pos = positionOfToken(doc, lineNeedle, token);
  editor.selection = new vscode.Selection(pos, pos);
  await waitForGopls(doc, pos);
  return pos;
}

describe('gorpcLens.goToHandler', () => {
  before(async () => activateExtension());

  it('is registered', async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes('gorpcLens.goToHandler'), 'command not registered');
  });

  it('jumps straight from a client call to the handler', async () => {
    await openAt(['callersvc', 'biz.go'], 'b.echoClient.Echo(', 'Echo(');
    await vscode.commands.executeCommand('gorpcLens.goToHandler');

    const target = path.join('handlersvc', 'handler.go');
    const landed = await waitForActivePathEndingWith(target);
    assert.ok(landed.endsWith(target), `expected to land in ${target}, landed in ${landed}`);

    const editor = vscode.window.activeTextEditor!;
    assert.ok(
      editor.document.lineAt(editor.selection.active.line).text.includes('func (h *EchoHandler) Echo('),
      'expected the cursor on the handler method declaration',
    );
  });

  it('jumps from the server interface method in the generated file too', async () => {
    await openAt(['pb', 'echo_grpc.pb.go'], 'Echo(context.Context, *EchoRequest)', 'Echo(');
    await vscode.commands.executeCommand('gorpcLens.goToHandler');

    const target = path.join('handlersvc', 'handler.go');
    const landed = await waitForActivePathEndingWith(target);
    assert.ok(landed.endsWith(target), `expected to land in ${target}, landed in ${landed}`);
  });
});
