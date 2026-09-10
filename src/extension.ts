import * as vscode from 'vscode';
import { Logger } from './vscode/log';
import { readConfig } from './vscode/config';
import { VsCodeLspClient } from './vscode/lspClient';
import { Pipeline } from './core/pipeline';
import { Resolver } from './core/resolver';
import { Deps, GrpcDefinitionProvider } from './vscode/definition';
import { registerCommands } from './vscode/commands';
import { GrpcReferenceProvider } from './vscode/reference';
import { GrpcCodeLensProvider } from './vscode/codelens';
import { ProtoDefinitionProvider } from './vscode/protoDefinition';

const GO: vscode.DocumentSelector = { language: 'go', scheme: 'file' };

// Matched by glob, not language id: .proto files are plain text unless the user
// happens to have a protobuf extension installed.
const PROTO: vscode.DocumentSelector = { pattern: '**/*.proto', scheme: 'file' };

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

  const deps: Deps = { lsp, pipeline, resolver, config: readConfig, log };

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(GO, new GrpcDefinitionProvider(deps)),
  );
  context.subscriptions.push(
    vscode.languages.registerReferenceProvider(GO, new GrpcReferenceProvider(deps)),
  );
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(GO, new GrpcCodeLensProvider(deps)),
  );
  const protoProvider = new ProtoDefinitionProvider(deps);
  context.subscriptions.push(vscode.languages.registerDefinitionProvider(PROTO, protoProvider));


  registerCommands(context, deps);

  // A saved Go file can move a handler or add a new one; drop both caches.
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId === 'go') {
        pipeline.invalidate();
        resolver.clearCache();
        protoProvider.invalidate();
        log.trace('cache', `invalidated after saving ${doc.uri.fsPath}`);
      }
    }),
  );
}

export function deactivate(): void {
  logger?.dispose();
  logger = undefined;
}
