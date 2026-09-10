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
