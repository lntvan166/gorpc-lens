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
