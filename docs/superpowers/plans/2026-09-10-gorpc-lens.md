# gorpc-lens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a VS Code extension that makes Ctrl+Click on a Go gRPC client call also offer the handler that actually runs, in another module, alongside the generated interface gopls lands on today.

**Architecture:** A vscode-free core plus a thin VS Code adapter. The core parses only generated `*_grpc.pb.go` files, hops from a client interface method to its server counterpart, and delegates every cross-module search to gopls via `executeImplementationProvider` / `executeReferenceProvider`. There is no index, no file watcher, and nothing repo-specific encoded anywhere.

**Tech Stack:** TypeScript, VS Code Extension API, esbuild, mocha, `@vscode/test-electron`.

**Spec:** `docs/superpowers/specs/2026-09-10-gorpc-lens-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **Engine floor:** `"engines": { "vscode": "^1.75.0" }`.
- **Zero runtime dependencies.** Nothing in `dependencies` — only `devDependencies`. Everything the extension needs at runtime is the VS Code API or Node builtins. This is why Task 4 hand-rolls a glob matcher instead of pulling in `minimatch`.
- **Activation:** `"activationEvents": ["onLanguage:go"]`.
- **Layer boundary, enforced by review:** nothing under `src/core/` may `import * as vscode`. The core takes plain filesystem paths and `{line, character}` objects. Only `src/vscode/` and `src/extension.ts` touch the VS Code API. This is what makes the core unit-testable outside the extension host.
- **Config keys and exact defaults:** `gorpcLens.enabled` = `true`; `gorpcLens.timeoutMs` = `2000`; `gorpcLens.includeTests` = `false`; `gorpcLens.codeLens.handlers` = `false`; `gorpcLens.excludeGlobs` = `["**/*.pb.go"]`; `gorpcLens.trace` = `"off"` (enum `"off" | "verbose"`).
- **Failure principle:** every failure path returns no extra results. Providers fail silently; commands fail loudly with a `showWarningMessage`. Never throw out of a provider, never show a modal.
- **Filtering rules:** drop results matching `excludeGlobs`; drop `*_test.go` unless `includeTests`; drop methods whose receiver type name starts with `Unimplemented` or `Unsafe`.
- **Out of scope for v1:** gRPC reflection, running-server discovery, service-to-repo config files, proto compilation, the handler-to-biz hop, multi-root workspace support beyond what a single root gives free.

## File Structure

```
package.json              manifest: commands, keybindings, menus, configuration
tsconfig.json
esbuild.js
.gitignore  .vscodeignore  .mocharc.json
README.md

src/extension.ts          activate/deactivate, wiring, disposables

src/core/                 NO vscode imports — pure, unit-tested
  trace.ts                TraceLevel and formatTrace
  types.ts                Pos, Loc, Logger, LspClient interfaces
  pbFile.ts               parse a generated *_grpc.pb.go into a model
  locator.ts              (model, line, char) -> RpcSite
  glob.ts                 tiny glob -> RegExp matcher
  filters.ts              result filtering predicates
  resolver.ts             gopls delegation, cache, timeout
  pipeline.ts             position -> RpcSite, via self/definition/implementation

src/vscode/               adapter layer — may import vscode
  config.ts               read gorpcLens.* settings
  log.ts                  output channel + trace
  lspClient.ts            LspClient implemented over vscode.commands
  definition.ts           DefinitionProvider
  reference.ts            ReferenceProvider
  codelens.ts             CodeLensProvider
  commands.ts             goToHandler, findCallers, goToProto

test/unit/*.test.ts       mocha, no VS Code host
test/fixtures/pb/*.go     real generated files as parser fixtures
test/fixtures/workspace/  minimal Go workspace for integration tests
test/integration/         @vscode/test-electron harness
```

---

### Task 1: Scaffold, test harness, and the gopls latency measurement

The spec makes measuring warm gopls latency the first act of implementation, not an assumption. This task builds the smallest thing that can take that measurement, and establishes the test harness on the way.

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.js`, `.gitignore`, `.vscodeignore`, `.mocharc.json`
- Create: `src/extension.ts`, `src/core/trace.ts`, `src/vscode/log.ts`, `src/vscode/config.ts`
- Test: `test/unit/log.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `formatTrace(stage: string, detail: string, ms?: number): string` and `type TraceLevel = 'off' | 'verbose'`, both in `src/core/trace.ts` because they are pure and the unit test must load them without a VS Code host; `class Logger { trace(stage: string, detail: string, ms?: number): void; error(stage: string, err: unknown): void; show(): void; dispose(): void }`; `readConfig(): GorpcConfig` with fields `enabled: boolean, timeoutMs: number, includeTests: boolean, codeLensHandlers: boolean, excludeGlobs: string[], trace: 'off' | 'verbose'`.

- [ ] **Step 1: Create the manifest**

`package.json`:

```json
{
  "name": "gorpc-lens",
  "displayName": "gorpc-lens",
  "description": "Jump from a Go gRPC client call to the handler that actually runs.",
  "version": "0.1.0",
  "publisher": "local",
  "license": "MIT",
  "engines": { "vscode": "^1.75.0" },
  "categories": ["Programming Languages", "Other"],
  "activationEvents": ["onLanguage:go"],
  "main": "./dist/extension.js",
  "contributes": {
    "commands": [
      {
        "command": "gorpcLens.measureLatency",
        "title": "gorpc-lens: Measure gopls Latency (dev)"
      }
    ],
    "configuration": {
      "title": "gorpc-lens",
      "properties": {
        "gorpcLens.enabled": {
          "type": "boolean",
          "default": true,
          "description": "Enable gorpc-lens navigation."
        },
        "gorpcLens.timeoutMs": {
          "type": "number",
          "default": 2000,
          "description": "Give up on a gopls query after this many milliseconds and contribute nothing."
        },
        "gorpcLens.includeTests": {
          "type": "boolean",
          "default": false,
          "description": "Include results in _test.go files."
        },
        "gorpcLens.codeLens.handlers": {
          "type": "boolean",
          "default": false,
          "description": "Show a caller-count CodeLens above gRPC handler methods."
        },
        "gorpcLens.excludeGlobs": {
          "type": "array",
          "items": { "type": "string" },
          "default": ["**/*.pb.go"],
          "description": "Results in files matching these globs are treated as generated code and dropped."
        },
        "gorpcLens.trace": {
          "type": "string",
          "enum": ["off", "verbose"],
          "default": "off",
          "description": "Log each resolution stage and its timing to the gorpc-lens output channel."
        }
      }
    }
  },
  "scripts": {
    "vscode:prepublish": "npm run build",
    "build": "node esbuild.js --production",
    "watch": "node esbuild.js --watch",
    "compile-tests": "tsc -p .",
    "test:unit": "npm run compile-tests && mocha",
    "test:integration": "npm run compile-tests && node out/test/integration/runTest.js",
    "package": "vsce package"
  },
  "devDependencies": {
    "@types/mocha": "^10.0.6",
    "@types/node": "^20.11.30",
    "@types/vscode": "^1.75.0",
    "@vscode/test-electron": "^2.3.9",
    "@vscode/vsce": "^2.24.0",
    "esbuild": "^0.20.2",
    "mocha": "^10.4.0",
    "typescript": "^5.4.5"
  }
}
```

- [ ] **Step 2: Create the build and test config**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2021",
    "lib": ["ES2021"],
    "outDir": "out",
    "rootDir": ".",
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "noUnusedLocals": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"],
  "exclude": ["node_modules", "test/fixtures"]
}
```

`esbuild.js`:

```js
const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    sourcemap: !production,
    minify: production,
    logLevel: 'info',
  });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

`.mocharc.json`:

```json
{
  "spec": "out/test/unit/**/*.test.js",
  "timeout": 10000
}
```

`.gitignore`:

```
node_modules/
out/
dist/
*.vsix
```

`.vscodeignore`:

```
.vscode/**
out/**
test/**
src/**
node_modules/**
esbuild.js
tsconfig.json
.mocharc.json
**/*.map
**/*.ts
```

- [ ] **Step 3: Write the failing test for trace formatting**

`test/unit/log.test.ts`:

```ts
import * as assert from 'assert';
import { formatTrace } from '../../src/core/trace';

describe('formatTrace', () => {
  it('formats a stage and detail without timing', () => {
    assert.strictEqual(formatTrace('definition', '1 result'), '[definition] 1 result');
  });

  it('appends rounded milliseconds when timing is given', () => {
    assert.strictEqual(formatTrace('handlers', '2 results', 12.4), '[handlers] 2 results (12ms)');
  });

  it('treats a zero duration as a real timing, not as absent', () => {
    assert.strictEqual(formatTrace('cache', 'hit', 0), '[cache] hit (0ms)');
  });
});
```

- [ ] **Step 4: Run the test and watch it fail**

```bash
npm install
npm run test:unit
```

Expected: FAIL — `Cannot find module '../../src/vscode/log'`.

- [ ] **Step 5: Implement the logger**

`src/core/trace.ts` — the pure half, so the unit test can load it:

```ts
export type TraceLevel = 'off' | 'verbose';

export function formatTrace(stage: string, detail: string, ms?: number): string {
  const suffix = ms === undefined ? '' : ` (${Math.round(ms)}ms)`;
  return `[${stage}] ${detail}${suffix}`;
}
```

`src/vscode/log.ts` — the half that needs the extension host:

```ts
import * as vscode from 'vscode';
import { TraceLevel, formatTrace } from '../core/trace';

export { TraceLevel, formatTrace };

export class Logger {
  private readonly channel: vscode.OutputChannel;

  constructor(private readonly level: () => TraceLevel) {
    this.channel = vscode.window.createOutputChannel('gorpc-lens');
  }

  trace(stage: string, detail: string, ms?: number): void {
    if (this.level() !== 'verbose') {
      return;
    }
    this.channel.appendLine(formatTrace(stage, detail, ms));
  }

  error(stage: string, err: unknown): void {
    this.channel.appendLine(formatTrace(stage, `ERROR ${String(err)}`));
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
```

Note the `formatTrace` contract the third test pins down: `ms === undefined` means "no timing", so `0` must still print. Writing `ms ? ... : ''` is the bug this test exists to catch.

- [ ] **Step 6: Run the test and watch it pass**

```bash
npm run test:unit
```

Expected: PASS, 3 passing.

- [ ] **Step 7: Implement config reading**

`src/vscode/config.ts`:

```ts
import * as vscode from 'vscode';
import { TraceLevel } from '../core/trace';

export interface GorpcConfig {
  enabled: boolean;
  timeoutMs: number;
  includeTests: boolean;
  codeLensHandlers: boolean;
  excludeGlobs: string[];
  trace: TraceLevel;
}

export function readConfig(): GorpcConfig {
  const c = vscode.workspace.getConfiguration('gorpcLens');
  return {
    enabled: c.get<boolean>('enabled', true),
    timeoutMs: c.get<number>('timeoutMs', 2000),
    includeTests: c.get<boolean>('includeTests', false),
    codeLensHandlers: c.get<boolean>('codeLens.handlers', false),
    excludeGlobs: c.get<string[]>('excludeGlobs', ['**/*.pb.go']),
    trace: c.get<TraceLevel>('trace', 'off'),
  };
}
```

- [ ] **Step 8: Implement the extension entry point and the measurement command**

`src/extension.ts`:

```ts
import * as vscode from 'vscode';
import { Logger } from './vscode/log';
import { readConfig } from './vscode/config';

let logger: Logger | undefined;

export function activate(context: vscode.ExtensionContext): void {
  logger = new Logger(() => readConfig().trace);
  context.subscriptions.push(logger);

  context.subscriptions.push(
    vscode.commands.registerCommand('gorpcLens.measureLatency', () => measureLatency(logger!)),
  );
}

export function deactivate(): void {
  logger?.dispose();
  logger = undefined;
}

const SAMPLE_COUNT = 10;

