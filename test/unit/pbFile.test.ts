import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parsePbFile, stripLineComment, isGeneratedGrpcFile } from '../../src/core/pbFile';

const FIXTURES = path.join(__dirname, '..', '..', '..', 'test', 'fixtures', 'pb');

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

describe('parsePbFile', () => {
  it('reads the proto source path from the header comment', () => {
    const model = parsePbFile(fixture('order_service_grpc.pb.go'));
    assert.strictEqual(model.protoSource, 'order-svc/order_service.proto');
  });

  it('pairs the client and server interfaces under one service name', () => {
    const model = parsePbFile(fixture('order_service_grpc.pb.go'));
    const svc = model.services.get('OrderService');
    assert.ok(svc, 'expected a OrderService entry');
    assert.strictEqual(svc.client?.name, 'OrderServiceClient');
    assert.strictEqual(svc.server?.name, 'OrderServiceServer');
  });

  it('records both methods on both sides', () => {
    const model = parsePbFile(fixture('order_service_grpc.pb.go'));
    const svc = model.services.get('OrderService')!;
    assert.deepStrictEqual([...svc.client!.methods.keys()].sort(), [
      'CountOrdersByStatus',
      'ListOrders',
    ]);
    assert.deepStrictEqual([...svc.server!.methods.keys()].sort(), [
      'CountOrdersByStatus',
      'ListOrders',
    ]);
  });

  it('points at the method name, not the start of the line', () => {
    const text = fixture('order_service_grpc.pb.go');
    const model = parsePbFile(text);
    const ref = model.services.get('OrderService')!.server!.methods.get('ListOrders')!;
    const line = text.split('\n')[ref.line];
    assert.strictEqual(line.slice(ref.character, ref.character + 'ListOrders'.length), 'ListOrders');
  });

  it('is not confused by multi-paragraph doc comments between methods', () => {
    const model = parsePbFile(fixture('order_service_grpc.pb.go'));
    assert.strictEqual(model.services.get('OrderService')!.server!.methods.size, 2);
  });

  it('ignores the Unimplemented struct and the Unsafe interface', () => {
    const model = parsePbFile(fixture('order_service_grpc.pb.go'));
    assert.deepStrictEqual([...model.services.keys()], ['OrderService']);
  });

  it('handles streaming signatures and skips the unexported embed guard', () => {
    const model = parsePbFile(fixture('streaming_grpc.pb.go'));
    const svc = model.services.get('FeedService')!;
    assert.deepStrictEqual([...svc.server!.methods.keys()], ['Subscribe']);
    assert.deepStrictEqual([...svc.client!.methods.keys()], ['Subscribe']);
  });

  it('handles an interface closed on its own line', () => {
    const model = parsePbFile(fixture('empty_grpc.pb.go'));
    const svc = model.services.get('NothingService')!;
    assert.strictEqual(svc.client!.methods.size, 0);
    assert.strictEqual(svc.server!.methods.size, 0);
  });
});

describe('stripLineComment', () => {
  it('removes a trailing comment', () => {
    assert.strictEqual(stripLineComment('Foo(a) // note {'), 'Foo(a) ');
  });

  it('leaves a line without a comment alone', () => {
    assert.strictEqual(stripLineComment('Foo(a)'), 'Foo(a)');
  });
});

describe('isGeneratedGrpcFile', () => {
  it('accepts generated grpc files', () => {
    assert.strictEqual(isGeneratedGrpcFile('/x/y/order_service_grpc.pb.go'), true);
  });

  it('rejects message-only generated files and hand-written go', () => {
    assert.strictEqual(isGeneratedGrpcFile('/x/y/order_model.pb.go'), false);
    assert.strictEqual(isGeneratedGrpcFile('/x/y/handler.go'), false);
  });
});
