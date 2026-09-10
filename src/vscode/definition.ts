import * as vscode from 'vscode';
import { PROVIDER_STAGES, Pipeline } from '../core/pipeline';
import { Resolver } from '../core/resolver';
import { Loc, Logger, LspClient } from '../core/types';
import { GorpcConfig } from './config';
import { guardKey, withGuard } from './guard';

export interface Deps {
  lsp: LspClient;
  pipeline: Pipeline;
  resolver: Resolver;
  config: () => GorpcConfig;
  log: Logger;
}

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/;

/**
 * Reject everything that cannot be a gRPC method call before spending an LSP
 * round trip: gRPC methods are exported, and we only care about call sites and
 * interface method declarations, both of which are followed by an open paren.
 */
export function isCandidateToken(doc: vscode.TextDocument, pos: vscode.Position): boolean {
  const range = doc.getWordRangeAtPosition(pos, IDENTIFIER);
  if (!range) {
    return false;
  }
  const word = doc.getText(range);
  if (!/^[A-Z]/.test(word)) {
    return false;
  }
  const rest = doc.getText(new vscode.Range(range.end, doc.lineAt(range.end.line).range.end));
  return /^\s*\(/.test(rest);
}

export function toVsLocation(loc: Loc): vscode.Location {
  return new vscode.Location(
    vscode.Uri.file(loc.path),
    new vscode.Position(loc.line, loc.character),
  );
}

export class GrpcDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly deps: Deps) {}

  async provideDefinition(
    doc: vscode.TextDocument,
    pos: vscode.Position,
  ): Promise<vscode.Location[] | undefined> {
    if (!this.deps.config().enabled || doc.languageId !== 'go') {
      return undefined;
    }
    if (!isCandidateToken(doc, pos)) {
      return undefined;
    }

    return withGuard(
      guardKey(doc.uri.toString(), pos),
      async () => {
        try {
          const resolved = await this.deps.pipeline.siteAt(
            doc.uri.fsPath,
            { line: pos.line, character: pos.character },
            PROVIDER_STAGES,
          );
          const serverMethod = resolved?.site.serverMethod;
          if (!resolved || !serverMethod) {
            return undefined;
          }
          const handlers = await this.deps.resolver.handlersFor(resolved.pbPath, serverMethod);
          return handlers.length ? handlers.map(toVsLocation) : undefined;
        } catch (err) {
          this.deps.log.error('definition', err);
          return undefined;
        }
      },
      undefined,
    );
  }
}
