import * as vscode from 'vscode';
import { COMMAND_STAGES } from '../core/pipeline';
import { excludeSelf, keepNonGenerated } from '../core/filters';
import { Loc } from '../core/types';
import { findRpcLine, pickNearestProto } from '../core/proto';
import { Deps, toVsLocation } from './definition';

export function registerCommands(context: vscode.ExtensionContext, deps: Deps): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('gorpcLens.goToDefinition', () => goToDefinition(deps)),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('gorpcLens.goToHandler', () => goToHandler(deps)),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('gorpcLens.findCallers', () => findCallers(deps)),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('gorpcLens.goToProto', () => goToProto(deps)),
  );
}

export async function goToHandler(deps: Deps): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'go') {
    vscode.window.showWarningMessage('gorpc-lens: put the cursor on a gRPC method in a Go file.');
    return;
  }

  const pos = editor.selection.active;
  const current = { path: editor.document.uri.fsPath, line: pos.line };

  const resolved = await deps.pipeline.siteAt(
    editor.document.uri.fsPath,
    { line: pos.line, character: pos.character },
    COMMAND_STAGES,
  );
  if (!resolved) {
    vscode.window.showWarningMessage('gorpc-lens: this is not a gRPC client call or handler.');
    return;
  }

  const { site, pbPath } = resolved;
  if (!site.serverMethod) {
    vscode.window.showWarningMessage(
      `gorpc-lens: ${site.service} has no server interface in the generated file.`,
    );
    return;
  }

  const handlers = excludeSelf(await deps.resolver.handlersFor(pbPath, site.serverMethod), current);
  if (handlers.length === 0) {
    vscode.window.showWarningMessage(
      `gorpc-lens: no handler found for ${site.service}/${site.method}.`,
    );
    return;
  }

  await revealOrPeek(editor.document.uri, pos, handlers);
}

export async function revealOrPeek(
  from: vscode.Uri,
  at: vscode.Position,
  targets: Loc[],
): Promise<void> {
  if (targets.length === 1) {
    const t = targets[0];
    const target = new vscode.Position(t.line, t.character);
    await vscode.window.showTextDocument(vscode.Uri.file(t.path), {
      selection: new vscode.Range(target, target),
    });
    return;
  }
  await vscode.commands.executeCommand(
    'editor.action.peekLocations',
    from,
    at,
    targets.map(toVsLocation),
    'peek',
  );
}

export async function findCallers(deps: Deps): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'go') {
    vscode.window.showWarningMessage('gorpc-lens: put the cursor on a gRPC method in a Go file.');
    return;
  }

  const pos = editor.selection.active;
  const resolved = await deps.pipeline.siteAt(
    editor.document.uri.fsPath,
    { line: pos.line, character: pos.character },
    COMMAND_STAGES,
  );
  if (!resolved || !resolved.site.clientMethod) {
    vscode.window.showWarningMessage('gorpc-lens: this is not a gRPC client call or handler.');
    return;
  }

  const callers = await deps.resolver.callersFor(resolved.pbPath, resolved.site.clientMethod);
  if (callers.length === 0) {
    vscode.window.showWarningMessage(
      `gorpc-lens: no callers found for ${resolved.site.service}/${resolved.site.method}.`,
    );
    return;
  }

  await vscode.commands.executeCommand(
    'editor.action.showReferences',
    editor.document.uri,
    pos,
    callers.map(toVsLocation),
  );
}

export async function goToProto(deps: Deps): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'go') {
    vscode.window.showWarningMessage('gorpc-lens: put the cursor on a gRPC method in a Go file.');
    return;
  }

  const pos = editor.selection.active;
  const resolved = await deps.pipeline.siteAt(
    editor.document.uri.fsPath,
    { line: pos.line, character: pos.character },
    COMMAND_STAGES,
  );
  if (!resolved) {
    vscode.window.showWarningMessage('gorpc-lens: this is not a gRPC client call or handler.');
    return;
  }

  const source = resolved.site.protoSource;
  if (!source) {
    vscode.window.showWarningMessage(
      'gorpc-lens: the generated file has no "// source:" comment to follow.',
    );
    return;
  }

  const matches = await vscode.workspace.findFiles(`**/${source}`, '**/node_modules/**', 50);
  const nearest = pickNearestProto(
    matches.map((m) => m.fsPath),
    resolved.pbPath,
  );
  if (!nearest) {
    vscode.window.showWarningMessage(`gorpc-lens: ${source} is not in this workspace.`);
    return;
  }

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(nearest));
  const line = findRpcLine(doc.getText(), resolved.site.method);
  const at = new vscode.Position(line ?? 0, 0);
  await vscode.window.showTextDocument(doc, { selection: new vscode.Range(at, at) });

  if (line === undefined) {
    vscode.window.showWarningMessage(
      `gorpc-lens: opened ${source} but could not find "rpc ${resolved.site.method}".`,
    );
  }
}

/**
 * Go to Definition with generated files removed from the list.
 *
 * Ctrl+Click cannot be filtered - VS Code merges every provider's results and
 * offers no interception point - so this is a command you bind a key to. It
 * asks for the same merged list Ctrl+Click would show, then drops the generated
 * entries, keeping however many real targets remain.
 */
export async function goToDefinition(deps: Deps): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  const pos = editor.selection.active;
  const cfg = deps.config();

  // Deliberately unguarded: this must re-enter our own definition provider,
  // which is what contributes the handler in the first place.
  const all = await deps.lsp.definitions(editor.document.uri.fsPath, {
    line: pos.line,
    character: pos.character,
  });

  if (all.length === 0) {
    vscode.window.showWarningMessage('gorpc-lens: no definition found here.');
    return;
  }

  const kept = keepNonGenerated(
    all,
    { excludeGlobs: cfg.excludeGlobs, includeTests: cfg.includeTests },
    cfg.ignoreGeneratedFiles,
  );
  deps.log.trace('goToDefinition', `${all.length} results, ${kept.length} after filtering`);

  await revealOrPeek(editor.document.uri, pos, kept);
}
