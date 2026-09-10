import * as vscode from 'vscode';
import { REFERENCE_STAGES } from '../core/pipeline';
import { describeCallers } from '../core/summary';
import { findHandlerMethod } from '../core/goDecl';
import { Deps } from './definition';
import { guardKey, withGuard } from './guard';

/** Carries the file it was created for, because `resolveCodeLens` gets no
 *  document. The subclass survives normal editor-driven resolution but not a
 *  round trip through the `executeCodeLensProvider` command, which
 *  reconstructs the lens — hence the fallback chain in `documentFor`. */
class HandlerLens extends vscode.CodeLens {
  constructor(
    range: vscode.Range,
    readonly path: string,
  ) {
    super(range);
  }
}

export class GrpcCodeLensProvider implements vscode.CodeLensProvider {
  private lastProvidedPath: string | undefined;

  constructor(private readonly deps: Deps) {}

  /** Which file a lens belongs to: its own record first, then the active Go
   *  editor, then the file we most recently provided lenses for. */
  private documentFor(lens: vscode.CodeLens): string | undefined {
    if (lens instanceof HandlerLens) {
      return lens.path;
    }
    const active = vscode.window.activeTextEditor?.document;
    if (active?.languageId === 'go') {
      return active.uri.fsPath;
    }
    return this.lastProvidedPath;
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const cfg = this.deps.config();
    if (!cfg.enabled || !cfg.codeLensHandlers || doc.languageId !== 'go') {
      return [];
    }
    if (doc.uri.fsPath.endsWith('.pb.go')) {
      return [];
    }

    this.lastProvidedPath = doc.uri.fsPath;
    const lenses: HandlerLens[] = [];
    for (let i = 0; i < doc.lineCount; i++) {
      const m = findHandlerMethod(doc.lineAt(i).text);
      if (!m) {
        continue;
      }
      lenses.push(
        new HandlerLens(
          new vscode.Range(i, m.character, i, m.character + m.name.length),
          doc.uri.fsPath,
        ),
      );
    }
    return lenses;
  }

  async resolveCodeLens(lens: vscode.CodeLens): Promise<vscode.CodeLens> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const docPath = this.documentFor(lens);
    if (!docPath || !root) {
      lens.command = { title: '', command: '' };
      return lens;
    }

    const pos = lens.range.start;
    try {
      const resolved = await this.deps.pipeline.siteAt(
        docPath,
        { line: pos.line, character: pos.character },
        REFERENCE_STAGES,
      );
      const clientMethod = resolved?.site.clientMethod;
      if (!resolved || !clientMethod) {
        lens.command = { title: '', command: '' };
        return lens;
      }

      const pbKey = guardKey(vscode.Uri.file(resolved.pbPath).toString(), clientMethod);
      const callers = await withGuard(
        pbKey,
        () => this.deps.resolver.callersFor(resolved.pbPath, clientMethod),
        [],
      );

      lens.command = {
        title: describeCallers(callers, root),
        command: 'gorpcLens.findCallers',
      };
    } catch (err) {
      this.deps.log.error('codelens', err);
      lens.command = { title: '', command: '' };
    }
    return lens;
  }
}
