import * as assert from 'assert';
import { classify } from '../../src/core/locator';
import { PbFileModel } from '../../src/core/pbFile';

function model(): PbFileModel {
  return {
    protoSource: 'a/b.proto',
    services: new Map([
      [
        'EchoService',
        {
          name: 'EchoService',
          client: {
            name: 'EchoServiceClient',
            methods: new Map([['Echo', { name: 'Echo', line: 10, character: 1 }]]),
          },
          server: {
            name: 'EchoServiceServer',
            methods: new Map([['Echo', { name: 'Echo', line: 40, character: 1 }]]),
          },
        },
      ],
    ]),
  };
}

describe('classify', () => {
  it('recognises a client interface method and carries the server sibling', () => {
    const site = classify(model(), 10, 2)!;
    assert.strictEqual(site.role, 'client');
    assert.strictEqual(site.service, 'EchoService');
    assert.strictEqual(site.method, 'Echo');
    assert.strictEqual(site.serverMethod?.line, 40);
    assert.strictEqual(site.protoSource, 'a/b.proto');
  });

  it('recognises a server interface method and carries the client sibling', () => {
    const site = classify(model(), 40, 1)!;
    assert.strictEqual(site.role, 'server');
    assert.strictEqual(site.clientMethod?.line, 10);
  });

  it('accepts the position just past the last character of the name', () => {
    assert.ok(classify(model(), 10, 1 + 'Echo'.length));
  });

  it('rejects a position before the name starts', () => {
    assert.strictEqual(classify(model(), 10, 0), undefined);
  });

  it('rejects a position on an unrelated line', () => {
    assert.strictEqual(classify(model(), 11, 1), undefined);
  });
});