async function measureLatency(log: Logger): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('gorpc-lens: no active editor.');
    return;
  }

  const uri = editor.document.uri;
  const pos = editor.selection.active;
  const samples: number[] = [];

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'gorpc-lens: measuring gopls latency' },
    async () => {
      for (let i = 0; i < SAMPLE_COUNT; i++) {
        const t0 = Date.now();
        const raw = await vscode.commands.executeCommand<unknown[]>(
          'vscode.executeImplementationProvider',
          uri,
          pos,
        );
        const elapsed = Date.now() - t0;
        samples.push(elapsed);
        log.error('measure', `sample ${i + 1}: ${elapsed}ms, ${raw?.length ?? 0} results`);
      }
    },
  );

  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length * 0.5)];
  const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))];
  const summary = `p50=${p50}ms p95=${p95}ms min=${samples[0]}ms max=${samples[samples.length - 1]}ms`;

  log.error('measure', summary);
  log.show();
  vscode.window.showInformationMessage(`gorpc-lens latency: ${summary}`);
}
```

`log.error` is used deliberately here rather than `log.trace`: measurement output must appear regardless of the `trace` setting, and this command is removed in Task 15.

- [ ] **Step 9: Build and verify the extension loads**

```bash
npm run build
```

Expected: `dist/extension.js` written with no errors.

- [ ] **Step 10: Take the measurement — this is the task's real deliverable**

Open the extension in VS Code and press F5 to launch an Extension Development Host. In that window:

1. Open the folder `<monorepo>`.
2. Wait for the Go extension's status bar to settle — gopls must be fully warm or the numbers are meaningless.
3. Open `protos/order-svc/order_service_grpc.pb.go`, go to line 674, and put the cursor on the word `ListOrders`.
4. Run **gorpc-lens: Measure gopls Latency (dev)** from the Command Palette.

Record the reported p50/p95 in the "Measured latency" section of `README.md` (created in Task 15 — for now, note it in the commit message).

**Decision gate:** if p95 is under ~500ms, the design stands as written and the rest of the plan proceeds unchanged. If p95 exceeds roughly 1.5s, stop and report the number before continuing — the spec's fallback is the hybrid index (approach C in the design doc), and that is a design change, not something to improvise mid-plan.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat: scaffold extension, test harness, and gopls latency probe"
```

---

### Task 2: The generated-file parser

The only module in the extension that knows Go syntax. Everything else depends on its output being right, so it gets real fixtures.

**Files:**
- Create: `src/core/pbFile.ts`
- Create: `test/fixtures/pb/order_service_grpc.pb.go` (trimmed copy of the real file)
- Create: `test/fixtures/pb/streaming_grpc.pb.go`
- Create: `test/fixtures/pb/empty_grpc.pb.go`
- Test: `test/unit/pbFile.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface MethodRef { name: string; line: number; character: number }`
  - `interface ServiceInterface { name: string; methods: Map<string, MethodRef> }`
  - `interface ServiceModel { name: string; client?: ServiceInterface; server?: ServiceInterface }`
  - `interface PbFileModel { protoSource?: string; services: Map<string, ServiceModel> }`
  - `function parsePbFile(text: string): PbFileModel`
  - `function stripLineComment(line: string): string`
  - `function isGeneratedGrpcFile(path: string): boolean`

- [ ] **Step 1: Create the fixtures**

Build the primary fixture from the real file so the parser is tested against production shapes, including the multi-paragraph doc comments between methods that break naive scanners:

```bash
mkdir -p test/fixtures/pb
sed -n '1,10p;673,700p' \
  <monorepo>/protos/order-svc/order_service_grpc.pb.go \
  > /tmp/head.txt
cat /tmp/head.txt
```

Inspect the output, then hand-assemble `test/fixtures/pb/order_service_grpc.pb.go` so it contains, in this order: the real 5-line header comment (including `// source: order-svc/order_service.proto`), `package pbOrder`, a `OrderServiceClient` interface holding `ListOrders` and `CountOrdersByStatus`, a `OrderServiceServer` interface holding the same two methods **with the real multi-paragraph doc comment preserved between them**, an `UnimplementedOrderServiceServer` struct, and an `UnsafeOrderServiceServer` interface. The exact line numbers do not matter; the test reads them from the parse.

`test/fixtures/pb/streaming_grpc.pb.go`:

```go
// Code generated by protoc-gen-go-grpc. DO NOT EDIT.
// source: feed/feed_service.proto

package pbFeed

type FeedServiceClient interface {
	Subscribe(ctx context.Context, in *SubscribeRequest, opts ...grpc.CallOption) (grpc.ServerStreamingClient[Event], error)
}

type FeedServiceServer interface {
	Subscribe(*SubscribeRequest, grpc.ServerStreamingServer[Event]) error
	mustEmbedUnimplementedFeedServiceServer()
}
```

`test/fixtures/pb/empty_grpc.pb.go`:

```go
// Code generated by protoc-gen-go-grpc. DO NOT EDIT.
// source: nothing/nothing.proto

package pbNothing

type NothingServiceClient interface{}

type NothingServiceServer interface {
	mustEmbedUnimplementedNothingServiceServer()
}
```

- [ ] **Step 2: Write the failing tests**

`test/unit/pbFile.test.ts`:

```ts
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
```

- [ ] **Step 3: Run the tests and watch them fail**

```bash
npm run test:unit
```

Expected: FAIL — `Cannot find module '../../src/core/pbFile'`.

- [ ] **Step 4: Implement the parser**

`src/core/pbFile.ts`:

```ts
export interface MethodRef {
  name: string;
  line: number;
  character: number;
}

export interface ServiceInterface {
  name: string;
  methods: Map<string, MethodRef>;
}

export interface ServiceModel {
  name: string;
  client?: ServiceInterface;
  server?: ServiceInterface;
}

export interface PbFileModel {
  protoSource?: string;
  services: Map<string, ServiceModel>;
}

const SOURCE_COMMENT = /^\/\/\s*source:\s*(\S+)\s*$/;
const INTERFACE_START = /^type\s+(\w+)\s+interface\s*\{/;
const METHOD_LINE = /^\s+([A-Z]\w*)\s*\(/;

export function isGeneratedGrpcFile(filePath: string): boolean {
  return filePath.endsWith('_grpc.pb.go');
}

export function stripLineComment(line: string): string {
  const idx = line.indexOf('//');
  return idx === -1 ? line : line.slice(0, idx);
}

export function parsePbFile(text: string): PbFileModel {
  const lines = text.split(/\r?\n/);
  const services = new Map<string, ServiceModel>();
  let protoSource: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    if (protoSource === undefined) {
      const src = SOURCE_COMMENT.exec(lines[i]);
      if (src) {
        protoSource = src[1];
        continue;
      }
    }

    const start = INTERFACE_START.exec(lines[i]);
    if (!start) {
      continue;
    }

    const typeName = start[1];
    const methods = new Map<string, MethodRef>();

    // The opening brace is on the start line; anything after it counts too,
    // so `type X interface{}` closes immediately.
    const openIdx = lines[i].indexOf('{');
    let depth = 1;
    depth += braceDelta(stripLineComment(lines[i].slice(openIdx + 1)));

    let j = i;
    while (depth > 0 && ++j < lines.length) {
      const code = stripLineComment(lines[j]);
      if (depth === 1) {
        const m = METHOD_LINE.exec(code);
        if (m) {
          methods.set(m[1], { name: m[1], line: j, character: code.indexOf(m[1]) });
        }
      }
      depth += braceDelta(code);
    }
    i = j;

    const role = interfaceRole(typeName);
    if (!role) {
      continue;
    }

    const svc = services.get(role.service) ?? { name: role.service };
    if (role.kind === 'client') {
      svc.client = { name: typeName, methods };
    } else {
      svc.server = { name: typeName, methods };
    }
    services.set(role.service, svc);
  }

  return { protoSource, services };
}

function braceDelta(code: string): number {
  let delta = 0;
  for (const ch of code) {
    if (ch === '{') {
      delta++;
    } else if (ch === '}') {
      delta--;
    }
  }
  return delta;
}

function interfaceRole(typeName: string): { kind: 'client' | 'server'; service: string } | undefined {
  if (typeName.startsWith('Unsafe') || typeName.startsWith('Unimplemented')) {
    return undefined;
  }
  if (typeName.endsWith('Client')) {
    return { kind: 'client', service: typeName.slice(0, -'Client'.length) };
  }
  if (typeName.endsWith('Server')) {
    return { kind: 'server', service: typeName.slice(0, -'Server'.length) };
  }
  return undefined;
}
```

Three assumptions worth knowing, all safe against generated code and all covered by the tests above: method names in a gRPC interface are exported, so the leading-uppercase requirement in `METHOD_LINE` skips `mustEmbedUnimplementedXxxServer()` for free; interface bodies contain no string literals, so stripping at the first `//` cannot corrupt a brace count; and doc comments are stripped before brace counting, so prose containing `{` is harmless.

- [ ] **Step 5: Run the tests and watch them pass**

```bash
npm run test:unit
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): parse generated grpc pb.go into a service model"
```

---

### Task 3: Position classification

**Files:**
- Create: `src/core/locator.ts`
- Test: `test/unit/locator.test.ts`

**Interfaces:**
- Consumes: `PbFileModel`, `MethodRef` from `src/core/pbFile`.
- Produces:
  - `type Role = 'client' | 'server'`
  - `interface RpcSite { service: string; method: string; role: Role; clientMethod?: MethodRef; serverMethod?: MethodRef; protoSource?: string }`
  - `function classify(model: PbFileModel, line: number, character: number): RpcSite | undefined`

- [ ] **Step 1: Write the failing tests**

`test/unit/locator.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
npm run test:unit
```

Expected: FAIL — `Cannot find module '../../src/core/locator'`.

- [ ] **Step 3: Implement the classifier**

`src/core/locator.ts`:

```ts
import { MethodRef, PbFileModel } from './pbFile';

export type Role = 'client' | 'server';

export interface RpcSite {
  service: string;
  method: string;
  role: Role;
  clientMethod?: MethodRef;
  serverMethod?: MethodRef;
  protoSource?: string;
}

export function classify(model: PbFileModel, line: number, character: number): RpcSite | undefined {
  for (const svc of model.services.values()) {
    for (const role of ['client', 'server'] as const) {
      const iface = role === 'client' ? svc.client : svc.server;
      if (!iface) {
        continue;
      }
      for (const m of iface.methods.values()) {
        if (m.line !== line) {
          continue;
        }
        if (character < m.character || character > m.character + m.name.length) {
          continue;
        }
        return {
          service: svc.name,
          method: m.name,
          role,
          clientMethod: svc.client?.methods.get(m.name),
          serverMethod: svc.server?.methods.get(m.name),
          protoSource: model.protoSource,
        };
      }
    }
  }
  return undefined;
}
```

The inclusive upper bound (`character > m.character + m.name.length` rejects, so the position immediately after the name is accepted) matches how gopls reports a definition range end and how VS Code reports a cursor sitting at the end of a word.

- [ ] **Step 4: Run the tests and watch them pass**

```bash
npm run test:unit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): classify a position inside a generated grpc interface"
```

---

### Task 4: Glob matching

Hand-rolled because of the zero-runtime-dependency constraint. Scope is deliberately small: the patterns it must handle are the ones users put in `gorpcLens.excludeGlobs`.

**Files:**
- Create: `src/core/glob.ts`
- Test: `test/unit/glob.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `function globToRegExp(pattern: string): RegExp`; `function matchGlob(filePath: string, pattern: string): boolean`.

- [ ] **Step 1: Write the failing tests**

`test/unit/glob.test.ts`:

```ts
import * as assert from 'assert';
import { matchGlob } from '../../src/core/glob';

