import * as vscode from 'vscode';
import { COMMAND_STAGES } from '../core/pipeline';
import { excludeSelf } from '../core/filters';
import { Loc } from '../core/types';
import { Deps, toVsLocation } from './definition';

export function registerCommands(context: vscode.ExtensionContext, deps: Deps): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('gorpcLens.goToHandler', () => goToHandler(deps)),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('gorpcLens.findCallers', () => findCallers(deps)),
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
