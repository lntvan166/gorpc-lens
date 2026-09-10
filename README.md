# gorpc-lens

Ctrl+Click on a Go gRPC client call lands on the generated interface, not on the
handler that actually runs. gorpc-lens adds the handler to that list.

```
b.orderClient.ListOrders(ctx, ...)       // order-biz    <- you are here
        |
        |  Ctrl+Click today
        v
    OrderServiceClient.ListOrders        // protos       <- generated, a dead end
        |
        |  Ctrl+Click with gorpc-lens: both are offered
        v
    (*OrderHandler).ListOrders           // order-svc    <- the code that runs
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
| `Ctrl+Alt+G` | any Go symbol | definitions with generated `.pb.go` entries removed |
| `Ctrl+Alt+H` | a call site or handler | jump straight to the handler |
| Shift+F12 | a handler method | in-module references **and** cross-service callers |
| **Find gRPC Callers** | either end | every service that calls this RPC |
| **Go to Proto Definition** | either end | the `rpc` line in the `.proto` |
| Ctrl+Click | an `rpc` line in a `.proto` | the Go handler that serves it |

All commands are on the right-click **gRPC** submenu in Go files.

Proto navigation works in both directions: from a handler to its `rpc` line, and
from an `rpc` line back to the handler. The `.proto` side needs no proto
extension installed — files are matched by glob, not language id.

## Skipping generated files

Ctrl+Click on a gRPC call shows two entries: the handler gorpc-lens found, and
the generated `.pb.go` interface gopls found.

**gorpc-lens: Go to Definition (skip generated files)** — bound to `Ctrl+Alt+G`
(`Cmd+Alt+G` on macOS) — shows the same list with the generated entries removed.
Not "jump to the first result": they are gone from the list, however many real
targets remain.

### Putting it on F12

The command is also bound to `F12`, but whether that wins over the built-in
Go to Definition depends on extension load order, so treat it as a bonus. To make
`F12` yours deterministically, add this to your **keybindings.json**
(`Ctrl+K Ctrl+S`, then the "Open Keyboard Shortcuts (JSON)" icon) — user
keybindings always beat both defaults and extensions:

```json
{ "key": "f12", "command": "-editor.action.revealDefinition", "when": "editorLangId == go" },
{ "key": "f12", "command": "gorpcLens.goToDefinition", "when": "editorTextFocus && editorLangId == go" }
```

The first line removes the built-in binding for Go files only; the second puts
ours in its place. Delete both lines to go back.

Controlled by `gorpcLens.ignoreGeneratedFiles` (on by default), which uses
`gorpcLens.excludeGlobs` to decide what counts as generated. If *every* result is
generated — a request message type, say — they are shown anyway, so navigation
never dead-ends.

Set `gorpcLens.ignoreGeneratedFiles` to `false` to make the command behave like
stock Go to Definition.

**Ctrl+Click itself cannot be filtered.** VS Code merges the results of every
definition provider and gives extensions no way to remove another provider's
entries, and the click gesture has no interception point. Any extension claiming
otherwise is picking the first result, which breaks as soon as the list has more
than two.

## Requirements

The Go extension (`golang.go`) with a working gopls, and all the services you
want to navigate between inside one workspace - a `go.work` covering them is the
normal way to get that.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `gorpcLens.enabled` | `true` | Master switch. |
| `gorpcLens.ignoreGeneratedFiles` | `true` | Drop generated files from **Go to Definition (skip generated files)**. |
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

Measured on a 50-module Go workspace under a single `go.work`, gopls v0.23.0,
with a warm editor, on a server interface method:

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
