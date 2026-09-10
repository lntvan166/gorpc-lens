import { matchGlob } from './glob';

export interface FilterOptions {
  excludeGlobs: string[];
  includeTests: boolean;
}

const STUB_RECEIVER = /^(Unimplemented|Unsafe)/;
// Both `func (h *T)` and the anonymous `func (T)` that generated
// Unimplemented stubs use.
const RECEIVER = /^func\s*\(\s*(?:\w+\s+)?\*?(\w+)\s*\)/;

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

export function receiverTypeFromLine(line: string): string | undefined {
  return RECEIVER.exec(line)?.[1];
}
