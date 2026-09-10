import { Loc, Logger, LspClient, Pos } from './types';
import { ResolveCache, withTimeout } from './lsp';
import { FilterOptions, filterByPath, filterByReceiver } from './filters';
import { receiverTypeFromLine } from './goDecl';
import { MethodRef } from './pbFile';

export type Direction = 'handlers' | 'callers';

export interface ResolverOptions extends FilterOptions {
  timeoutMs: number;
}

type Query = (path: string, pos: Pos) => Promise<Loc[]>;

export class Resolver {
  constructor(
    private readonly lsp: LspClient,
    private readonly opts: () => ResolverOptions,
    private readonly log: Logger,
    private readonly cache: ResolveCache = new ResolveCache(),
  ) {}

  clearCache(): void {
    this.cache.clear();
  }

  handlersFor(pbPath: string, serverMethod: MethodRef): Promise<Loc[]> {
    return this.run('handlers', pbPath, serverMethod, (p, pos) => this.lsp.implementations(p, pos));
  }

  callersFor(pbPath: string, clientMethod: MethodRef): Promise<Loc[]> {
    return this.run('callers', pbPath, clientMethod, (p, pos) => this.lsp.references(p, pos));
  }

  private async run(
    direction: Direction,
    pbPath: string,
    method: MethodRef,
    query: Query,
  ): Promise<Loc[]> {
    const key = ResolveCache.key(direction, pbPath, method.line, method.character);
    const hit = this.cache.get(key);
    if (hit) {
      this.log.trace(direction, `cache hit ${key}`);
      return hit;
    }

    const opts = this.opts();
    const pos: Pos = { line: method.line, character: method.character };
    const started = Date.now();
    const raw = await withTimeout(query(pbPath, pos), opts.timeoutMs);
    if (raw === undefined) {
      this.log.trace(direction, `no answer within ${opts.timeoutMs}ms`, Date.now() - started);
      return [];
    }
    this.log.trace(direction, `${raw.length} raw results`, Date.now() - started);

    const byPath = filterByPath(raw, opts);
    const enriched = await Promise.all(
      byPath.map(async (loc) => ({
        ...loc,
        receiverType: receiverTypeFromLine((await this.lsp.lineText(loc.path, loc.line)) ?? ''),
      })),
    );
    const kept = filterByReceiver(enriched).map(({ path, line, character }) => ({
      path,
      line,
      character,
    }));

    this.log.trace(direction, `${kept.length} kept`);
    this.cache.set(key, kept);
    return kept;
  }
}
