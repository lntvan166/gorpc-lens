import * as assert from 'assert';
import {
  findRpcLine,
  generatedFileNameFor,
  pickNearestProto,
  rpcDeclAt,
  sourceMatches,
} from '../../src/core/proto';

const PROTO = [
  'syntax = "proto3";',
  '',
  'service OrderService {',
  '    rpc ListOrders (ListOrdersRequest) returns (ListOrdersResponse) {}',
  '    rpc ListOrdersForExport (ListOrdersForExportRequest) returns (ListOrdersForExportResponse) {}',
  '}',
].join('\n');

describe('findRpcLine', () => {
  it('finds an rpc by name', () => {
    assert.strictEqual(findRpcLine(PROTO, 'ListOrders'), 3);
  });

  it('does not match a longer rpc that starts with the same name', () => {
    assert.strictEqual(findRpcLine(PROTO, 'ListOrdersForExport'), 4);
  });

  it('returns undefined for an rpc that is not there', () => {
    assert.strictEqual(findRpcLine(PROTO, 'Nope'), undefined);
  });

  it('tolerates no space before the parenthesis', () => {
    assert.strictEqual(findRpcLine('  rpc Echo(EchoRequest) returns (EchoResponse);', 'Echo'), 0);
  });
});

describe('pickNearestProto', () => {
  const PB = '/src/monorepo/protos/order-svc/order_service_grpc.pb.go';
  const SIBLING = '/src/monorepo/protos/order-svc/order_service.proto';
  const WORKTREE = '/src/monorepo/ws-feature/protos/order-svc/order_service.proto';

  it('prefers the copy sitting beside the generated file', () => {
    assert.strictEqual(pickNearestProto([WORKTREE, SIBLING], PB), SIBLING);
  });

  it('is not fooled by candidate order', () => {
    assert.strictEqual(pickNearestProto([SIBLING, WORKTREE], PB), SIBLING);
  });

  it('returns the only candidate when there is one', () => {
    assert.strictEqual(pickNearestProto([WORKTREE], PB), WORKTREE);
  });

  it('returns undefined when there are none', () => {
    assert.strictEqual(pickNearestProto([], PB), undefined);
  });
});

describe('rpcDeclAt', () => {
  it('reads the rpc name and its column', () => {
    const line = '    rpc ListOrders (ListOrdersRequest) returns (ListOrdersResponse) {';
    const d = rpcDeclAt(line)!;
    assert.strictEqual(d.name, 'ListOrders');
    assert.strictEqual(line.slice(d.character, d.character + d.name.length), 'ListOrders');
  });

  it('handles no space before the parenthesis', () => {
    assert.strictEqual(rpcDeclAt('  rpc Echo(EchoRequest) returns (EchoResponse);')!.name, 'Echo');
  });

  it('ignores a comment that mentions rpc', () => {
    assert.strictEqual(rpcDeclAt('  // rpc ListOrders is the read path'), undefined);
  });

  it('ignores a service declaration', () => {
    assert.strictEqual(rpcDeclAt('service OrderService {'), undefined);
  });
});

describe('generatedFileNameFor', () => {
  it('maps a proto path to its grpc stub filename', () => {
    assert.strictEqual(
      generatedFileNameFor('/r/protos/order-svc/order_service.proto'),
      'order_service_grpc.pb.go',
    );
  });

  it('works on a bare filename', () => {
    assert.strictEqual(generatedFileNameFor('order_service.proto'), 'order_service_grpc.pb.go');
  });
});

describe('sourceMatches', () => {
  const PROTO = '/r/protos/order-svc/order_service.proto';

  it('matches the header path against the real file', () => {
    assert.strictEqual(sourceMatches('order-svc/order_service.proto', PROTO), true);
  });

  it('rejects a same-named proto from a different package dir', () => {
    assert.strictEqual(sourceMatches('cart-svc/order_service.proto', PROTO), false);
  });

  it('is false when the generated file has no source header', () => {
    assert.strictEqual(sourceMatches(undefined, PROTO), false);
  });

  it('tolerates windows separators in the path', () => {
    assert.strictEqual(
      sourceMatches('order-svc/order_service.proto', 'C:\\r\\protos\\order-svc\\order_service.proto'),
      true,
    );
  });
});
