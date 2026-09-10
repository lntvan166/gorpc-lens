import * as assert from 'assert';
import { describeCallers, moduleOf } from '../../src/core/summary';

const ROOT = '/home/u/src/monorepo';

describe('moduleOf', () => {
  it('takes the first path segment under the workspace root', () => {
    assert.strictEqual(moduleOf(`${ROOT}/order-biz/manager/biz/x.go`, ROOT), 'order-biz');
  });

  it('returns undefined for a path outside the root', () => {
    assert.strictEqual(moduleOf('/elsewhere/a.go', ROOT), undefined);
  });

  it('returns undefined for a file sitting directly in the root', () => {
    assert.strictEqual(moduleOf(`${ROOT}/main.go`, ROOT), undefined);
  });
});

describe('describeCallers', () => {
  it('counts callers and the distinct services they live in', () => {
    const locs = [
      { path: `${ROOT}/order-biz/a.go`, line: 1, character: 0 },
      { path: `${ROOT}/order-biz/b.go`, line: 2, character: 0 },
      { path: `${ROOT}/billing-svc/c.go`, line: 3, character: 0 },
    ];
    assert.strictEqual(describeCallers(locs, ROOT), '3 callers in 2 services');
  });

  it('uses singular forms for one caller in one service', () => {
    assert.strictEqual(
      describeCallers([{ path: `${ROOT}/order-biz/a.go`, line: 1, character: 0 }], ROOT),
      '1 caller in 1 service',
    );
  });

  it('says so plainly when there are none', () => {
    assert.strictEqual(describeCallers([], ROOT), 'no callers');
  });
});
