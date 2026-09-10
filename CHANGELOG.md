# Changelog

All notable changes to gorpc-lens are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-09-10

### Added

- **Ctrl+Click an `rpc` line in a `.proto` and land on the Go handler that
  serves it.** Proto navigation now works both ways; previously only
  handler-to-proto did. gopls cannot help here because a `.proto` is not Go, so
  the generated stub is located by protoc-gen-go-grpc's filename convention and
  then confirmed against its `// source:` header — which is what tells apart
  several services sharing one directory, and a repo's proto tree from a nested
  worktree's copy. `.proto` files are matched by glob, so no protobuf extension
  is required.
- **`Ctrl+Alt+G` gives you Go to Definition without generated files.** The new command
  **gorpc-lens: Go to Definition (skip generated files)** returns the same merged
  list Ctrl+Click would show, minus anything matching
  `gorpcLens.excludeGlobs`. Every remaining target is kept, so a list of three
  real definitions stays a list of three. Governed by
  `gorpcLens.ignoreGeneratedFiles`, on by default. If every result is generated
  they are shown anyway, so navigation never dead-ends. Rebind `F12` or turn the
  setting off to get stock behaviour back. It is also bound to `F12`, but whether
  that beats the built-in Go to Definition depends on extension load order, so the
  README shows a two-line user keybinding that makes `F12` deterministic.

- Proto-to-handler resolves the generated stub by checking the file beside the
  `.proto` first, falling back to a workspace search only if that misses, and
  caching the result. A repo with nested worktrees can hold several copies of the
  same stub — seven, in the workspace this was measured on — and opening and
  parsing all of them on every click was slow enough to notice.

### Notes

- **Ctrl+Click cannot be filtered by any extension.** VS Code merges every
  definition provider's results and offers no way to remove another provider's,
  and the click gesture has no interception point. Choosing the first result via
  `editor.gotoLocation.multipleDefinitions` is not a substitute: which provider
  sorts first depends on activation order, and it collapses a longer list to one
  arbitrary entry. Hence a command you bind a key to.

## [0.1.0] - 2026-09-10

First release.

### Added

- **Go to Definition** on a Go gRPC client call now offers the handler that
  actually serves the RPC, alongside the generated interface gopls returns on
  its own. Works across module boundaries inside a `go.work`.
- **Go to gRPC Handler** (`Ctrl+Alt+H`, `Cmd+Alt+H` on macOS) jumps straight to
  the handler without the picker.
- **Find gRPC Callers** lists every service that calls an RPC, from the handler
  or from a call site. Also contributed to Shift+F12 on a handler method.
- **Go to Proto Definition** opens the `rpc` line in the `.proto` that generated
  the service, resolved from the generated file's `// source:` comment.
- Opt-in caller-count CodeLens above handler methods
  (`gorpcLens.codeLens.handlers`, off by default).
- Settings for the query timeout, test-file inclusion, generated-file globs, and
  a verbose trace channel.

### Notes

- Resolution delegates entirely to gopls, so nothing about a particular
  repository layout, import alias, or module path is encoded in the extension.
- Every failure path contributes no results, leaving Go to Definition exactly as
  it behaves without the extension installed.
