# Changelog

All notable changes to gorpc-lens are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
