import * as vscode from 'vscode';
import { REFERENCE_STAGES } from '../core/pipeline';
import { Deps, isCandidateToken, toVsLocation } from './definition';
import { guardKey, withGuard } from './guard';

export class GrpcReferenceProvider implements vscode.ReferenceProvider {
  constructor(private readonly deps: Deps) {}

  async provideReferences(
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
            REFERENCE_STAGES,
          );
          const clientMethod = resolved?.site.clientMethod;
          if (!resolved || !clientMethod) {
            return undefined;
          }

          // Hold the generated position too: resolving callers runs a
          // reference query there, which would otherwise re-enter this
          // provider and repeat the whole search one level down.
          const pbKey = guardKey(vscode.Uri.file(resolved.pbPath).toString(), clientMethod);
          const callers = await withGuard(
            pbKey,
            () => this.deps.resolver.callersFor(resolved.pbPath, clientMethod),
            [],
          );
          return callers.length ? callers.map(toVsLocation) : undefined;
        } catch (err) {
          this.deps.log.error('references', err);
          return undefined;
        }
      },
      undefined,
    );
  }
}
