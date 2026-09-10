import * as assert from 'assert';
import { guardKey, withGuard } from '../../src/vscode/guard';

describe('withGuard', () => {
  it('runs the body when the key is free', async () => {
    assert.strictEqual(await withGuard('k1', async () => 'ran', 'blocked'), 'ran');
  });

  it('blocks a reentrant call at the same key', async () => {
    let inner = 'not-run';
    const outer = await withGuard(
      'k2',
      async () => {
        inner = await withGuard('k2', async () => 'ran', 'blocked');
        return 'outer';
      },
      'blocked',
    );
    assert.strictEqual(outer, 'outer');
    assert.strictEqual(inner, 'blocked');
  });

  it('allows a different key to run inside', async () => {
    let inner = '';
    await withGuard(
      'k3',
      async () => {
        inner = await withGuard('k4', async () => 'ran', 'blocked');
      },
      undefined,
    );
    assert.strictEqual(inner, 'ran');
  });

  it('releases the key even when the body throws', async () => {
    await assert.rejects(withGuard('k5', async () => { throw new Error('boom'); }, undefined));
    assert.strictEqual(await withGuard('k5', async () => 'ran', 'blocked'), 'ran');
  });

  it('composes a key from a uri and a position', () => {
    assert.strictEqual(guardKey('file:///a.go', { line: 3, character: 7 }), 'file:///a.go:3:7');
  });
});
