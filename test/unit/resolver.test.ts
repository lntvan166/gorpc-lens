import * as assert from 'assert';
import { Resolver, ResolverOptions } from '../../src/core/resolver';
import { Loc, LspClient, Logger, Pos } from '../../src/core/types';

const OPTS: ResolverOptions = { excludeGlobs: ['**/*.pb.go'], includeTests: false, timeoutMs: 1000 };

const SILENT: Logger = { trace: () => undefined, error: () => undefined };

class FakeLsp implements LspClient {
  implementationCalls = 0;

  constructor(
    private readonly impls: Loc[] = [],
    private readonly refs: Loc[] = [],
    private readonly lines: Record<string, string> = {},
    private readonly delayMs = 0,
  ) {}

  async definitions(): Promise<Loc[]> {
    return [];
  }

  async implementations(_p: string, _pos: Pos): Promise<Loc[]> {
    this.implementationCalls++;
    if (this.delayMs) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }
    return this.impls;
  }

  async references(): Promise<Loc[]> {
    return this.refs;
  }

  async documentText(): Promise<string | undefined> {
    return undefined;
  }

  async lineText(path: string, line: number): Promise<string | undefined> {
    return this.lines[`${path}:${line}`];
  }
}

const SERVER_METHOD = { name: 'Echo', line: 40, character: 1 };
const CLIENT_METHOD = { name: 'Echo', line: 10, character: 1 };

describe('Resolver.handlersFor', () => {
  it('keeps the real handler and drops the generated trampoline', async () => {
    const lsp = new FakeLsp(
      [
        { path: '/r/pb/echo_grpc.pb.go', line: 100, character: 5 },
        { path: '/r/svc/handler.go', line: 47, character: 30 },
      ],
      [],
      { '/r/svc/handler.go:47': 'func (h *EchoHandler) Echo(ctx context.Context) error {' },
    );
    const r = new Resolver(lsp, () => OPTS, SILENT);
    const out = await r.handlersFor('/r/pb/echo_grpc.pb.go', SERVER_METHOD);
    assert.deepStrictEqual(out, [{ path: '/r/svc/handler.go', line: 47, character: 30 }]);
  });

  it('drops a stub receiver even outside a pb.go file', async () => {
    const lsp = new FakeLsp(
      [{ path: '/r/svc/stub.go', line: 5, character: 20 }],
      [],
      { '/r/svc/stub.go:5': 'func (UnimplementedEchoServiceServer) Echo() {}' },
    );
    const r = new Resolver(lsp, () => OPTS, SILENT);
    assert.deepStrictEqual(await r.handlersFor('/r/pb/echo_grpc.pb.go', SERVER_METHOD), []);
  });

  it('serves the second call from cache', async () => {
    const lsp = new FakeLsp([{ path: '/r/svc/handler.go', line: 47, character: 30 }]);
    const r = new Resolver(lsp, () => OPTS, SILENT);
    await r.handlersFor('/r/pb/echo_grpc.pb.go', SERVER_METHOD);
    await r.handlersFor('/r/pb/echo_grpc.pb.go', SERVER_METHOD);
    assert.strictEqual(lsp.implementationCalls, 1);
  });

  it('re-queries after clearCache', async () => {
    const lsp = new FakeLsp([{ path: '/r/svc/handler.go', line: 47, character: 30 }]);
    const r = new Resolver(lsp, () => OPTS, SILENT);
    await r.handlersFor('/r/pb/echo_grpc.pb.go', SERVER_METHOD);
    r.clearCache();
    await r.handlersFor('/r/pb/echo_grpc.pb.go', SERVER_METHOD);
    assert.strictEqual(lsp.implementationCalls, 2);
  });

  it('returns nothing on timeout and does not cache the miss', async () => {
    const lsp = new FakeLsp([{ path: '/r/svc/handler.go', line: 47, character: 30 }], [], {}, 100);
    const r = new Resolver(lsp, () => ({ ...OPTS, timeoutMs: 5 }), SILENT);
    assert.deepStrictEqual(await r.handlersFor('/r/pb/echo_grpc.pb.go', SERVER_METHOD), []);
    await r.handlersFor('/r/pb/echo_grpc.pb.go', SERVER_METHOD);
    assert.strictEqual(lsp.implementationCalls, 2);
  });
});

describe('Resolver.callersFor', () => {
  it('keeps call sites, whose lines are not method declarations', async () => {
    const lsp = new FakeLsp(
      [],
      [
        { path: '/r/pb/echo_grpc.pb.go', line: 10, character: 1 },
        { path: '/r/biz/order.go', line: 94, character: 40 },
      ],
      { '/r/biz/order.go:94': '\tresp, err := b.echoClient.Echo(ctx, &pb.EchoRequest{})' },
    );
    const r = new Resolver(lsp, () => OPTS, SILENT);
    assert.deepStrictEqual(await r.callersFor('/r/pb/echo_grpc.pb.go', CLIENT_METHOD), [
      { path: '/r/biz/order.go', line: 94, character: 40 },
    ]);
  });
});
