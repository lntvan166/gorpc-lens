// Reentrancy guard shared by the definition and reference providers.
//
// Asking VS Code for a definition or reference runs *all* registered
// providers, including ours, so a provider that queries the LSP re-enters
// itself. The keyspace is deliberately not namespaced by provider kind: when
// the reference provider asks for a definition at a position it already holds,
// the definition provider should recognise the reentry and step aside rather
// than duplicate a workspace-wide query.
//
// No `vscode` import here, so this stays unit-testable outside the host.
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
