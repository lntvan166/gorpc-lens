import * as vscode from 'vscode';
import { Loc, LspClient, Pos } from '../core/types';
import { normalizeRawLocations } from '../core/lsp';

export class VsCodeLspClient implements LspClient {
  definitions(path: string, pos: Pos): Promise<Loc[]> {
    return this.exec('vscode.executeDefinitionProvider', path, pos);
  }

  implementations(path: string, pos: Pos): Promise<Loc[]> {
    return this.exec('vscode.executeImplementationProvider', path, pos);
  }

  references(path: string, pos: Pos): Promise<Loc[]> {
    return this.exec('vscode.executeReferenceProvider', path, pos);
  }

  async documentText(path: string): Promise<string | undefined> {
    const doc = await this.open(path);
    return doc?.getText();
  }

  async lineText(path: string, line: number): Promise<string | undefined> {
    const doc = await this.open(path);
    if (!doc || line < 0 || line >= doc.lineCount) {
      return undefined;
    }
    return doc.lineAt(line).text;
  }

  private async exec(command: string, path: string, pos: Pos): Promise<Loc[]> {
    const raw = await vscode.commands.executeCommand<unknown>(
      command,
      vscode.Uri.file(path),
      new vscode.Position(pos.line, pos.character),
    );
    return normalizeRawLocations(raw);
  }

  private async open(path: string): Promise<vscode.TextDocument | undefined> {
    try {
      return await vscode.workspace.openTextDocument(vscode.Uri.file(path));
    } catch {
      return undefined;
    }
  }
}
