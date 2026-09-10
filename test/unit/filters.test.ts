import * as assert from 'assert';
import { filterByPath, filterByReceiver, receiverTypeFromLine } from '../../src/core/filters';

const OPTS = { excludeGlobs: ['**/*.pb.go'], includeTests: false };

describe('filterByPath', () => {
  it('drops generated files and keeps the real handler', () => {
    const kept = filterByPath(
      [{ path: '/r/pb/x_grpc.pb.go' }, { path: '/r/mnt/handler/order.go' }],
      OPTS,
    );
    assert.deepStrictEqual(kept.map((k) => k.path), ['/r/mnt/handler/order.go']);
  });

  it('drops test files by default', () => {
    assert.strictEqual(filterByPath([{ path: '/r/a/x_test.go' }], OPTS).length, 0);
  });

  it('keeps test files when asked', () => {
    const opts = { ...OPTS, includeTests: true };
    assert.strictEqual(filterByPath([{ path: '/r/a/x_test.go' }], opts).length, 1);
  });

  it('honours additional user globs', () => {
    const opts = { ...OPTS, excludeGlobs: ['**/*.pb.go', '**/mocks/**'] };
    assert.strictEqual(filterByPath([{ path: '/r/mocks/a.go' }], opts).length, 0);
  });
});

describe('filterByReceiver', () => {
  it('drops Unimplemented and Unsafe stubs', () => {
    const kept = filterByReceiver([
      { receiverType: 'UnimplementedEchoServiceServer' },
      { receiverType: 'UnsafeEchoServiceServer' },
      { receiverType: 'EchoHandler' },
    ]);
    assert.deepStrictEqual(kept.map((k) => k.receiverType), ['EchoHandler']);
  });

  it('keeps results whose receiver could not be determined', () => {
    assert.strictEqual(filterByReceiver([{ receiverType: undefined }]).length, 1);
  });

  it('does not drop a legitimate type that merely contains the word', () => {
    assert.strictEqual(filterByReceiver([{ receiverType: 'MyUnimplementedThing' }]).length, 1);
  });
});

describe('receiverTypeFromLine', () => {
  it('reads a pointer receiver', () => {
    assert.strictEqual(
      receiverTypeFromLine('func (h *OrderHandler) ListOrders(ctx context.Context) error {'),
      'OrderHandler',
    );
  });

  it('reads a value receiver', () => {
    assert.strictEqual(receiverTypeFromLine('func (h Handler) Echo() {'), 'Handler');
  });

  it('returns undefined for a plain function', () => {
    assert.strictEqual(receiverTypeFromLine('func Echo() {}'), undefined);
  });
});
