import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

interface Anchor {
  file: string;
  line: string;
  token: string;
}

interface GeneratedAnchor {
  file: string;
  serverLine: string;
  token: string;
}

interface VerifyConfig {
  workspace: string;
  caller: Anchor;
  handler: Anchor;
  generated: GeneratedAnchor;
  proto: { file: string; rpc: string };
  expectCallerModules: string[];
}

const config: VerifyConfig = JSON.parse(
  fs.readFileSync(process.env.GORPC_VERIFY_CONFIG!, 'utf8'),
);

const abs = (rel: string): string => path.resolve(config.workspace, rel);

function pathsOf(locs: unknown[]): string[] {
  return (locs as Array<Record<string, { fsPath?: string }>>)
    .map((l) => (l.targetUri ?? l.uri)?.fsPath)
    .filter((p): p is string => typeof p === 'string');
}

function findPos(doc: vscode.TextDocument, needle: string, token: string): vscode.Position {
  for (let i = 0; i < doc.lineCount; i++) {
    const text = doc.lineAt(i).text;
    if (!text.includes(needle)) {
      continue;
    }
    const col = text.indexOf(token);
    assert.ok(col >= 0, `token "${token}" not on the line containing "${needle}"`);
    return new vscode.Position(i, col + 1);
  }
  throw new Error(`no line containing "${needle}" in ${doc.uri.fsPath}`);
}

async function openAt(file: string, needle: string, token: string): Promise<vscode.Position> {
  const doc = await vscode.workspace.openTextDocument(file);
  const deadline = Date.now() + 30000;
  let editor = await vscode.window.showTextDocument(doc, { preview: false });
  while (vscode.window.activeTextEditor?.document.uri.fsPath !== doc.uri.fsPath) {
    if (Date.now() > deadline) {
      throw new Error(`editor for ${file} never became active`);
    }
    await new Promise((r) => setTimeout(r, 100));
    editor = await vscode.window.showTextDocument(doc, { preview: false });
  }
  const pos = findPos(doc, needle, token);
  editor.selection = new vscode.Selection(pos, pos);
  return pos;
}

/** A large workspace can take minutes to index; poll rather than assume. */
async function waitForGopls(uri: vscode.Uri, pos: vscode.Position): Promise<void> {
  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) {
    const locs = await vscode.commands.executeCommand<unknown[]>(
      'vscode.executeDefinitionProvider',
      uri,
      pos,
    );
    if (locs && locs.length > 0) {
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('gopls never answered a definition request');
}

async function waitForActivePathEndingWith(suffix: string, timeoutMs = 30000): Promise<string> {
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

describe('gorpc-lens against a real workspace', () => {
  before(async () => {
    const ext = vscode.extensions.getExtension('lntvan166.gorpc-lens');
    assert.ok(ext, 'gorpc-lens not found in the test host');
    await ext.activate();

    const doc = await vscode.workspace.openTextDocument(abs(config.caller.file));
    await waitForGopls(doc.uri, findPos(doc, config.caller.line, config.caller.token));
  });

  it('1. go-to-definition offers both the generated interface and the handler', async () => {
    const pos = await openAt(abs(config.caller.file), config.caller.line, config.caller.token);
    const locs = await vscode.commands.executeCommand<unknown[]>(
      'vscode.executeDefinitionProvider',
      vscode.Uri.file(abs(config.caller.file)),
      pos,
    );
    const paths = pathsOf(locs ?? []);

    assert.ok(
      paths.includes(abs(config.generated.file)),
      `expected the generated interface, got:\n${paths.join('\n')}`,
    );
    assert.ok(
      paths.includes(abs(config.handler.file)),
      `expected the handler, got:\n${paths.join('\n')}`,
    );
  });

  it('2. Go to gRPC Handler jumps straight to the handler', async () => {
    await openAt(abs(config.caller.file), config.caller.line, config.caller.token);
    await vscode.commands.executeCommand('gorpcLens.goToHandler');

    const landed = await waitForActivePathEndingWith(path.basename(config.handler.file));
    assert.strictEqual(landed, abs(config.handler.file));
  });

  it('3. references list callers across modules', async () => {
    const pos = await openAt(abs(config.handler.file), config.handler.line, config.handler.token);
    const locs = await vscode.commands.executeCommand<unknown[]>(
      'vscode.executeReferenceProvider',
      vscode.Uri.file(abs(config.handler.file)),
      pos,
    );
    const modules = [
      ...new Set(
        pathsOf(locs ?? [])
          .filter((p) => p.startsWith(config.workspace + path.sep))
          .map((p) => p.slice(config.workspace.length + 1).split(path.sep)[0]),
      ),
    ].sort();
    console.log(`callers span ${modules.length} modules: ${JSON.stringify(modules)}`);

    for (const expected of config.expectCallerModules) {
      assert.ok(modules.includes(expected), `expected a caller in ${expected}, saw ${modules}`);
    }
  });

  it('4. Go to Proto Definition lands on the rpc line', async () => {
    await openAt(abs(config.caller.file), config.caller.line, config.caller.token);
    await vscode.commands.executeCommand('gorpcLens.goToProto');

    const landed = await waitForActivePathEndingWith(path.basename(config.proto.file));
    assert.strictEqual(
      landed,
      abs(config.proto.file),
      'landed on the wrong copy of the proto (a nested worktree?)',
    );

    const editor = vscode.window.activeTextEditor!;
    const line = editor.document.lineAt(editor.selection.active.line).text;
    assert.ok(
      new RegExp(`^\\s*rpc\\s+${config.proto.rpc}\\s*\\(`).test(line),
      `cursor sits on: ${line}`,
    );
  });

  it('5. reports warm gopls implementation latency', async () => {
    const doc = await vscode.workspace.openTextDocument(abs(config.generated.file));
    const pos = findPos(doc, config.generated.serverLine, config.generated.token);

    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t0 = Date.now();
      await vscode.commands.executeCommand('vscode.executeImplementationProvider', doc.uri, pos);
      samples.push(Date.now() - t0);
    }
    samples.sort((a, b) => a - b);
    console.log(`implementation latency (ms): ${samples.join(' ')}`);
    console.log(`p50=${samples[5]}ms p95=${samples[9]}ms`);
  });
});