describe('matchGlob', () => {
  it('matches the default exclude against a nested generated file', () => {
    assert.strictEqual(matchGlob('/repo/protos/x/y_grpc.pb.go', '**/*.pb.go'), true);
  });

  it('matches a generated file at the root', () => {
    assert.strictEqual(matchGlob('y.pb.go', '**/*.pb.go'), true);
  });

  it('does not match hand-written go', () => {
    assert.strictEqual(matchGlob('/repo/svc/handler.go', '**/*.pb.go'), false);
  });

  it('keeps a single star inside one path segment', () => {
    assert.strictEqual(matchGlob('/repo/a/b.go', '/repo/*/b.go'), true);
    assert.strictEqual(matchGlob('/repo/a/c/b.go', '/repo/*/b.go'), false);
  });

  it('treats dots literally rather than as regex wildcards', () => {
    assert.strictEqual(matchGlob('/repo/axpb!go', '**/*.pb.go'), false);
  });

  it('supports ? as a single non-separator character', () => {
    assert.strictEqual(matchGlob('/repo/a1.go', '/repo/a?.go'), true);
    assert.strictEqual(matchGlob('/repo/a/.go', '/repo/a?.go'), false);
  });

  it('supports a trailing ** as match-anything', () => {
    assert.strictEqual(matchGlob('/repo/vendor/x/y.go', '/repo/vendor/**'), true);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
npm run test:unit
```

Expected: FAIL — `Cannot find module '../../src/core/glob'`.

- [ ] **Step 3: Implement the matcher**

`src/core/glob.ts`:

```ts
const SPECIAL = /[.+^${}()|[\]\\]/g;

export function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          // `**/` spans zero or more whole path segments.
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(SPECIAL, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

export function matchGlob(filePath: string, pattern: string): boolean {
  return globToRegExp(pattern).test(filePath);
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
npm run test:unit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): add a dependency-free glob matcher"
```

---

### Task 5: Result filtering

**Files:**
- Create: `src/core/filters.ts`
- Test: `test/unit/filters.test.ts`

**Interfaces:**
- Consumes: `matchGlob` from `src/core/glob`.
- Produces:
  - `interface FilterOptions { excludeGlobs: string[]; includeTests: boolean }`
  - `function filterByPath<T extends { path: string }>(results: T[], opts: FilterOptions): T[]`
  - `function filterByReceiver<T extends { receiverType?: string }>(results: T[]): T[]`
  - `function receiverTypeFromLine(line: string): string | undefined`

Two filters rather than one, because the path filter is free and the receiver filter costs a file read per surviving result. The resolver runs the cheap one first.

- [ ] **Step 1: Write the failing tests**

`test/unit/filters.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
npm run test:unit
```

Expected: FAIL — `Cannot find module '../../src/core/filters'`.

- [ ] **Step 3: Implement the filters**

`src/core/filters.ts`:

```ts
import { matchGlob } from './glob';

export interface FilterOptions {
  excludeGlobs: string[];
  includeTests: boolean;
}

const STUB_RECEIVER = /^(Unimplemented|Unsafe)/;
const RECEIVER = /^func\s*\(\s*\w+\s+\*?(\w+)\s*\)/;

export function filterByPath<T extends { path: string }>(results: T[], opts: FilterOptions): T[] {
  return results.filter((r) => {
    if (!opts.includeTests && r.path.endsWith('_test.go')) {
      return false;
    }
    return !opts.excludeGlobs.some((g) => matchGlob(r.path, g));
  });
}

export function filterByReceiver<T extends { receiverType?: string }>(results: T[]): T[] {
  return results.filter((r) => r.receiverType === undefined || !STUB_RECEIVER.test(r.receiverType));
}

export function receiverTypeFromLine(line: string): string | undefined {
  return RECEIVER.exec(line)?.[1];
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
npm run test:unit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): filter generated, test, and stub results"
```

---
### Task 6: Core LSP types and primitives

**Files:**
- Create: `src/core/types.ts`
- Create: `src/core/lsp.ts`
- Test: `test/unit/lsp.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface Pos { line: number; character: number }`
  - `interface Loc { path: string; line: number; character: number }`
  - `interface Logger { trace(stage: string, detail: string, ms?: number): void; error(stage: string, err: unknown): void }`
  - `interface LspClient { definitions(path: string, pos: Pos): Promise<Loc[]>; implementations(path: string, pos: Pos): Promise<Loc[]>; references(path: string, pos: Pos): Promise<Loc[]>; documentText(path: string): Promise<string | undefined>; lineText(path: string, line: number): Promise<string | undefined> }`
  - `function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined>`
  - `function normalizeRawLocations(raw: unknown): Loc[]`
  - `class ResolveCache { get(key: string): Loc[] | undefined; set(key: string, v: Loc[]): void; clear(): void; static key(direction: string, path: string, line: number, character: number): string }`

`normalizeRawLocations` exists because `vscode.executeDefinitionProvider` returns `Location[]` from some providers and `LocationLink[]` from others, and gopls is free to change which. It is written against structural shapes with no `vscode` import, so it stays unit-testable.

- [ ] **Step 1: Write the failing tests**

`test/unit/lsp.test.ts`:

```ts
import * as assert from 'assert';
import { normalizeRawLocations, withTimeout, ResolveCache } from '../../src/core/lsp';

describe('normalizeRawLocations', () => {
  it('reads a plain Location', () => {
    const raw = [{ uri: { fsPath: '/a/b.go' }, range: { start: { line: 3, character: 7 } } }];
    assert.deepStrictEqual(normalizeRawLocations(raw), [{ path: '/a/b.go', line: 3, character: 7 }]);
  });

  it('prefers targetSelectionRange on a LocationLink', () => {
    const raw = [
      {
        targetUri: { fsPath: '/a/b.go' },
        targetRange: { start: { line: 1, character: 0 } },
        targetSelectionRange: { start: { line: 3, character: 7 } },
      },
    ];
    assert.deepStrictEqual(normalizeRawLocations(raw), [{ path: '/a/b.go', line: 3, character: 7 }]);
  });

  it('falls back to targetRange when there is no selection range', () => {
    const raw = [{ targetUri: { fsPath: '/a/b.go' }, targetRange: { start: { line: 1, character: 2 } } }];
    assert.deepStrictEqual(normalizeRawLocations(raw), [{ path: '/a/b.go', line: 1, character: 2 }]);
  });

  it('returns an empty array for null, undefined, or a non-array', () => {
    assert.deepStrictEqual(normalizeRawLocations(null), []);
    assert.deepStrictEqual(normalizeRawLocations(undefined), []);
    assert.deepStrictEqual(normalizeRawLocations({}), []);
  });

  it('skips malformed entries rather than throwing', () => {
    assert.deepStrictEqual(normalizeRawLocations([{ uri: { fsPath: '/a.go' } }, null]), []);
  });
});

describe('withTimeout', () => {
  it('returns the value when the promise wins', async () => {
    assert.strictEqual(await withTimeout(Promise.resolve(5), 1000), 5);
  });

  it('returns undefined when the deadline wins', async () => {
    const slow = new Promise<number>((r) => setTimeout(() => r(5), 200));
    assert.strictEqual(await withTimeout(slow, 10), undefined);
  });

  it('returns undefined rather than rejecting when the promise fails', async () => {
    assert.strictEqual(await withTimeout(Promise.reject(new Error('boom')), 1000), undefined);
  });
});

describe('ResolveCache', () => {
  it('round-trips a value under a composed key', () => {
    const c = new ResolveCache();
    const key = ResolveCache.key('handlers', '/a/b_grpc.pb.go', 10, 2);
    c.set(key, [{ path: '/x.go', line: 1, character: 1 }]);
    assert.strictEqual(c.get(key)?.length, 1);
  });

  it('distinguishes directions at the same position', () => {
    const c = new ResolveCache();
    c.set(ResolveCache.key('handlers', '/a.go', 1, 1), []);
    assert.strictEqual(c.get(ResolveCache.key('callers', '/a.go', 1, 1)), undefined);
  });

  it('drops everything on clear', () => {
    const c = new ResolveCache();
    const key = ResolveCache.key('handlers', '/a.go', 1, 1);
    c.set(key, []);
    c.clear();
    assert.strictEqual(c.get(key), undefined);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
npm run test:unit
```

Expected: FAIL — `Cannot find module '../../src/core/lsp'`.

- [ ] **Step 3: Implement the types**

`src/core/types.ts`:

```ts
export interface Pos {
  line: number;
  character: number;
}

export interface Loc {
  path: string;
  line: number;
  character: number;
}

export interface Logger {
  trace(stage: string, detail: string, ms?: number): void;
  error(stage: string, err: unknown): void;
}

export interface LspClient {
  definitions(path: string, pos: Pos): Promise<Loc[]>;
  implementations(path: string, pos: Pos): Promise<Loc[]>;
  references(path: string, pos: Pos): Promise<Loc[]>;
  documentText(path: string): Promise<string | undefined>;
  lineText(path: string, line: number): Promise<string | undefined>;
}
```

- [ ] **Step 4: Implement the primitives**

`src/core/lsp.ts`:

```ts
import { Loc } from './types';

interface RawUri {
  fsPath?: string;
}

interface RawRange {
  start?: { line?: number; character?: number };
}

interface RawLocation {
  uri?: RawUri;
  range?: RawRange;
  targetUri?: RawUri;
  targetRange?: RawRange;
  targetSelectionRange?: RawRange;
}

export function normalizeRawLocations(raw: unknown): Loc[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: Loc[] = [];
  for (const entry of raw as RawLocation[]) {
    if (!entry) {
      continue;
    }
    const uri = entry.targetUri ?? entry.uri;
    const range = entry.targetUri
      ? entry.targetSelectionRange ?? entry.targetRange
      : entry.range;
    const path = uri?.fsPath;
    const line = range?.start?.line;
    const character = range?.start?.character;
    if (path === undefined || line === undefined || character === undefined) {
      continue;
    }
    out.push({ path, line, character });
  }
  return out;
}

export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([p.catch(() => undefined), deadline]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export class ResolveCache {
  private readonly map = new Map<string, Loc[]>();

  static key(direction: string, path: string, line: number, character: number): string {
    return `${direction}:${path}:${line}:${character}`;
  }

  get(key: string): Loc[] | undefined {
    return this.map.get(key);
  }

  set(key: string, value: Loc[]): void {
    this.map.set(key, value);
  }

  clear(): void {
    this.map.clear();
  }
}
```

`withTimeout` swallows rejections into `undefined` on purpose: a gopls error and a gopls timeout are the same thing to every caller — contribute nothing.

- [ ] **Step 5: Run the tests and watch them pass**

```bash
npm run test:unit
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): add LSP types, timeout, normalization, and cache"
```

---

### Task 7: The resolver

**Files:**
- Create: `src/core/resolver.ts`
- Test: `test/unit/resolver.test.ts`

**Interfaces:**
- Consumes: `Loc`, `Pos`, `Logger`, `LspClient` from `src/core/types`; `withTimeout`, `ResolveCache` from `src/core/lsp`; `filterByPath`, `filterByReceiver`, `receiverTypeFromLine`, `FilterOptions` from `src/core/filters`; `MethodRef` from `src/core/pbFile`.
- Produces:
  - `interface ResolverOptions extends FilterOptions { timeoutMs: number }`
  - `class Resolver { constructor(lsp: LspClient, opts: () => ResolverOptions, log: Logger, cache?: ResolveCache); handlersFor(pbPath: string, serverMethod: MethodRef): Promise<Loc[]>; callersFor(pbPath: string, clientMethod: MethodRef): Promise<Loc[]>; clearCache(): void }`

- [ ] **Step 1: Write the failing tests**

`test/unit/resolver.test.ts`:

```ts
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
        { path: '/r/mnt/handler.go', line: 47, character: 30 },
      ],
      [],
      { '/r/mnt/handler.go:47': 'func (h *EchoHandler) Echo(ctx context.Context) error {' },
    );
    const r = new Resolver(lsp, () => OPTS, SILENT);
    const out = await r.handlersFor('/r/pb/echo_grpc.pb.go', SERVER_METHOD);
    assert.deepStrictEqual(out, [{ path: '/r/mnt/handler.go', line: 47, character: 30 }]);
  });

  it('drops a stub receiver even outside a pb.go file', async () => {
    const lsp = new FakeLsp(
      [{ path: '/r/mnt/stub.go', line: 5, character: 20 }],
      [],
      { '/r/mnt/stub.go:5': 'func (UnimplementedEchoServiceServer) Echo() {}' },
    );
    const r = new Resolver(lsp, () => OPTS, SILENT);
    assert.deepStrictEqual(await r.handlersFor('/r/pb/echo_grpc.pb.go', SERVER_METHOD), []);
  });

  it('serves the second call from cache', async () => {
    const lsp = new FakeLsp([{ path: '/r/mnt/handler.go', line: 47, character: 30 }]);
    const r = new Resolver(lsp, () => OPTS, SILENT);
    await r.handlersFor('/r/pb/echo_grpc.pb.go', SERVER_METHOD);
    await r.handlersFor('/r/pb/echo_grpc.pb.go', SERVER_METHOD);
    assert.strictEqual(lsp.implementationCalls, 1);
  });

  it('re-queries after clearCache', async () => {
    const lsp = new FakeLsp([{ path: '/r/mnt/handler.go', line: 47, character: 30 }]);
    const r = new Resolver(lsp, () => OPTS, SILENT);
    await r.handlersFor('/r/pb/echo_grpc.pb.go', SERVER_METHOD);
    r.clearCache();
    await r.handlersFor('/r/pb/echo_grpc.pb.go', SERVER_METHOD);
    assert.strictEqual(lsp.implementationCalls, 2);
  });

  it('returns nothing on timeout and does not cache the miss', async () => {
    const lsp = new FakeLsp([{ path: '/r/mnt/handler.go', line: 47, character: 30 }], [], {}, 100);
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
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
npm run test:unit
```

Expected: FAIL — `Cannot find module '../../src/core/resolver'`.

- [ ] **Step 3: Implement the resolver**

`src/core/resolver.ts`:

```ts
import { Loc, Logger, LspClient, Pos } from './types';
import { ResolveCache, withTimeout } from './lsp';
import { FilterOptions, filterByPath, filterByReceiver, receiverTypeFromLine } from './filters';
import { MethodRef } from './pbFile';

export type Direction = 'handlers' | 'callers';

export interface ResolverOptions extends FilterOptions {
  timeoutMs: number;
}

type Query = (path: string, pos: Pos) => Promise<Loc[]>;

export class Resolver {
  constructor(
    private readonly lsp: LspClient,
    private readonly opts: () => ResolverOptions,
    private readonly log: Logger,
    private readonly cache: ResolveCache = new ResolveCache(),
  ) {}

  clearCache(): void {
    this.cache.clear();
  }

  handlersFor(pbPath: string, serverMethod: MethodRef): Promise<Loc[]> {
    return this.run('handlers', pbPath, serverMethod, (p, pos) => this.lsp.implementations(p, pos));
  }

  callersFor(pbPath: string, clientMethod: MethodRef): Promise<Loc[]> {
    return this.run('callers', pbPath, clientMethod, (p, pos) => this.lsp.references(p, pos));
  }

  private async run(
    direction: Direction,
    pbPath: string,
    method: MethodRef,
    query: Query,
  ): Promise<Loc[]> {
    const key = ResolveCache.key(direction, pbPath, method.line, method.character);
    const hit = this.cache.get(key);
    if (hit) {
      this.log.trace(direction, `cache hit ${key}`);
      return hit;
    }

    const opts = this.opts();
    const pos: Pos = { line: method.line, character: method.character };
    const started = Date.now();
    const raw = await withTimeout(query(pbPath, pos), opts.timeoutMs);
    if (raw === undefined) {
      this.log.trace(direction, `no answer within ${opts.timeoutMs}ms`, Date.now() - started);
      return [];
    }
    this.log.trace(direction, `${raw.length} raw results`, Date.now() - started);

    const byPath = filterByPath(raw, opts);
    const enriched = await Promise.all(
      byPath.map(async (loc) => ({
        ...loc,
        receiverType: receiverTypeFromLine((await this.lsp.lineText(loc.path, loc.line)) ?? ''),
      })),
    );
    const kept = filterByReceiver(enriched).map(({ path, line, character }) => ({
      path,
      line,
      character,
    }));

    this.log.trace(direction, `${kept.length} kept`);
    this.cache.set(key, kept);
    return kept;
  }
}
```

A timeout is deliberately not cached. Caching it would turn one slow moment into a session-long dead feature.

- [ ] **Step 4: Run the tests and watch them pass**

```bash
npm run test:unit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): resolve handlers and callers through gopls with cache and timeout"
```

---

### Task 8: The pipeline

Turns "a position in some Go file" into "a service and method in a generated file", trying up to three stages in order.

**Files:**
- Create: `src/core/pipeline.ts`
- Test: `test/unit/pipeline.test.ts`

**Interfaces:**
- Consumes: `Loc`, `Pos`, `Logger`, `LspClient` from `src/core/types`; `parsePbFile`, `isGeneratedGrpcFile`, `PbFileModel` from `src/core/pbFile`; `classify`, `RpcSite` from `src/core/locator`.
- Produces:
  - `type Stage = 'self' | 'definition' | 'implementation'`
  - `const PROVIDER_STAGES: Stage[]` = `['self', 'definition']`
  - `const COMMAND_STAGES: Stage[]` = `['self', 'definition', 'implementation']`
  - `interface ResolvedSite { site: RpcSite; pbPath: string }`
  - `class Pipeline { constructor(lsp: LspClient, log: Logger); siteAt(path: string, pos: Pos, stages: Stage[]): Promise<ResolvedSite | undefined>; invalidate(): void }`

Providers get only `PROVIDER_STAGES`. The `implementation` stage is what recognises "the cursor is on a handler method", and running it on every Ctrl+Click would spend a workspace-wide gopls query on every non-gRPC method call in the repo. Commands, which the user invoked deliberately, get all three.

- [ ] **Step 1: Write the failing tests**

`test/unit/pipeline.test.ts`:

```ts
import * as assert from 'assert';
import { Pipeline, PROVIDER_STAGES, COMMAND_STAGES } from '../../src/core/pipeline';
import { Loc, Logger, LspClient, Pos } from '../../src/core/types';

const SILENT: Logger = { trace: () => undefined, error: () => undefined };

const PB_PATH = '/r/pb/echo_grpc.pb.go';
const PB_TEXT = [
  '// Code generated by protoc-gen-go-grpc. DO NOT EDIT.',
  '// source: pb/echo.proto',
  '',
  'package pb',
  '',
  'type EchoServiceClient interface {',
  '\tEcho(ctx context.Context, in *EchoRequest) (*EchoResponse, error)',
  '}',
  '',
  'type EchoServiceServer interface {',
  '\tEcho(context.Context, *EchoRequest) (*EchoResponse, error)',
  '}',
].join('\n');

const CLIENT_LINE = 6;
const SERVER_LINE = 10;

class FakeLsp implements LspClient {
  definitionCalls = 0;
  implementationCalls = 0;

  constructor(
    private readonly defs: Loc[] = [],
    private readonly impls: Loc[] = [],
  ) {}

  async definitions(_p: string, _pos: Pos): Promise<Loc[]> {
    this.definitionCalls++;
    return this.defs;
  }

  async implementations(_p: string, _pos: Pos): Promise<Loc[]> {
    this.implementationCalls++;
    return this.impls;
  }

  async references(): Promise<Loc[]> {
    return [];
  }

  async documentText(path: string): Promise<string | undefined> {
    return path === PB_PATH ? PB_TEXT : undefined;
  }

  async lineText(): Promise<string | undefined> {
    return undefined;
  }
}

describe('Pipeline.siteAt', () => {
  it('resolves directly when the cursor is already inside the generated file', async () => {
    const lsp = new FakeLsp();
    const p = new Pipeline(lsp, SILENT);
    const r = await p.siteAt(PB_PATH, { line: CLIENT_LINE, character: 1 }, PROVIDER_STAGES);
    assert.strictEqual(r?.site.method, 'Echo');
    assert.strictEqual(r?.site.role, 'client');
    assert.strictEqual(lsp.definitionCalls, 0, 'self stage must not call gopls');
  });

  it('follows a definition from a call site into the client interface', async () => {
    const lsp = new FakeLsp([{ path: PB_PATH, line: CLIENT_LINE, character: 1 }]);
    const p = new Pipeline(lsp, SILENT);
    const r = await p.siteAt('/r/biz/order.go', { line: 94, character: 40 }, PROVIDER_STAGES);
    assert.strictEqual(r?.pbPath, PB_PATH);
    assert.strictEqual(r?.site.role, 'client');
    assert.strictEqual(r?.site.serverMethod?.line, SERVER_LINE);
  });

  it('does not run the implementation stage for providers', async () => {
    const lsp = new FakeLsp([], [{ path: PB_PATH, line: SERVER_LINE, character: 1 }]);
    const p = new Pipeline(lsp, SILENT);
    const r = await p.siteAt('/r/mnt/handler.go', { line: 47, character: 30 }, PROVIDER_STAGES);
    assert.strictEqual(r, undefined);
    assert.strictEqual(lsp.implementationCalls, 0);
  });

  it('recognises a handler method when the implementation stage is allowed', async () => {
    const lsp = new FakeLsp([], [{ path: PB_PATH, line: SERVER_LINE, character: 1 }]);
    const p = new Pipeline(lsp, SILENT);
    const r = await p.siteAt('/r/mnt/handler.go', { line: 47, character: 30 }, COMMAND_STAGES);
    assert.strictEqual(r?.site.role, 'server');
    assert.strictEqual(r?.site.clientMethod?.line, CLIENT_LINE);
  });

  it('ignores definitions that land outside a generated grpc file', async () => {
    const lsp = new FakeLsp([{ path: '/r/biz/other.go', line: 1, character: 1 }]);
    const p = new Pipeline(lsp, SILENT);
    assert.strictEqual(
      await p.siteAt('/r/biz/order.go', { line: 94, character: 40 }, PROVIDER_STAGES),
      undefined,
    );
  });

  it('parses each generated file once until invalidated', async () => {
    let reads = 0;
    const lsp = new FakeLsp([{ path: PB_PATH, line: CLIENT_LINE, character: 1 }]);
    const orig = lsp.documentText.bind(lsp);
    lsp.documentText = async (path: string) => {
      reads++;
      return orig(path);
    };
    const p = new Pipeline(lsp, SILENT);
    await p.siteAt('/r/biz/a.go', { line: 1, character: 1 }, PROVIDER_STAGES);
    await p.siteAt('/r/biz/b.go', { line: 1, character: 1 }, PROVIDER_STAGES);
    assert.strictEqual(reads, 1);
    p.invalidate();
    await p.siteAt('/r/biz/c.go', { line: 1, character: 1 }, PROVIDER_STAGES);
    assert.strictEqual(reads, 2);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
npm run test:unit
```

Expected: FAIL — `Cannot find module '../../src/core/pipeline'`.

- [ ] **Step 3: Implement the pipeline**

`src/core/pipeline.ts`:

```ts
import { Loc, Logger, LspClient, Pos } from './types';
import { PbFileModel, isGeneratedGrpcFile, parsePbFile } from './pbFile';
import { RpcSite, classify } from './locator';

export type Stage = 'self' | 'definition' | 'implementation';

export const PROVIDER_STAGES: Stage[] = ['self', 'definition'];
export const COMMAND_STAGES: Stage[] = ['self', 'definition', 'implementation'];

export interface ResolvedSite {
  site: RpcSite;
  pbPath: string;
}

export class Pipeline {
  private readonly models = new Map<string, PbFileModel>();

  constructor(
    private readonly lsp: LspClient,
    private readonly log: Logger,
  ) {}

  invalidate(): void {
    this.models.clear();
  }

  async siteAt(path: string, pos: Pos, stages: Stage[]): Promise<ResolvedSite | undefined> {
    if (stages.includes('self') && isGeneratedGrpcFile(path)) {
      const hit = await this.siteIn({ path, line: pos.line, character: pos.character }, 'self');
      if (hit) {
        return hit;
      }
    }

    if (stages.includes('definition')) {
      const hit = await this.firstSiteIn(await this.lsp.definitions(path, pos), 'definition');
      if (hit) {
        return hit;
      }
    }

    if (stages.includes('implementation')) {
      const hit = await this.firstSiteIn(await this.lsp.implementations(path, pos), 'implementation');
      if (hit) {
        return hit;
      }
    }

    return undefined;
  }

  private async firstSiteIn(locs: Loc[], stage: Stage): Promise<ResolvedSite | undefined> {
    for (const loc of locs) {
      const hit = await this.siteIn(loc, stage);
      if (hit) {
        return hit;
      }
    }
    return undefined;
  }

  private async siteIn(loc: Loc, stage: Stage): Promise<ResolvedSite | undefined> {
    if (!isGeneratedGrpcFile(loc.path)) {
      return undefined;
    }
    const model = await this.model(loc.path);
    if (!model) {
      return undefined;
    }
    const site = classify(model, loc.line, loc.character);
    if (!site) {
      return undefined;
    }
    this.log.trace('pipeline', `${stage} hit ${site.service}/${site.method} (${site.role})`);
    return { site, pbPath: loc.path };
  }

  private async model(path: string): Promise<PbFileModel | undefined> {
    const cached = this.models.get(path);
    if (cached) {
      return cached;
    }
    const text = await this.lsp.documentText(path);
    if (text === undefined) {
      return undefined;
    }
    const model = parsePbFile(text);
    this.models.set(path, model);
    return model;
  }
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
npm run test:unit
```

Expected: PASS. The core is now complete and fully unit-tested without a VS Code host.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): resolve a position to a grpc service and method"
```

---

### Task 9: Integration harness and a failing end-to-end test

The only test that can catch a break in the gopls contract. It is written before the provider exists, so it starts red.

**Files:**
- Create: `test/fixtures/workspace/go.work`
- Create: `test/fixtures/workspace/pb/go.mod`, `test/fixtures/workspace/pb/echo_grpc.pb.go`, `test/fixtures/workspace/pb/echo.proto`
- Create: `test/fixtures/workspace/handlersvc/go.mod`, `test/fixtures/workspace/handlersvc/handler.go`
- Create: `test/fixtures/workspace/callersvc/go.mod`, `test/fixtures/workspace/callersvc/biz.go`
- Create: `test/integration/runTest.ts`, `test/integration/suite/index.ts`, `test/integration/suite/helpers.ts`, `test/integration/suite/definition.test.ts`
- Modify: `tsconfig.json` (already excludes `test/fixtures`, so the fixture Go files are ignored — verify)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `waitForGopls(doc: vscode.TextDocument, token: string): Promise<void>` and `positionOfToken(doc: vscode.TextDocument, needle: string, token: string): vscode.Position` in `test/integration/suite/helpers.ts`.

**Requirements this task adds to CI:** Go and gopls must be on `PATH`, and the harness installs the `golang.go` extension into the test instance.

- [ ] **Step 1: Create the fixture Go workspace**

`test/fixtures/workspace/go.work`:

```
go 1.21

use (
	./pb
	./handlersvc
	./callersvc
)
```

`test/fixtures/workspace/pb/go.mod`:

```
module example.com/pb

go 1.21
```

`test/fixtures/workspace/pb/echo.proto`:

```proto
syntax = "proto3";

package example.echo;

service EchoService {
  rpc Echo (EchoRequest) returns (EchoResponse) {}
}

message EchoRequest {}
message EchoResponse {}
```

`test/fixtures/workspace/pb/echo_grpc.pb.go`:

```go
// Code generated by protoc-gen-go-grpc. DO NOT EDIT.
// versions:
// - protoc-gen-go-grpc v1.5.1
// - protoc             (unknown)
// source: pb/echo.proto

package pb

import (
	context "context"
)

type EchoRequest struct{}

type EchoResponse struct{}

// EchoServiceClient is the client API for EchoService service.
type EchoServiceClient interface {
	Echo(ctx context.Context, in *EchoRequest) (*EchoResponse, error)
}

// EchoServiceServer is the server API for EchoService service.
type EchoServiceServer interface {
	Echo(context.Context, *EchoRequest) (*EchoResponse, error)
}

type UnimplementedEchoServiceServer struct{}

func (UnimplementedEchoServiceServer) Echo(context.Context, *EchoRequest) (*EchoResponse, error) {
	return nil, nil
}
```

The real generator emits `opts ...grpc.CallOption` on the client method and a `grpc.ServiceRegistrar` registration function. Both are dropped here so the fixture compiles with no module dependencies, which keeps CI offline-capable. Neither affects what is under test: the extension needs two sibling interfaces with matching method sets, and gopls needs a type that implements the server one.

`test/fixtures/workspace/handlersvc/go.mod`:

```
module example.com/handlersvc

go 1.21
```

`test/fixtures/workspace/handlersvc/handler.go`:

```go
package handlersvc

import (
	"context"

	"example.com/pb"
)

type EchoHandler struct{}

var _ pb.EchoServiceServer = (*EchoHandler)(nil)

func (h *EchoHandler) Echo(ctx context.Context, req *pb.EchoRequest) (*pb.EchoResponse, error) {
	return &pb.EchoResponse{}, nil
}
```

`test/fixtures/workspace/callersvc/go.mod`:

```
module example.com/callersvc

go 1.21
```

`test/fixtures/workspace/callersvc/biz.go`:

```go
package callersvc

import (
	"context"

	"example.com/pb"
)

type Biz struct {
	echoClient pb.EchoServiceClient
}

func (b *Biz) Run(ctx context.Context) error {
	_, err := b.echoClient.Echo(ctx, &pb.EchoRequest{})
	return err
}
```

Verify the fixture builds:

```bash
cd test/fixtures/workspace && go build ./... && cd -
```

Expected: no output.

- [ ] **Step 2: Create the test-electron harness**

`test/integration/runTest.ts`:

```ts
import * as path from 'path';
import { spawnSync } from 'child_process';
import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests,
} from '@vscode/test-electron';

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '..', '..', '..');
  const extensionTestsPath = path.resolve(__dirname, 'suite', 'index');
  const workspacePath = path.resolve(extensionDevelopmentPath, 'test', 'fixtures', 'workspace');

  const vscodeExecutablePath = await downloadAndUnzipVSCode('stable');
  const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
  spawnSync(cli, [...cliArgs, '--install-extension', 'golang.go'], {
    encoding: 'utf-8',
    stdio: 'inherit',
  });

  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [workspacePath, '--disable-workspace-trust'],
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

`test/integration/suite/index.ts`:

```ts
import * as path from 'path';
import * as fs from 'fs';
import Mocha from 'mocha';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 180000 });
  const testsRoot = __dirname;
  for (const file of fs.readdirSync(testsRoot)) {
    if (file.endsWith('.test.js')) {
      mocha.addFile(path.join(testsRoot, file));
    }
  }
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} tests failed.`)) : resolve()));
  });
}
```

`test/integration/suite/helpers.ts`:

```ts
import * as assert from 'assert';
import * as vscode from 'vscode';

export function positionOfToken(
  doc: vscode.TextDocument,
  lineNeedle: string,
  token: string,
): vscode.Position {
  for (let i = 0; i < doc.lineCount; i++) {
    const text = doc.lineAt(i).text;
    if (!text.includes(lineNeedle)) {
      continue;
    }
    const col = text.indexOf(token);
    assert.ok(col >= 0, `token "${token}" not on the line containing "${lineNeedle}"`);
    return new vscode.Position(i, col + 1);
  }
  throw new Error(`no line containing "${lineNeedle}"`);
}

/**
 * gopls indexes the workspace asynchronously. Poll a plain definition request
 * until it answers, so tests measure gorpc-lens rather than startup.
 */
export async function waitForGopls(
  doc: vscode.TextDocument,
  pos: vscode.Position,
  timeoutMs = 150000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const locs = await vscode.commands.executeCommand<unknown[]>(
      'vscode.executeDefinitionProvider',
      doc.uri,
      pos,
    );
    if (locs && locs.length > 0) {
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('gopls did not answer a definition request in time');
}

export function pathsOf(locs: unknown[]): string[] {
  return (locs as Array<Record<string, { fsPath?: string }>>)
    .map((l) => (l.targetUri ?? l.uri)?.fsPath)
    .filter((p): p is string => typeof p === 'string');
}
```

- [ ] **Step 3: Write the failing integration test**

`test/integration/suite/definition.test.ts`:

```ts
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { pathsOf, positionOfToken, waitForGopls } from './helpers';

function fixture(...parts: string[]): string {
  return path.resolve(__dirname, '..', '..', '..', '..', 'test', 'fixtures', 'workspace', ...parts);
}

describe('gorpc-lens definition provider', () => {
  it('offers the cross-module handler for a gRPC client call', async () => {
    const doc = await vscode.workspace.openTextDocument(fixture('callersvc', 'biz.go'));
    await vscode.window.showTextDocument(doc);

    const pos = positionOfToken(doc, 'b.echoClient.Echo(', 'Echo(');
    await waitForGopls(doc, pos);

    const locs = await vscode.commands.executeCommand<unknown[]>(
      'vscode.executeDefinitionProvider',
      doc.uri,
      pos,
    );
    const paths = pathsOf(locs ?? []);

    assert.ok(
      paths.some((p) => p.endsWith(path.join('handlersvc', 'handler.go'))),
      `expected a handler.go result, got:\n${paths.join('\n')}`,
    );
  });

  it('still offers the generated interface, so the user gets a choice', async () => {
    const doc = await vscode.workspace.openTextDocument(fixture('callersvc', 'biz.go'));
    await vscode.window.showTextDocument(doc);

    const pos = positionOfToken(doc, 'b.echoClient.Echo(', 'Echo(');
    await waitForGopls(doc, pos);

    const locs = await vscode.commands.executeCommand<unknown[]>(
      'vscode.executeDefinitionProvider',
      doc.uri,
      pos,
    );
    const paths = pathsOf(locs ?? []);

    assert.ok(
      paths.some((p) => p.endsWith('echo_grpc.pb.go')),
      `expected the generated interface among the results, got:\n${paths.join('\n')}`,
    );
  });
});
```

- [ ] **Step 4: Run the integration suite and watch the first test fail**

```bash
npm run test:integration
```

Expected: the second test PASSES (gopls alone already returns the interface) and the first FAILS with `expected a handler.go result` listing only `echo_grpc.pb.go`. That failure is the exact bug gorpc-lens exists to fix, now pinned by a test.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test: add integration harness and a failing cross-module definition test"
```

---

### Task 10: The definition provider

Makes Task 9's failing test pass.

**Files:**
- Create: `src/vscode/lspClient.ts`, `src/vscode/guard.ts`, `src/vscode/definition.ts`
- Modify: `src/extension.ts`
- Test: `test/unit/guard.test.ts`, plus the existing integration test

**Interfaces:**
- Consumes: everything in `src/core/`.
- Produces:
  - `class VsCodeLspClient implements LspClient`
  - `function guardKey(uri: string, pos: { line: number; character: number }): string`
  - `function withGuard<T>(key: string, fn: () => Promise<T>, blocked: T): Promise<T>`
  - `function isCandidateToken(doc: vscode.TextDocument, pos: vscode.Position): boolean`
  - `class GrpcDefinitionProvider implements vscode.DefinitionProvider`
  - `interface Deps { pipeline: Pipeline; resolver: Resolver; config: () => GorpcConfig; log: Logger }`

- [ ] **Step 1: Write the failing guard test**

`test/unit/guard.test.ts`:

```ts
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
```

Note the key is intentionally not namespaced by provider kind. The definition and reference providers share one keyspace, so when the reference provider asks gopls for a definition at a position it already holds, our definition provider recognises the reentry and steps aside instead of duplicating a workspace query.

- [ ] **Step 2: Run the test and watch it fail**

```bash
npm run test:unit
```

Expected: FAIL — `Cannot find module '../../src/vscode/guard'`.

- [ ] **Step 3: Implement the guard**

`src/vscode/guard.ts`:

```ts
const inFlight = new Set<string>();

export function guardKey(uri: string, pos: { line: number; character: number }): string {
  return `${uri}:${pos.line}:${pos.character}`;
}

export async function withGuard<T>(key: string, fn: () => Promise<T>, blocked: T): Promise<T> {
  if (inFlight.has(key)) {
    return blocked;
  }
  inFlight.add(key);
  try {
    return await fn();
  } finally {
    inFlight.delete(key);
  }
}

export function isGuarded(key: string): boolean {
  return inFlight.has(key);
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
npm run test:unit
```

Expected: PASS.

- [ ] **Step 5: Implement the VS Code LSP client**

`src/vscode/lspClient.ts`:

```ts
import * as vscode from 'vscode';
import { Loc, LspClient, Pos } from '../core/types';
import { normalizeRawLocations } from '../core/lsp';

export class VsCodeLspClient implements LspClient {
  definitions(path: string, pos: Pos): Promise<Loc[]> {
    return this.exec('vscode.executeDefinitionProvider', path, pos);
  }

  implementations(path: string, pos: Pos): Promise<Loc[]> {
    return this.exec('vscode.executeImplementationProvider', path, pos);
  }

  references(path: string, pos: Pos): Promise<Loc[]> {
    return this.exec('vscode.executeReferenceProvider', path, pos);
  }

  async documentText(path: string): Promise<string | undefined> {
    const doc = await this.open(path);
    return doc?.getText();
  }

  async lineText(path: string, line: number): Promise<string | undefined> {
    const doc = await this.open(path);
    if (!doc || line < 0 || line >= doc.lineCount) {
      return undefined;
    }
    return doc.lineAt(line).text;
  }

  private async exec(command: string, path: string, pos: Pos): Promise<Loc[]> {
    const raw = await vscode.commands.executeCommand<unknown>(
      command,
      vscode.Uri.file(path),
      new vscode.Position(pos.line, pos.character),
    );
    return normalizeRawLocations(raw);
  }

  private async open(path: string): Promise<vscode.TextDocument | undefined> {
    try {
      return await vscode.workspace.openTextDocument(vscode.Uri.file(path));
    } catch {
      return undefined;
    }
  }
}
```

- [ ] **Step 6: Implement the definition provider**

`src/vscode/definition.ts`:

```ts
import * as vscode from 'vscode';
import { Pipeline, PROVIDER_STAGES } from '../core/pipeline';
import { Resolver } from '../core/resolver';
import { Loc, Logger } from '../core/types';
import { GorpcConfig } from './config';
import { guardKey, withGuard } from './guard';

export interface Deps {
  pipeline: Pipeline;
  resolver: Resolver;
  config: () => GorpcConfig;
  log: Logger;
}

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/;

/**
 * Reject everything that cannot be a gRPC method call before spending an LSP
 * round trip: gRPC methods are exported, and we only care about call sites and
 * interface method declarations, both of which are followed by an open paren.
 */
export function isCandidateToken(doc: vscode.TextDocument, pos: vscode.Position): boolean {
  const range = doc.getWordRangeAtPosition(pos, IDENTIFIER);
  if (!range) {
    return false;
  }
  const word = doc.getText(range);
  if (!/^[A-Z]/.test(word)) {
    return false;
  }
  const rest = doc.getText(new vscode.Range(range.end, doc.lineAt(range.end.line).range.end));
  return /^\s*\(/.test(rest);
}

export function toVsLocation(loc: Loc): vscode.Location {
  return new vscode.Location(
    vscode.Uri.file(loc.path),
    new vscode.Position(loc.line, loc.character),
  );
}

export class GrpcDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly deps: Deps) {}

  async provideDefinition(
    doc: vscode.TextDocument,
    pos: vscode.Position,
  ): Promise<vscode.Location[] | undefined> {
    if (!this.deps.config().enabled || doc.languageId !== 'go') {
      return undefined;
    }
    if (!isCandidateToken(doc, pos)) {
      return undefined;
    }

    return withGuard(
      guardKey(doc.uri.toString(), pos),
      async () => {
        try {
          const resolved = await this.deps.pipeline.siteAt(
            doc.uri.fsPath,
            { line: pos.line, character: pos.character },
            PROVIDER_STAGES,
          );
          const serverMethod = resolved?.site.serverMethod;
          if (!resolved || !serverMethod) {
            return undefined;
          }
          const handlers = await this.deps.resolver.handlersFor(resolved.pbPath, serverMethod);
          return handlers.length ? handlers.map(toVsLocation) : undefined;
        } catch (err) {
          this.deps.log.error('definition', err);
          return undefined;
        }
      },
      undefined,
    );
  }
}
```

- [ ] **Step 7: Wire it into the extension**

Replace `src/extension.ts` with:

```ts
import * as vscode from 'vscode';
import { Logger } from './vscode/log';
import { readConfig } from './vscode/config';
import { VsCodeLspClient } from './vscode/lspClient';
import { Pipeline } from './core/pipeline';
import { Resolver } from './core/resolver';
import { Deps, GrpcDefinitionProvider } from './vscode/definition';

const GO: vscode.DocumentSelector = { language: 'go', scheme: 'file' };

let logger: Logger | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const log = new Logger(() => readConfig().trace);
  logger = log;
  context.subscriptions.push(log);

  const lsp = new VsCodeLspClient();
  const pipeline = new Pipeline(lsp, log);
  const resolver = new Resolver(
    lsp,
    () => {
      const c = readConfig();
      return {
        excludeGlobs: c.excludeGlobs,
        includeTests: c.includeTests,
        timeoutMs: c.timeoutMs,
      };
    },
    log,
  );

  const deps: Deps = { pipeline, resolver, config: readConfig, log };

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(GO, new GrpcDefinitionProvider(deps)),
  );

  // A saved Go file can move a handler or add a new one; drop both caches.
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId === 'go') {
        pipeline.invalidate();
        resolver.clearCache();
        log.trace('cache', `invalidated after saving ${doc.uri.fsPath}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('gorpcLens.measureLatency', () => measureLatency(log)),
  );
}

export function deactivate(): void {
  logger?.dispose();
  logger = undefined;
}
```

Keep the existing `measureLatency` function and its `SAMPLE_COUNT` constant below `deactivate` unchanged; Task 15 removes them.

- [ ] **Step 8: Run both suites**

```bash
npm run test:unit && npm run test:integration
```

Expected: unit PASS; integration PASS, including "offers the cross-module handler for a gRPC client call" which was red in Task 9.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: contribute the gRPC handler to go-to-definition"
```

---
### Task 11: The "Go to gRPC Handler" command

Because gopls always contributes the generated interface, Ctrl+Click always opens a peek list. This command is the direct landing for daily use.

**Files:**
- Create: `src/vscode/commands.ts`
- Modify: `src/core/filters.ts` (add `excludeSelf`)
- Modify: `test/unit/filters.test.ts`
- Modify: `src/extension.ts` (register commands)
- Modify: `package.json` (commands, keybindings, menus)

**Interfaces:**
- Consumes: `Deps` from `src/vscode/definition`; `COMMAND_STAGES` from `src/core/pipeline`.
- Produces:
  - `function excludeSelf<T extends { path: string; line: number }>(results: T[], current: { path: string; line: number }): T[]` in `src/core/filters`
  - `function registerCommands(context: vscode.ExtensionContext, deps: Deps): void` in `src/vscode/commands`
  - `async function goToHandler(deps: Deps): Promise<void>`
  - `async function revealOrPeek(deps: Deps, from: vscode.Uri, at: vscode.Position, targets: Loc[]): Promise<void>`

- [ ] **Step 1: Write the failing test for `excludeSelf`**

Append to `test/unit/filters.test.ts`:

```ts
import { excludeSelf } from '../../src/core/filters';

describe('excludeSelf', () => {
  it('drops the result the cursor is already sitting on', () => {
    const kept = excludeSelf(
      [
        { path: '/r/a.go', line: 47 },
        { path: '/r/b.go', line: 12 },
      ],
      { path: '/r/a.go', line: 47 },
    );
    assert.deepStrictEqual(kept, [{ path: '/r/b.go', line: 12 }]);
  });

  it('ignores the column, since a declaration and a cursor rarely share one', () => {
    assert.strictEqual(excludeSelf([{ path: '/r/a.go', line: 47 }], { path: '/r/a.go', line: 47 }).length, 0);
  });

  it('keeps a same-file result on a different line', () => {
    assert.strictEqual(excludeSelf([{ path: '/r/a.go', line: 9 }], { path: '/r/a.go', line: 47 }).length, 1);
  });
});
```

Also move the existing `import { filterByPath, ... }` line to include `excludeSelf` rather than adding a second import of the same module.

- [ ] **Step 2: Run the test and watch it fail**

```bash
npm run test:unit
```

Expected: FAIL — `excludeSelf is not a function`.

- [ ] **Step 3: Implement `excludeSelf`**

Append to `src/core/filters.ts`:

```ts
export function excludeSelf<T extends { path: string; line: number }>(
  results: T[],
  current: { path: string; line: number },
): T[] {
  return results.filter((r) => !(r.path === current.path && r.line === current.line));
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
npm run test:unit
```

Expected: PASS.

- [ ] **Step 5: Implement the command**

`src/vscode/commands.ts`:

```ts
import * as vscode from 'vscode';
import { COMMAND_STAGES } from '../core/pipeline';
import { excludeSelf } from '../core/filters';
import { Loc } from '../core/types';
import { Deps, toVsLocation } from './definition';

export function registerCommands(context: vscode.ExtensionContext, deps: Deps): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('gorpcLens.goToHandler', () => goToHandler(deps)),
  );
}

export async function goToHandler(deps: Deps): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'go') {
    vscode.window.showWarningMessage('gorpc-lens: put the cursor on a gRPC method in a Go file.');
    return;
  }

  const pos = editor.selection.active;
  const current = { path: editor.document.uri.fsPath, line: pos.line };

  const resolved = await deps.pipeline.siteAt(
    editor.document.uri.fsPath,
    { line: pos.line, character: pos.character },
    COMMAND_STAGES,
  );
  if (!resolved) {
    vscode.window.showWarningMessage('gorpc-lens: this is not a gRPC client call or handler.');
    return;
  }

  const { site, pbPath } = resolved;
  if (!site.serverMethod) {
    vscode.window.showWarningMessage(
      `gorpc-lens: ${site.service} has no server interface in the generated file.`,
    );
    return;
  }

  const handlers = excludeSelf(await deps.resolver.handlersFor(pbPath, site.serverMethod), current);
  if (handlers.length === 0) {
    vscode.window.showWarningMessage(
      `gorpc-lens: no handler found for ${site.service}/${site.method}.`,
    );
    return;
  }

  await revealOrPeek(editor.document.uri, pos, handlers);
}

export async function revealOrPeek(
  from: vscode.Uri,
  at: vscode.Position,
  targets: Loc[],
): Promise<void> {
  if (targets.length === 1) {
    const t = targets[0];
    const target = new vscode.Position(t.line, t.character);
    await vscode.window.showTextDocument(vscode.Uri.file(t.path), {
      selection: new vscode.Range(target, target),
    });
    return;
  }
  await vscode.commands.executeCommand(
    'editor.action.peekLocations',
    from,
    at,
    targets.map(toVsLocation),
    'peek',
  );
}
```

- [ ] **Step 6: Declare the command in the manifest**

In `package.json`, replace `contributes.commands` with:

```json
    "commands": [
      {
        "command": "gorpcLens.measureLatency",
        "title": "gorpc-lens: Measure gopls Latency (dev)"
      },
      {
        "command": "gorpcLens.goToHandler",
        "title": "gorpc-lens: Go to gRPC Handler"
      }
    ],
```

and add, as siblings of `commands` inside `contributes`:

```json
    "keybindings": [
      {
        "command": "gorpcLens.goToHandler",
        "key": "ctrl+alt+h",
        "mac": "cmd+alt+h",
        "when": "editorTextFocus && editorLangId == go"
      }
    ],
    "menus": {
      "editor/context": [
        {
          "submenu": "gorpcLens.submenu",
          "group": "navigation@100",
          "when": "editorLangId == go"
        }
      ],
      "gorpcLens.submenu": [
        { "command": "gorpcLens.goToHandler", "group": "1_nav@1" }
      ],
      "commandPalette": [
        { "command": "gorpcLens.measureLatency", "when": "false" }
      ]
    },
    "submenus": [
      { "id": "gorpcLens.submenu", "label": "gRPC" }
    ],
```

The `commandPalette` entry hides the dev-only measurement command from the palette now that a real command exists; run it from a keybinding or `Developer: Run Command` if it is needed again before Task 15 deletes it.

- [ ] **Step 7: Register the commands at activation**

In `src/extension.ts`, add the import and the call:

```ts
import { registerCommands } from './vscode/commands';
```

and immediately after the `registerDefinitionProvider` push:

```ts
  registerCommands(context, deps);
```

- [ ] **Step 8: Verify manually**

```bash
npm run build
```

Press F5, open `<monorepo>`, open `order-biz/manager/biz/order.go`, put the cursor on `ListOrders` at line 94, press `Ctrl+Alt+H`.

Expected: the editor opens `order-svc/manager/handler/order.go` at line 47 with no intermediate picker.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: add Go to gRPC Handler command with keybinding and context menu"
```

---

### Task 12: Cross-service callers

Shift+F12 on a handler method, plus an explicit command.

**Files:**
- Create: `src/vscode/reference.ts`
- Modify: `src/core/pipeline.ts` (add `REFERENCE_STAGES`)
- Modify: `test/unit/pipeline.test.ts`
- Modify: `src/vscode/commands.ts`, `src/extension.ts`, `package.json`

**Interfaces:**
- Consumes: `Deps`, `toVsLocation` from `src/vscode/definition`.
- Produces:
  - `const REFERENCE_STAGES: Stage[]` = `['self', 'implementation']` in `src/core/pipeline`
  - `class GrpcReferenceProvider implements vscode.ReferenceProvider`
  - `async function findCallers(deps: Deps): Promise<void>` in `src/vscode/commands`

The reference provider uses `['self', 'implementation']` rather than `PROVIDER_STAGES`. The `definition` stage is pointless here: Shift+F12 on a *call site* already resolves to the client interface method, and gopls's own reference search on that method already returns every cross-service call. The only case gopls cannot reach is standing on the *handler*, and that requires the implementation stage. Running an extra implementation query is proportionate for Shift+F12, which is a deliberate and already-expensive action — unlike Ctrl+Click, which people do constantly.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/pipeline.test.ts`:

```ts
import { REFERENCE_STAGES } from '../../src/core/pipeline';

describe('REFERENCE_STAGES', () => {
  it('skips the definition stage but keeps implementation', () => {
    assert.deepStrictEqual(REFERENCE_STAGES, ['self', 'implementation']);
  });

  it('resolves a handler position without asking for definitions', async () => {
    const lsp = new FakeLsp([], [{ path: PB_PATH, line: SERVER_LINE, character: 1 }]);
    const p = new Pipeline(lsp, SILENT);
    const r = await p.siteAt('/r/mnt/handler.go', { line: 47, character: 30 }, REFERENCE_STAGES);
    assert.strictEqual(r?.site.role, 'server');
    assert.strictEqual(lsp.definitionCalls, 0);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
npm run test:unit
```

Expected: FAIL — `REFERENCE_STAGES` is not exported.

- [ ] **Step 3: Add the stage set**

In `src/core/pipeline.ts`, below `COMMAND_STAGES`:

```ts
export const REFERENCE_STAGES: Stage[] = ['self', 'implementation'];
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
npm run test:unit
```

Expected: PASS.

- [ ] **Step 5: Implement the reference provider**

`src/vscode/reference.ts`:

```ts
import * as vscode from 'vscode';
import { REFERENCE_STAGES } from '../core/pipeline';
import { Deps, isCandidateToken, toVsLocation } from './definition';
import { guardKey, withGuard } from './guard';

export class GrpcReferenceProvider implements vscode.ReferenceProvider {
  constructor(private readonly deps: Deps) {}

  async provideReferences(
    doc: vscode.TextDocument,
    pos: vscode.Position,
  ): Promise<vscode.Location[] | undefined> {
    if (!this.deps.config().enabled || doc.languageId !== 'go') {
      return undefined;
    }
    if (!isCandidateToken(doc, pos)) {
      return undefined;
    }

    return withGuard(
      guardKey(doc.uri.toString(), pos),
      async () => {
        try {
          const resolved = await this.deps.pipeline.siteAt(
            doc.uri.fsPath,
            { line: pos.line, character: pos.character },
            REFERENCE_STAGES,
          );
          const clientMethod = resolved?.site.clientMethod;
          if (!resolved || !clientMethod) {
            return undefined;
          }

          // Hold the generated position too: resolving callers runs a
          // reference query there, which would otherwise re-enter this
          // provider and repeat the whole search one level down.
          const pbKey = guardKey(vscode.Uri.file(resolved.pbPath).toString(), clientMethod);
          const callers = await withGuard(
            pbKey,
            () => this.deps.resolver.callersFor(resolved.pbPath, clientMethod),
            [],
          );
          return callers.length ? callers.map(toVsLocation) : undefined;
        } catch (err) {
          this.deps.log.error('references', err);
          return undefined;
        }
      },
      undefined,
    );
  }
}
```

- [ ] **Step 6: Add the command**

In `src/vscode/commands.ts` (`COMMAND_STAGES` is already imported from Task 11),
register the command inside `registerCommands`:

```ts
  context.subscriptions.push(
    vscode.commands.registerCommand('gorpcLens.findCallers', () => findCallers(deps)),
  );
```

and add:

```ts
export async function findCallers(deps: Deps): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'go') {
    vscode.window.showWarningMessage('gorpc-lens: put the cursor on a gRPC method in a Go file.');
    return;
  }

  const pos = editor.selection.active;
  const resolved = await deps.pipeline.siteAt(
    editor.document.uri.fsPath,
    { line: pos.line, character: pos.character },
    COMMAND_STAGES,
  );
  if (!resolved || !resolved.site.clientMethod) {
    vscode.window.showWarningMessage('gorpc-lens: this is not a gRPC client call or handler.');
    return;
  }

  const callers = await deps.resolver.callersFor(resolved.pbPath, resolved.site.clientMethod);
  if (callers.length === 0) {
    vscode.window.showWarningMessage(
      `gorpc-lens: no callers found for ${resolved.site.service}/${resolved.site.method}.`,
    );
    return;
  }

  await vscode.commands.executeCommand(
    'editor.action.showReferences',
    editor.document.uri,
    pos,
    callers.map(toVsLocation),
  );
}
```

The command uses `COMMAND_STAGES`, not `REFERENCE_STAGES`: it is explicit, so it should work from a call site as well as from a handler.

- [ ] **Step 7: Register the provider and declare the command**

In `src/extension.ts`, add:

```ts
import { GrpcReferenceProvider } from './vscode/reference';
```

and next to the definition provider registration:

```ts
  context.subscriptions.push(
    vscode.languages.registerReferenceProvider(GO, new GrpcReferenceProvider(deps)),
  );
```

In `package.json`, add to `contributes.commands`:

```json
      {
        "command": "gorpcLens.findCallers",
        "title": "gorpc-lens: Find gRPC Callers"
      }
```

and to `contributes.menus["gorpcLens.submenu"]`:

```json
        { "command": "gorpcLens.findCallers", "group": "1_nav@2" }
```

- [ ] **Step 8: Verify manually**

```bash
npm run build
```

Press F5, open `<monorepo>`, open `order-svc/manager/handler/order.go`, put the cursor on `ListOrders` at line 47, and run **gorpc-lens: Find gRPC Callers**.

Expected: a references panel listing call sites across `order-biz`, `billing-svc`, `integration-svc`, `invoice-biz`, and `mobile-biz` — matching the 20+ results the spec recorded from the CLI. Then press Shift+F12 at the same position and confirm those callers appear alongside gopls's in-module results, and that VS Code does not hang or recurse.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: find cross-service gRPC callers from a handler"
```

---

### Task 13: Jump to the proto rpc

**Files:**
- Create: `src/core/proto.ts`
- Test: `test/unit/proto.test.ts`
- Modify: `src/vscode/commands.ts`, `package.json`

**Interfaces:**
- Consumes: `RpcSite.protoSource` from `src/core/locator`.
- Produces:
  - `function findRpcLine(protoText: string, method: string): number | undefined` in `src/core/proto`
  - `async function goToProto(deps: Deps): Promise<void>` in `src/vscode/commands`

- [ ] **Step 1: Write the failing tests**

`test/unit/proto.test.ts`:

```ts
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
```

The second test is the one that matters: a naive `includes('rpc ' + method)` returns line 3 for `ListOrdersForExport` because `ListOrders` is a prefix of it. The real `order_service.proto` has exactly this collision.

- [ ] **Step 2: Run the tests and watch them fail**

```bash
npm run test:unit
```

Expected: FAIL — `Cannot find module '../../src/core/proto'`.

- [ ] **Step 3: Implement the finder**

`src/core/proto.ts`:

```ts
export function findRpcLine(protoText: string, method: string): number | undefined {
  const escaped = method.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rpc = new RegExp(`^\\s*rpc\\s+${escaped}\\s*\\(`);
  const lines = protoText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (rpc.test(lines[i])) {
      return i;
    }
  }
  return undefined;
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
npm run test:unit
```

Expected: PASS.

- [ ] **Step 5: Implement the command**

In `src/vscode/commands.ts`, add one import:

```ts
import { findRpcLine } from '../core/proto';
```

register the command inside `registerCommands`:

```ts
  context.subscriptions.push(
    vscode.commands.registerCommand('gorpcLens.goToProto', () => goToProto(deps)),
  );
```

and add:

```ts
export async function goToProto(deps: Deps): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'go') {
    vscode.window.showWarningMessage('gorpc-lens: put the cursor on a gRPC method in a Go file.');
    return;
  }

  const pos = editor.selection.active;
  const resolved = await deps.pipeline.siteAt(
    editor.document.uri.fsPath,
    { line: pos.line, character: pos.character },
    COMMAND_STAGES,
  );
  if (!resolved) {
    vscode.window.showWarningMessage('gorpc-lens: this is not a gRPC client call or handler.');
    return;
  }

  const source = resolved.site.protoSource;
  if (!source) {
    vscode.window.showWarningMessage(
      'gorpc-lens: the generated file has no "// source:" comment to follow.',
    );
    return;
  }

  const matches = await vscode.workspace.findFiles(`**/${source}`, '**/node_modules/**', 5);
  if (matches.length === 0) {
    vscode.window.showWarningMessage(`gorpc-lens: ${source} is not in this workspace.`);
    return;
  }

  const doc = await vscode.workspace.openTextDocument(matches[0]);
  const line = findRpcLine(doc.getText(), resolved.site.method);
  const at = new vscode.Position(line ?? 0, 0);
  await vscode.window.showTextDocument(doc, { selection: new vscode.Range(at, at) });

  if (line === undefined) {
    vscode.window.showWarningMessage(
      `gorpc-lens: opened ${source} but could not find "rpc ${resolved.site.method}".`,
    );
  }
}
```

Opening the file even when the rpc line is not found is deliberate: the user asked to see the proto, and the file is more useful than an error.

- [ ] **Step 6: Declare the command**

In `package.json`, add to `contributes.commands`:

```json
      {
        "command": "gorpcLens.goToProto",
        "title": "gorpc-lens: Go to Proto Definition"
      }
```

and to `contributes.menus["gorpcLens.submenu"]`:

```json
        { "command": "gorpcLens.goToProto", "group": "1_nav@3" }
```

- [ ] **Step 7: Verify manually**

```bash
npm run build
```

Press F5, open the reference workspace, put the cursor on `ListOrders` at `order-biz/manager/biz/order.go:94`, and run **gorpc-lens: Go to Proto Definition**.

Expected: `protos/order-svc/order_service.proto` opens at line 19, the `rpc ListOrders` line. Repeat with the cursor on a `ListOrdersForExport` call and confirm it lands on line 28, not 19.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: jump from a gRPC method to its proto rpc"
```

---

### Task 14: Caller-count CodeLens

Off by default. The last feature, and the easiest to skip if the latency measured in Task 1 was poor.

**Files:**
- Create: `src/core/summary.ts`, `src/vscode/codelens.ts`
- Test: `test/unit/summary.test.ts`
- Modify: `src/extension.ts`

**Interfaces:**
- Consumes: `Loc` from `src/core/types`; `Deps` from `src/vscode/definition`.
- Produces:
  - `function moduleOf(filePath: string, root: string): string | undefined` in `src/core/summary`
  - `function describeCallers(locs: Loc[], root: string): string` in `src/core/summary`
  - `const HANDLER_DECL: RegExp` and `class GrpcCodeLensProvider implements vscode.CodeLensProvider` in `src/vscode/codelens`

- [ ] **Step 1: Write the failing tests**

`test/unit/summary.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
npm run test:unit
```

Expected: FAIL — `Cannot find module '../../src/core/summary'`.

- [ ] **Step 3: Implement the helpers**

`src/core/summary.ts`:

```ts
import { Loc } from './types';

export function moduleOf(filePath: string, root: string): string | undefined {
  const prefix = root.endsWith('/') ? root : `${root}/`;
  if (!filePath.startsWith(prefix)) {
    return undefined;
  }
  const rest = filePath.slice(prefix.length);
  const slash = rest.indexOf('/');
  return slash === -1 ? undefined : rest.slice(0, slash);
}

export function describeCallers(locs: Loc[], root: string): string {
  if (locs.length === 0) {
    return 'no callers';
  }
  const services = new Set<string>();
  for (const l of locs) {
    const m = moduleOf(l.path, root);
    if (m) {
      services.add(m);
    }
  }
  const callerWord = locs.length === 1 ? 'caller' : 'callers';
  const serviceWord = services.size === 1 ? 'service' : 'services';
  return `${locs.length} ${callerWord} in ${services.size} ${serviceWord}`;
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
npm run test:unit
```

Expected: PASS.

- [ ] **Step 5: Implement the CodeLens provider**

`src/vscode/codelens.ts`:

```ts
import * as vscode from 'vscode';
import { REFERENCE_STAGES } from '../core/pipeline';
import { describeCallers } from '../core/summary';
import { Deps } from './definition';
import { guardKey, withGuard } from './guard';

/** A method on a receiver taking a context first — the shape of every gRPC handler. */
export const HANDLER_DECL = /^func\s*\(\s*\w+\s+\*?\w+\s*\)\s+([A-Z]\w*)\(\s*\w+\s+context\.Context/;

export class GrpcCodeLensProvider implements vscode.CodeLensProvider {
  constructor(private readonly deps: Deps) {}

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const cfg = this.deps.config();
    if (!cfg.enabled || !cfg.codeLensHandlers || doc.languageId !== 'go') {
      return [];
    }
    if (doc.uri.fsPath.endsWith('.pb.go')) {
      return [];
    }

    const lenses: vscode.CodeLens[] = [];
    for (let i = 0; i < doc.lineCount; i++) {
      const m = HANDLER_DECL.exec(doc.lineAt(i).text);
      if (!m) {
        continue;
      }
      const col = doc.lineAt(i).text.indexOf(m[1]);
      lenses.push(new vscode.CodeLens(new vscode.Range(i, col, i, col + m[1].length)));
    }
    return lenses;
  }

  async resolveCodeLens(lens: vscode.CodeLens): Promise<vscode.CodeLens> {
    const doc = vscode.window.activeTextEditor?.document;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!doc || !root) {
      lens.command = { title: '', command: '' };
      return lens;
    }

    const pos = lens.range.start;
    try {
      const resolved = await this.deps.pipeline.siteAt(
        doc.uri.fsPath,
        { line: pos.line, character: pos.character },
        REFERENCE_STAGES,
      );
      const clientMethod = resolved?.site.clientMethod;
      if (!resolved || !clientMethod) {
        lens.command = { title: '', command: '' };
        return lens;
      }

      const pbKey = guardKey(vscode.Uri.file(resolved.pbPath).toString(), clientMethod);
      const callers = await withGuard(
        pbKey,
        () => this.deps.resolver.callersFor(resolved.pbPath, clientMethod),
        [],
      );

      lens.command = {
        title: describeCallers(callers, root),
        command: 'gorpcLens.findCallers',
      };
    } catch (err) {
      this.deps.log.error('codelens', err);
      lens.command = { title: '', command: '' };
    }
    return lens;
  }
}
```

An empty title renders as nothing, which is the right outcome for a Go method that turns out not to be a gRPC handler — most of them.

- [ ] **Step 6: Register it**

In `src/extension.ts`, add:

```ts
import { GrpcCodeLensProvider } from './vscode/codelens';
```

and:

```ts
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(GO, new GrpcCodeLensProvider(deps)),
  );
```

- [ ] **Step 7: Verify manually**

```bash
npm run build
```

Press F5, open the reference workspace, set `"gorpcLens.codeLens.handlers": true` in the dev-host settings, and open `order-svc/manager/handler/order.go`.

Expected: a lens above `ListOrders` reading something like `23 callers in 5 services`; clicking it opens the references panel. Non-gRPC methods in the same file show no lens. Confirm scrolling stays smooth — if it does not, leave the default off and note it in the README.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add an opt-in caller-count CodeLens for gRPC handlers"
```

---

### Task 15: Documentation, cleanup, and packaging

**Files:**
- Create: `README.md`
- Modify: `src/extension.ts` (remove the dev measurement command)
- Modify: `package.json` (remove the dev command and its palette hide)

**Interfaces:**
- Consumes: everything.
- Produces: a `.vsix` installable in the user's VS Code.

- [ ] **Step 1: Remove the development-only measurement command**

In `src/extension.ts`, delete the `gorpcLens.measureLatency` registration, the `measureLatency` function, and the `SAMPLE_COUNT` constant. In `package.json`, delete the `gorpcLens.measureLatency` entry from `contributes.commands` and the `commandPalette` block that hid it.

Keep the number it produced — it goes in the README in the next step.

- [ ] **Step 2: Write the README**

`README.md`:

````markdown
# gorpc-lens

Ctrl+Click on a Go gRPC client call lands on the generated interface, not on the
handler that actually runs. gorpc-lens adds the handler to that list.

```
b.orderClient.ListOrders(ctx, ...)   // order-biz
        |
        |  Ctrl+Click today
        v
    OrderServiceClient.ListOrders    // protos, generated
        |
        |  Ctrl+Click with gorpc-lens — both offered
        v
    (*OrderHandler).ListOrders       // order-svc
```

## Why gopls cannot do this alone

`XxxServiceClient` and `XxxServiceServer` are unrelated interfaces. Nothing in
the type system connects a client method to the handler that serves it — only
the gRPC service and method name do. "Go to Implementation" on the client method
returns the generated private client struct, which is not what you wanted.

gorpc-lens parses the generated `_grpc.pb.go` to hop from the client method to
its server counterpart, then asks gopls for implementations of *that*. gopls does
the cross-module search; the extension just knows where to point it.

## What it does

| Action | Where | Result |
|---|---|---|
| Ctrl+Click | a gRPC client call | the generated interface **and** the handler |
| `Ctrl+Alt+H` | a call site or handler | jump straight to the handler |
| Shift+F12 | a handler method | in-module references **and** cross-service callers |
| **Find gRPC Callers** | either end | every service that calls this RPC |
| **Go to Proto Definition** | either end | the `rpc` line in the `.proto` |

All commands are on the right-click **gRPC** submenu in Go files.

## Requirements

The Go extension (`golang.go`) with a working gopls, and all the services you
want to navigate between inside one workspace — a `go.work` covering them is the
normal way to get that.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `gorpcLens.enabled` | `true` | Master switch. |
| `gorpcLens.timeoutMs` | `2000` | Give up on a gopls query and contribute nothing. |
| `gorpcLens.includeTests` | `false` | Include results in `_test.go`. |
| `gorpcLens.codeLens.handlers` | `false` | Caller-count lens above handler methods. |
| `gorpcLens.excludeGlobs` | `["**/*.pb.go"]` | Files whose results are treated as generated. |
| `gorpcLens.trace` | `"off"` | Set to `"verbose"` and open the **gorpc-lens** output channel. |

## When nothing happens

By design, the providers stay silent on every failure — the worst case is the
behavior you had before installing it. To find out why, set
`gorpcLens.trace` to `"verbose"` and watch the **gorpc-lens** output channel,
or use `Ctrl+Alt+H`, which reports its failures out loud.

## Measured latency

Recorded in the reference workspace (~50 Go modules under one `go.work`, gopls
v0.23.0): **fill in the p50/p95 from Task 1 here.**

## Development

```bash
npm install
npm run watch          # rebuild on change; press F5 to launch a dev host
npm run test:unit      # fast, no VS Code
npm run test:integration   # needs Go and gopls on PATH
npm run package        # produces gorpc-lens-<version>.vsix
```

The `src/core/` tree must never import `vscode` — that boundary is what keeps
the logic testable without an extension host.
````

Replace the latency placeholder with the real number recorded in Task 1. Do not leave the sentence as written.

- [ ] **Step 3: Run everything**

```bash
npm run test:unit && npm run test:integration && npm run build
```

Expected: all green.

- [ ] **Step 4: Package and install**

```bash
npm run package
code --install-extension gorpc-lens-0.1.0.vsix
```

- [ ] **Step 5: Verify against the real problem**

Reload VS Code, open `<monorepo>`, wait for gopls to warm, then confirm all four:

1. Ctrl+Click `ListOrders` at `order-biz/manager/biz/order.go:94` → the peek list offers both `order_service_grpc.pb.go:79` and `order-svc/manager/handler/order.go:47`.
2. `Ctrl+Alt+H` at the same position → jumps straight to the handler.
3. **Find gRPC Callers** at `order-svc/manager/handler/order.go:47` → lists callers across at least `billing-svc`, `integration-svc`, `invoice-biz`, and `mobile-biz`.
4. **Go to Proto Definition** from either end → `order_service.proto:19`.

Then spend a few minutes doing ordinary work in the repo and confirm Ctrl+Click on non-gRPC symbols feels no slower than before. That is the acceptance criterion the cheap-reject path exists for.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: add README and remove the development latency probe"
```

---

## Plan Self-Review

**Spec coverage.** Every section of the design doc maps to a task: the parser and its rigid-format assumption (Task 2), position classification (Task 3), the filtering rules (Tasks 4-5), timeout and cache (Tasks 6-7), the three-stage resolution and the provider/command stage split (Task 8), the definition provider and reentrancy guard (Tasks 9-10), the three commands (Tasks 11-13), the opt-in CodeLens (Task 14), configuration (Task 1, exercised throughout), the trace output channel (Task 1), packaging and the README (Task 15), and the measurement gate the spec demanded before committing to this engine (Task 1, Step 10).

**Two deviations from the spec, both deliberate:**

1. The spec sketched providers using `PROVIDER_STAGES`. The reference provider instead uses `REFERENCE_STAGES` (`['self', 'implementation']`), justified in Task 12 — the handler case is unreachable without the implementation stage, and the definition stage buys nothing there.
2. The spec said "zero runtime dependencies." Task 4 honours that by hand-rolling a glob matcher rather than taking `minimatch`. The trade is roughly 25 lines of our own code against a dependency; the tests pin the subset that is supported.

**Type consistency.** `MethodRef`, `RpcSite`, `Loc`, `Pos`, `PbFileModel`, `ResolvedSite`, `Deps`, and `GorpcConfig` are each defined once and referenced with the same field names throughout. `Resolver.handlersFor`/`callersFor`, `Pipeline.siteAt`/`invalidate`, `filterByPath`/`filterByReceiver`/`excludeSelf`, `toVsLocation`, and `guardKey`/`withGuard` keep their signatures from definition to use.

**Known risk, already gated.** The whole plan rests on warm gopls latency being tolerable in a 50-module workspace. Task 1 measures it before any of the resolution code is written, and names the threshold at which to stop and revisit the design rather than push on.
