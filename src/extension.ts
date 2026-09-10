import * as vscode from 'vscode';
import { Logger } from './vscode/log';
import { readConfig } from './vscode/config';
import { VsCodeLspClient } from './vscode/lspClient';
import { Pipeline } from './core/pipeline';
import { Resolver } from './core/resolver';
import { Deps, GrpcDefinitionProvider } from './vscode/definition';
import { registerCommands } from './vscode/commands';
import { GrpcReferenceProvider } from './vscode/reference';

const GO: vscode.DocumentSelector = { language: 'go', scheme: 'file' };

let logger: Logger | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const log = new Logger(() => readConfig().trace);
  logger = log;
  context.subscriptions.push(log);

  const lsp = new VsCodeLspClient();
  const pipeline = new Pipeline(lsp, log);
  const resolver = new Resolver(
    lsp,
    () => {
      const c = readConfig();
      return {
        excludeGlobs: c.excludeGlobs,
        includeTests: c.includeTests,
        timeoutMs: c.timeoutMs,
      };
    },
    log,
  );

  const deps: Deps = { pipeline, resolver, config: readConfig, log };

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(GO, new GrpcDefinitionProvider(deps)),
  );
  context.subscriptions.push(
    vscode.languages.registerReferenceProvider(GO, new GrpcReferenceProvider(deps)),
  );

  registerCommands(context, deps);

  // A saved Go file can move a handler or add a new one; drop both caches.
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId === 'go') {
        pipeline.invalidate();
        resolver.clearCache();
        log.trace('cache', `invalidated after saving ${doc.uri.fsPath}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('gorpcLens.measureLatency', () => measureLatency(log)),
  );
}

export function deactivate(): void {
  logger?.dispose();
  logger = undefined;
}

const SAMPLE_COUNT = 10;

async function measureLatency(log: Logger): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('gorpc-lens: no active editor.');
    return;
  }

  const uri = editor.document.uri;
  const pos = editor.selection.active;
  const samples: number[] = [];

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'gorpc-lens: measuring gopls latency' },
    async () => {
      for (let i = 0; i < SAMPLE_COUNT; i++) {
        const t0 = Date.now();
        const raw = await vscode.commands.executeCommand<unknown[]>(
          'vscode.executeImplementationProvider',
          uri,
          pos,
        );
        const elapsed = Date.now() - t0;
        samples.push(elapsed);
        log.error('measure', `sample ${i + 1}: ${elapsed}ms, ${raw?.length ?? 0} results`);
      }
    },
  );

  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length * 0.5)];
  const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))];
  const summary = `p50=${p50}ms p95=${p95}ms min=${samples[0]}ms max=${samples[samples.length - 1]}ms`;

  log.error('measure', summary);
  log.show();
  vscode.window.showInformationMessage(`gorpc-lens latency: ${summary}`);
}
