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

/**
 * Choose which of several files matching the `// source:` path is the right
 * one. A workspace can hold more than one copy of the same proto tree - a git
 * worktree nested inside the repo is the common way - and the correct copy is
 * the one that shares the longest path with the generated file that named it.
 */
export function pickNearestProto(candidates: string[], pbPath: string): string | undefined {
  if (candidates.length === 0) {
    return undefined;
  }
  const pbSegments = pbPath.split(/[\\/]/);
  let best = candidates[0];
  let bestShared = -1;
  for (const candidate of candidates) {
    const segments = candidate.split(/[\\/]/);
    let shared = 0;
    while (
      shared < segments.length &&
      shared < pbSegments.length &&
      segments[shared] === pbSegments[shared]
    ) {
      shared++;
    }
    if (shared > bestShared) {
      bestShared = shared;
      best = candidate;
    }
  }
  return best;
}
