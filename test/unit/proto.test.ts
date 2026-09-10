import * as assert from 'assert';
import { findRpcLine } from '../../src/core/proto';

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
