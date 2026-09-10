import * as assert from 'assert';
import { normalizeRawLocations, withTimeout, ResolveCache } from '../../src/core/lsp';

describe('normalizeRawLocations', () => {
  it('reads a plain Location', () => {
    const raw = [{ uri: { fsPath: '/a/b.go' }, range: { start: { line: 3, character: 7 } } }];
    assert.deepStrictEqual(normalizeRawLocations(raw), [{ path: '/a/b.go', line: 3, character: 7 }]);
  });

  it('prefers targetSelectionRange on a LocationLink', () => {
    const raw = [
      {
        targetUri: { fsPath: '/a/b.go' },
        targetRange: { start: { line: 1, character: 0 } },
        targetSelectionRange: { start: { line: 3, character: 7 } },
      },
    ];
    assert.deepStrictEqual(normalizeRawLocations(raw), [{ path: '/a/b.go', line: 3, character: 7 }]);
  });

  it('falls back to targetRange when there is no selection range', () => {
    const raw = [{ targetUri: { fsPath: '/a/b.go' }, targetRange: { start: { line: 1, character: 2 } } }];
    assert.deepStrictEqual(normalizeRawLocations(raw), [{ path: '/a/b.go', line: 1, character: 2 }]);
  });

  it('returns an empty array for null, undefined, or a non-array', () => {
    assert.deepStrictEqual(normalizeRawLocations(null), []);
    assert.deepStrictEqual(normalizeRawLocations(undefined), []);
    assert.deepStrictEqual(normalizeRawLocations({}), []);
  });

  it('skips malformed entries rather than throwing', () => {
    assert.deepStrictEqual(normalizeRawLocations([{ uri: { fsPath: '/a.go' } }, null]), []);
  });
});

describe('withTimeout', () => {
  it('returns the value when the promise wins', async () => {
    assert.strictEqual(await withTimeout(Promise.resolve(5), 1000), 5);
  });

  it('returns undefined when the deadline wins', async () => {
    const slow = new Promise<number>((r) => setTimeout(() => r(5), 200));
    assert.strictEqual(await withTimeout(slow, 10), undefined);
  });

  it('returns undefined rather than rejecting when the promise fails', async () => {
    assert.strictEqual(await withTimeout(Promise.reject(new Error('boom')), 1000), undefined);
  });
});

describe('ResolveCache', () => {
  it('round-trips a value under a composed key', () => {
    const c = new ResolveCache();
    const key = ResolveCache.key('handlers', '/a/b_grpc.pb.go', 10, 2);
    c.set(key, [{ path: '/x.go', line: 1, character: 1 }]);
    assert.strictEqual(c.get(key)?.length, 1);
  });

  it('distinguishes directions at the same position', () => {
    const c = new ResolveCache();
    c.set(ResolveCache.key('handlers', '/a.go', 1, 1), []);
    assert.strictEqual(c.get(ResolveCache.key('callers', '/a.go', 1, 1)), undefined);
  });

  it('drops everything on clear', () => {
    const c = new ResolveCache();
    const key = ResolveCache.key('handlers', '/a.go', 1, 1);
    c.set(key, []);
    c.clear();
    assert.strictEqual(c.get(key), undefined);
  });
});
