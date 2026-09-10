import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { pathsOf, positionOfToken, waitForGopls } from './helpers';

function fixture(...parts: string[]): string {
  return path.resolve(__dirname, '..', '..', '..', '..', 'test', 'fixtures', 'workspace', ...parts);
}

describe('gorpc-lens definition provider', () => {
  it('offers the cross-module handler for a gRPC client call', async () => {
    const doc = await vscode.workspace.openTextDocument(fixture('callersvc', 'biz.go'));
    await vscode.window.showTextDocument(doc);

    const pos = positionOfToken(doc, 'b.echoClient.Echo(', 'Echo(');
    await waitForGopls(doc, pos);

    const locs = await vscode.commands.executeCommand<unknown[]>(
      'vscode.executeDefinitionProvider',
      doc.uri,
      pos,
    );
    const paths = pathsOf(locs ?? []);

    assert.ok(
      paths.some((p) => p.endsWith(path.join('handlersvc', 'handler.go'))),
      `expected a handler.go result, got:\n${paths.join('\n')}`,
    );
  });

  it('still offers the generated interface, so the user gets a choice', async () => {
    const doc = await vscode.workspace.openTextDocument(fixture('callersvc', 'biz.go'));
    await vscode.window.showTextDocument(doc);

    const pos = positionOfToken(doc, 'b.echoClient.Echo(', 'Echo(');
    await waitForGopls(doc, pos);

    const locs = await vscode.commands.executeCommand<unknown[]>(
      'vscode.executeDefinitionProvider',
      doc.uri,
      pos,
    );
    const paths = pathsOf(locs ?? []);

    assert.ok(
      paths.some((p) => p.endsWith('echo_grpc.pb.go')),
      `expected the generated interface among the results, got:\n${paths.join('\n')}`,
    );
  });
});
