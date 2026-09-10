import * as assert from 'assert';
import { findHandlerMethod, receiverTypeFromLine } from '../../src/core/goDecl';

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

  it('reads an anonymous receiver, as generated Unimplemented stubs use', () => {
    assert.strictEqual(
      receiverTypeFromLine('func (UnimplementedOrderServiceServer) ListOrders() {'),
      'UnimplementedOrderServiceServer',
    );
  });

  it('returns undefined for a plain function', () => {
    assert.strictEqual(receiverTypeFromLine('func Echo() {}'), undefined);
  });
});

describe('findHandlerMethod', () => {
  it('finds the method name after the receiver', () => {
    const line = 'func (h *OrderHandler) ListOrders(ctx context.Context, req *R) (*S, error) {';
    const m = findHandlerMethod(line)!;
    assert.strictEqual(m.name, 'ListOrders');
    assert.strictEqual(line.slice(m.character, m.character + m.name.length), 'ListOrders');
  });

  it('does not point inside the receiver type when it contains the method name', () => {
    const line = 'func (h *EchoHandler) Echo(ctx context.Context, req *pb.EchoRequest) (*pb.EchoResponse, error) {';
    const m = findHandlerMethod(line)!;
    assert.strictEqual(m.name, 'Echo');
    assert.ok(m.character > line.indexOf(')'), 'method name must be located after the receiver');
    assert.strictEqual(line.slice(m.character, m.character + 4), 'Echo');
  });

  it('ignores a method whose first parameter is not a context', () => {
    assert.strictEqual(findHandlerMethod('func (h *T) Close() error {'), undefined);
  });

  it('ignores an unexported method', () => {
    assert.strictEqual(findHandlerMethod('func (h *T) echo(ctx context.Context) error {'), undefined);
  });

  it('ignores a plain function', () => {
    assert.strictEqual(findHandlerMethod('func Echo(ctx context.Context) error {'), undefined);
  });
});
