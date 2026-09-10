import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

const reference = process.env.GORPC_reference ?? '<monorepo>';

const BIZ = path.join(reference, 'order-biz', 'manager', 'biz', 'order.go');
const HANDLER = path.join(reference, 'order-svc', 'manager', 'handler', 'order.go');
const PB = path.join(reference, 'protos', 'order-svc', 'order_service_grpc.pb.go');
const PROTO = path.join(reference, 'protos', 'order-svc', 'order_service.proto');

function pathsOf(locs: unknown[]): string[] {
  return (locs as Array<Record<string, { fsPath?: string }>>)
    .map((l) => (l.targetUri ?? l.uri)?.fsPath)
    .filter((p): p is string => typeof p === 'string');
}

/** Position of `token` on the first line containing `needle`. */
function findPos(doc: vscode.TextDocument, needle: string, token: string): vscode.Position {
  for (let i = 0; i < doc.lineCount; i++) {
    const text = doc.lineAt(i).text;
    if (!text.includes(needle)) {
      continue;
    }
    const col = text.indexOf(token);
    assert.ok(col >= 0, `token ${token} not on the line containing ${needle}`);
    return new vscode.Position(i, col + 1);
  }
  throw new Error(`no line containing ${needle} in ${doc.uri.fsPath}`);
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

/** gopls needs to index ~50 modules; poll until it answers. */
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
  throw new Error('gopls never answered');
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

describe('gorpc-lens against the real reference workspace', () => {
  before(async () => {
    const ext = vscode.extensions.getExtension('local.gorpc-lens');
    assert.ok(ext, 'extension not found');
    await ext.activate();

    // Warm gopls once, on the file every later check depends on.
    const doc = await vscode.workspace.openTextDocument(BIZ);
    const pos = findPos(doc, 'b.orderClient.ListOrders(', 'ListOrders(');
    await waitForGopls(doc.uri, pos);
  });

  it('1. Ctrl+Click on the client call offers both the interface and the handler', async () => {
    const pos = await openAt(BIZ, 'b.orderClient.ListOrders(', 'ListOrders(');
    const locs = await vscode.commands.executeCommand<unknown[]>(
      'vscode.executeDefinitionProvider',
      vscode.Uri.file(BIZ),
      pos,
    );
    const paths = pathsOf(locs ?? []);
    console.log('RESULT definition ->', JSON.stringify(paths, null, 2));

    assert.ok(paths.some((p) => p === PB), `expected the generated interface, got ${paths}`);
    assert.ok(paths.some((p) => p === HANDLER), `expected the handler, got ${paths}`);
  });

  it('2. Ctrl+Alt+H jumps straight to the handler', async () => {
    await openAt(BIZ, 'b.orderClient.ListOrders(', 'ListOrders(');
    await vscode.commands.executeCommand('gorpcLens.goToHandler');

    const landed = await waitForActivePathEndingWith(path.join('handler', 'order.go'));
    const editor = vscode.window.activeTextEditor!;
    const line = editor.document.lineAt(editor.selection.active.line).text;
    console.log('RESULT goToHandler ->', landed, '| line:', line.trim());

    assert.strictEqual(landed, HANDLER);
    assert.ok(line.includes('ListOrders'), `cursor sits on: ${line}`);
  });

  it('3. Find gRPC Callers lists callers across services', async () => {
    const pos = await openAt(HANDLER, ') ListOrders(ctx context.Context', 'ListOrders(');
    const locs = await vscode.commands.executeCommand<unknown[]>(
      'vscode.executeReferenceProvider',
      vscode.Uri.file(HANDLER),
      pos,
    );
    const paths = pathsOf(locs ?? []);
    const services = [
      ...new Set(
        paths
          .filter((p) => p.startsWith(reference + path.sep))
          .map((p) => p.slice(reference.length + 1).split(path.sep)[0]),
      ),
    ].sort();
    console.log('RESULT callers ->', paths.length, 'refs across', JSON.stringify(services));

    for (const expected of ['billing-svc', 'integration-svc', 'mobile-biz']) {
      assert.ok(services.includes(expected), `expected a caller in ${expected}, saw ${services}`);
    }
  });

  it('4. Go to Proto Definition lands on the rpc line', async () => {
    await openAt(BIZ, 'b.orderClient.ListOrders(', 'ListOrders(');
    await vscode.commands.executeCommand('gorpcLens.goToProto');

    const landed = await waitForActivePathEndingWith('order_service.proto');
    const editor = vscode.window.activeTextEditor!;
    const lineNo = editor.selection.active.line;
    const line = editor.document.lineAt(lineNo).text;
    console.log('RESULT goToProto ->', landed, '| line', lineNo + 1, ':', line.trim());

    assert.strictEqual(landed, PROTO);
    assert.ok(/^\s*rpc\s+ListOrders\s*\(/.test(line), `cursor sits on: ${line}`);
  });

  it('5. warm gopls implementation latency', async () => {
    const doc = await vscode.workspace.openTextDocument(PB);
    const pos = findPos(doc, 'ListOrders(context.Context, *ListOrdersRequest)', 'ListOrders(');
    console.log('measuring at', path.basename(PB), 'line', pos.line + 1, 'col', pos.character + 1);

    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t0 = Date.now();
      await vscode.commands.executeCommand('vscode.executeImplementationProvider', doc.uri, pos);
      samples.push(Date.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p50 = samples[5];
    const p95 = samples[9];
    console.log('RESULT latency -> samples', JSON.stringify(samples));
    console.log(`RESULT latency -> p50=${p50}ms p95=${p95}ms min=${samples[0]}ms max=${samples[9]}ms`);
  });
});
