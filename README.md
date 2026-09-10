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
        |  Ctrl+Click with gorpc-lens - both offered
        v
    (*OrderHandler).ListOrders       // order-svc
```

## Why gopls cannot do this alone

`XxxServiceClient` and `XxxServiceServer` are unrelated interfaces. Nothing in
the type system connects a client method to the handler that serves it - only
the gRPC service and method name do. "Go to Implementation" on the client method
returns the generated private client struct, which is not what you wanted.

gorpc-lens parses the generated `_grpc.pb.go` to hop from the client method to
its server counterpart, then asks gopls for implementations of *that*. gopls does
the cross-module search; the extension just knows where to point it.

Nothing about your repo is encoded anywhere - not import aliases, not module
paths, not where handlers live. That is why it works on any Go gRPC project.

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
want to navigate between inside one workspace - a `go.work` covering them is the
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

By design, the providers stay silent on every failure - the worst case is the
behavior you had before installing it. To find out why, set
`gorpcLens.trace` to `"verbose"` and watch the **gorpc-lens** output channel,
or use `Ctrl+Alt+H`, which reports its failures out loud.

## Measured latency

Every Ctrl+Click on a real gRPC call costs two gopls round trips, so the
extension's speed is gopls's speed. Resolved locations are cached per
service/method until the next `.go` save, and any query exceeding
`gorpcLens.timeoutMs` contributes nothing rather than blocking the editor.

Measured in the reference workspace - 50 Go modules under one `go.work`, gopls
v0.23.0 - with a warm editor, on `OrderServiceServer.ListOrders`:

```
implementation query, 10 samples (ms): 3 3 4 4 5 5 6 6 40 70
p50 = 5ms    p95 = 70ms
```

The two outliers are the first two calls, before gopls has the query warm.
Steady state is single-digit milliseconds, so the cache exists for correctness
of repeat navigation rather than to hide latency.

For contrast, a cold `gopls` CLI run against the same workspace takes ~6.7s -
that figure is workspace indexing, not query cost, and does not apply to an
editor that already has gopls running.

## Development

```bash
npm install
npm run watch          # rebuild on change; press F5 to launch a dev host
npm run test:unit      # 86 tests, fast, no VS Code
npm run test:integration   # 11 tests; downloads VS Code, needs Go and gopls on PATH
npm run package        # produces gorpc-lens-<version>.vsix
```

`src/core/` must never import `vscode`. That boundary is what keeps the logic
testable without an extension host, and it is enforced by the unit tests
failing to load if it is broken.
