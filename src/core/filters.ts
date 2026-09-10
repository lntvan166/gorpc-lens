import { matchGlob } from './glob';

export interface FilterOptions {
  excludeGlobs: string[];
  includeTests: boolean;
}

const STUB_RECEIVER = /^(Unimplemented|Unsafe)/;

export function filterByPath<T extends { path: string }>(results: T[], opts: FilterOptions): T[] {
  return results.filter((r) => {
    if (!opts.includeTests && r.path.endsWith('_test.go')) {
      return false;
    }
    return !opts.excludeGlobs.some((g) => matchGlob(r.path, g));
  });
}

export function filterByReceiver<T extends { receiverType?: string }>(results: T[]): T[] {
  return results.filter((r) => r.receiverType === undefined || !STUB_RECEIVER.test(r.receiverType));
}

export function excludeSelf<T extends { path: string; line: number }>(
  results: T[],
  current: { path: string; line: number },
): T[] {
  return results.filter((r) => !(r.path === current.path && r.line === current.line));
}

/**
 * Drop generated results from a go-to-definition list.
 *
 * Unlike picking the first result, this removes the generated entries outright,
 * so a list of three real targets stays a list of three. The fallback matters:
 * a symbol that only exists in generated code — a request message type, say —
 * would otherwise navigate nowhere at all, which is worse than landing in the
 * generated file.
 */
export function keepNonGenerated<T extends { path: string }>(
  results: T[],
  opts: FilterOptions,
  active: boolean,
): T[] {
  if (!active || results.length === 0) {
    return results;
  }
  const kept = results.filter((r) => !opts.excludeGlobs.some((g) => matchGlob(r.path, g)));
  return kept.length > 0 ? kept : results;
}
