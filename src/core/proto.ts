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

export interface RpcDecl {
  name: string;
  character: number;
}

const RPC_DECL = /^\s*rpc\s+([A-Za-z_]\w*)\s*\(/;

/** The rpc declared on this line, if it declares one. */
export function rpcDeclAt(line: string): RpcDecl | undefined {
  const m = RPC_DECL.exec(line);
  if (!m) {
    return undefined;
  }
  return { name: m[1], character: line.indexOf(m[1], line.indexOf('rpc') + 3) };
}

/**
 * The stub filename protoc-gen-go-grpc emits for a proto:
 * `.../order_service.proto` -> `order_service_grpc.pb.go`.
 */
export function generatedFileNameFor(protoPath: string): string {
  const base = protoPath.split(/[\\/]/).pop() ?? protoPath;
  return `${base.replace(/\.proto$/, '')}_grpc.pb.go`;
}

/**
 * Whether a generated file's `// source:` header names this proto.
 *
 * The header is a package-relative path, so compare it as a path suffix. One
 * directory can hold several services whose stubs share a naming pattern, and a
 * monorepo can hold copies of the same tree in a worktree, so filename alone is
 * not enough.
 */
export function sourceMatches(protoSource: string | undefined, protoPath: string): boolean {
  if (!protoSource) {
    return false;
  }
  const norm = (p: string): string => p.replace(/\\/g, '/');
  return norm(protoPath).endsWith(norm(protoSource));
}
