---
name: release
description: Cut and publish a new gorpc-lens release to the VS Code Marketplace and Open VSX. Use whenever the user asks to "make a release", "publish", "ship", "cut a version", "release vX.Y.Z", "push a new version to the marketplace", or bump the version after landing a change. Handles semver bump, CHANGELOG, tests, bundle, commit, tag, and publishing to both registries (`vsce` + `ovsx`) — pausing for confirmation before the irreversible publish. Trigger even if the user only says "publish this" or "ship it" after finishing a change.
---

# Release gorpc-lens

gorpc-lens is a VS Code extension (`publisher: lntvan166`, `name: gorpc-lens`). A
release means: bump the version, record it in the CHANGELOG, verify it builds and
tests pass, commit + tag it in git, and publish the `.vsix` to **two** registries —
the VS Code Marketplace with `vsce`, and [Open VSX](https://open-vsx.org) with
`ovsx`. Open VSX is what Cursor, VSCodium and Windsurf pull from, so shipping there
is what lets the extension **auto-update** in those editors.

Publishing is **irreversible on both registries** — a version number cannot be
unpublished, overwritten, or re-pushed. So the flow front-loads every check that
can fail (tests, bundle, auth) *before* committing anything, and **pauses for
explicit go-ahead** before publishing.

Build the artifact **once** with `vsce package`, then hand that same file to both
`vsce publish` and `ovsx publish`, so the registries carry byte-identical builds.

## Before you start

```bash
git branch --show-current                    # expect: main
node -p "require('./package.json').version"  # current version
git tag --sort=-v:refname | head -5          # recent tags
git status --short                           # what is uncommitted
```

Note any **untracked** files — they must not end up in the release commit (step 6).

> The zsh line `compdef:153: _comps: assignment to invalid subscript range` is
> harmless shell-init noise on this machine — ignore it in command output.

## Tooling

```bash
npx vsce --version   # bundled as a devDependency; no global install needed
ovsx --version       # if missing: npm install -g ovsx
```

`OVSX_PAT` is expected in the environment. If it is unset, ask the user to run the
Open VSX publish themselves via `! ovsx publish <file> -p <token>` so the secret
stays in their session. **Never** write the token into a file, a script, or this
skill.

## Pick the version bump

- **patch** (`0.1.0 → 0.1.1`) — bug fix, message tweak, docs, internal change.
- **minor** (`0.1.1 → 0.2.0`) — a new command, setting, or provider; any
  backward-compatible behaviour change.
- **major** — a breaking change to how users interact with the extension.

If ambiguous, state your reasoning and pick the lower bump.

## Steps

Do 1–5 first (all reversible). Then **stop and ask before 6 onward.**

### 1. Full test suite

```bash
npm test        # test:unit (90 tests, no VS Code) + test:integration (11 tests, real VS Code)
```

`test:integration` downloads VS Code on first run and needs Go and gopls on PATH.
It launches a real extension host against `test/fixtures/workspace`. Never publish
on red.

### 2. Bump the version

```bash
npm version <new-version> --no-git-tag-version
```

`--no-git-tag-version` keeps npm from making its own commit and tag; steps 6–7 own
those so the message and trailer are right.

### 3. CHANGELOG entry

`CHANGELOG.md` follows Keep a Changelog + semver. Insert a new section above the
previous one, dated today, using only the `### Added / Changed / Fixed / Notes`
headings that apply. Match the existing voice: each bullet leads with the
**user-visible effect in plain English**, then the mechanism and the why.

### 4. Verify the production bundle

```bash
npm run build   # exactly what vsce runs via vscode:prepublish
```

Confirm `dist/extension.js` is written.

### 5. Verify publish auth — before committing

```bash
npx vsce verify-pat lntvan166
```

If it fails the Marketplace PAT has expired; the user must refresh it in Azure
DevOps (Marketplace → Manage scope) and re-run `vsce login lntvan166` — suggest
`! vsce login lntvan166` so the interactive prompt lands in their session.

Open VSX has **no `verify-pat` equivalent**; the token is only validated at publish
time. The namespace `lntvan166` already exists and the Eclipse Publisher Agreement
is already signed — both are one-time prerequisites that are done.

### — PAUSE HERE —

Summarise: new version, the CHANGELOG bullets, tests/bundle/auth all green. Ask for
confirmation before committing, tagging and publishing. This gate is deliberate;
neither registry has an undo.

### 6. Commit — only the release files

**Never `git add -A`.**

```bash
git add package.json package-lock.json CHANGELOG.md <changed-source-files>
git commit -F - <<'EOF'
release: vX.Y.Z — <one-line summary>

<short body explaining the why>

Co-Authored-By: Claude <noreply@anthropic.com>   # the model that did the work
EOF
```

Re-check `git status --short`: only intended files committed, strays still untracked.

### 7. Tag

```bash
git tag -a vX.Y.Z -m "release: vX.Y.Z — <same summary>

Co-Authored-By: Claude <noreply@anthropic.com>"
```

Annotated tags, not lightweight ones.

### 8. Push commit and tag

```bash
git push origin main
git push origin vX.Y.Z
```

Unlike some projects, the README here embeds **no images**, so the listing has no
dependency on GitHub being reachable. Push first anyway, so the tag matches what
was published.

### 9. Package once, publish to both

```bash
npx vsce package                                  # -> gorpc-lens-X.Y.Z.vsix
```

**Expected: 8 files, ~17 KB** — README, CHANGELOG, LICENSE, package.json,
`dist/extension.js`, `media/icon.png`, plus the two manifests. That is the
regression check. If it comes out much larger, something escaped `.vscodeignore`:
`docs/`, `src/`, `test/`, `verify.example.json` and everything in `media/` except
`icon.png` are all meant to be excluded.

```bash
npx vsce publish --packagePath gorpc-lens-X.Y.Z.vsix   # Marketplace
ovsx publish gorpc-lens-X.Y.Z.vsix                     # Open VSX (uses OVSX_PAT)
```

**Both registries index AFTER the CLI reports success — poll, don't panic.**
Measured on v0.1.0: the Marketplace was live in ~20 s, Open VSX in ~140 s.

```bash
for i in $(seq 1 15); do
  o=$(curl -s https://open-vsx.org/api/lntvan166/gorpc-lens | python3 -c "import sys,json;print(json.load(sys.stdin).get('version','-'))" 2>/dev/null || echo "-")
  m=$(npx vsce show lntvan166.gorpc-lens 2>/dev/null | grep -m1 "Version:" | awk '{print $2}')
  echo "t+$((i*20))s  openvsx=${o:--}  marketplace=${m:--}"
  [ "$o" = "X.Y.Z" ] && [ "$m" = "X.Y.Z" ] && echo "BOTH LIVE" && break
  sleep 20
done
```

An Open VSX `already published` message is a success, not a failure — the version
is live and cannot be overwritten.

### 10. (Optional) GitHub Release

Tags-only by default. Only if the user asks:

```bash
gh release create vX.Y.Z --title "vX.Y.Z" --notes "<the CHANGELOG section>"
```

## After publishing

- Confirm and link both:
  - https://marketplace.visualstudio.com/items?itemName=lntvan166.gorpc-lens
  - https://open-vsx.org/extension/lntvan166/gorpc-lens
- **Delete the local `.vsix`** (`rm gorpc-lens-X.Y.Z.vsix`) — a build artifact.

## Optional pre-release check against a real monorepo

The fixture workspace is synthetic. Before a release that touches resolution, run
the suite against a real Go monorepo:

```bash
cp verify.example.json verify.local.json    # edit it; the file is gitignored
npm run verify:real
```

It asserts the four navigations end to end and prints warm gopls latency. Nothing
about any particular repository is committed.

## Project-specific gotchas

1. **`test:integration` must build first.** The extension host loads
   `dist/extension.js`, not the TypeScript. The npm script already runs `build`
   before `compile-tests` — do not "simplify" that away, or the suite silently
   tests the previous build.
2. **`src/core/` must never import `vscode`.** That boundary is what keeps 90 unit
   tests runnable without an extension host. A stray import turns them into load
   errors.
3. **Icons must be quantized.** A 512×512 flat icon belongs at single-digit KB. If
   `vsce` warns that `media/icon.png` is large, it carries render noise — snap the
   flat areas to the two palette colours and re-save with
   `Image.quantize(colors=64, method=Image.FASTOCTREE)`.
4. **Never commit `.vscode-test/`.** It holds a ~1 GB VS Code download. It is
   gitignored; keep it that way.

## What NOT to do

- Don't publish on failing tests or a failing bundle.
- Don't `git add -A` / `git add .`.
- Don't hardcode `OVSX_PAT` anywhere.
- Don't let `vsce` and `ovsx` each build their own package — one `vsce package`,
  published twice.
- Don't treat Open VSX "already published" as a failure.
- Don't skip the confirmation pause.
