import * as path from 'path';
import * as vscode from 'vscode';
import { generatedFileNameFor, pickNearestProto, rpcDeclAt, sourceMatches } from '../core/proto';
import { Deps, toVsLocation } from './definition';

/**
 * Ctrl+Click on an `rpc` line in a .proto file jumps to the Go handler that
 * serves it.
 *
 * gopls cannot help here - a .proto file is not Go - so the generated stub is
 * located by protoc-gen-go-grpc's filename convention and then confirmed by its
 * `// source:` header, which is what distinguishes several services sharing one
 * directory, and one repo's copy of a proto tree from a worktree's.
 */
export class ProtoDefinitionProvider implements vscode.DefinitionProvider {
  /** proto path -> confirmed generated stub. A workspace-wide glob over a large
   *  monorepo is far too slow to run on every click. */
  private readonly stubs = new Map<string, string>();

  constructor(private readonly deps: Deps) {}

  invalidate(): void {
    this.stubs.clear();
  }

  async provideDefinition(
    doc: vscode.TextDocument,
    pos: vscode.Position,
  ): Promise<vscode.Location[] | undefined> {
    if (!this.deps.config().enabled) {
      return undefined;
    }

    const decl = rpcDeclAt(doc.lineAt(pos.line).text);
    if (!decl) {
      return undefined;
    }
    if (pos.character < decl.character || pos.character > decl.character + decl.name.length) {
      return undefined;
    }

    try {
      const started = Date.now();
      const pbPath = await this.generatedFileFor(doc.uri.fsPath);
      this.deps.log.trace('proto', `stub lookup -> ${pbPath ?? 'none'}`, Date.now() - started);
      if (!pbPath) {
        this.deps.log.trace('proto', `no generated stub found for ${doc.uri.fsPath}`);
        return undefined;
      }

      const resolved = await this.deps.pipeline.siteForMethod(pbPath, decl.name);
      const serverMethod = resolved?.site.serverMethod;
      if (!resolved || !serverMethod) {
        return undefined;
      }

      const handlers = await this.deps.resolver.handlersFor(resolved.pbPath, serverMethod);
      return handlers.length ? handlers.map(toVsLocation) : undefined;
    } catch (err) {
      this.deps.log.error('proto', err);
      return undefined;
    }
  }

  private async generatedFileFor(protoPath: string): Promise<string | undefined> {
    const cached = this.stubs.get(protoPath);
    if (cached) {
      return cached;
    }

    const name = generatedFileNameFor(protoPath);

    // Fast path: protoc-gen-go-grpc writes the stub next to the .proto in
    // essentially every layout. Checking that one file costs nothing, and it
    // avoids a workspace-wide glob that can take seconds on a large monorepo.
    const sibling = path.join(path.dirname(protoPath), name);
    if (await this.confirms(sibling, protoPath)) {
      this.stubs.set(protoPath, sibling);
      return sibling;
    }

    const found = await vscode.workspace.findFiles(`**/${name}`, '**/node_modules/**', 50);
    const confirmed: string[] = [];
    for (const uri of found) {
      if (await this.confirms(uri.fsPath, protoPath)) {
        confirmed.push(uri.fsPath);
      }
    }
    if (confirmed.length === 0) {
      return undefined;
    }
    // Several copies can match in a repo with nested worktrees; take the one
    // sharing the longest path with the proto being viewed.
    const nearest = pickNearestProto(confirmed, protoPath);
    if (nearest) {
      this.stubs.set(protoPath, nearest);
    }
    return nearest;
  }

  /** Whether this generated file's `// source:` header names that proto. */
  private async confirms(pbPath: string, protoPath: string): Promise<boolean> {
    const model = await this.deps.pipeline.modelFor(pbPath);
    return sourceMatches(model?.protoSource, protoPath);
  }
}
