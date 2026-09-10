import * as assert from 'assert';
import { findRpcLine, pickNearestProto } from '../../src/core/proto';

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
