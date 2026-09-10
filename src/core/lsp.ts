import { Loc } from './types';

interface RawUri {
  fsPath?: string;
}

interface RawRange {
  start?: { line?: number; character?: number };
}

interface RawLocation {
  uri?: RawUri;
  range?: RawRange;
  targetUri?: RawUri;
  targetRange?: RawRange;
  targetSelectionRange?: RawRange;
}

export function normalizeRawLocations(raw: unknown): Loc[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: Loc[] = [];
  for (const entry of raw as RawLocation[]) {
    if (!entry) {
      continue;
    }
    const uri = entry.targetUri ?? entry.uri;
    const range = entry.targetUri ? entry.targetSelectionRange ?? entry.targetRange : entry.range;
    const path = uri?.fsPath;
    const line = range?.start?.line;
    const character = range?.start?.character;
    if (path === undefined || line === undefined || character === undefined) {
      continue;
    }
    out.push({ path, line, character });
  }
  return out;
}

export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([p.catch(() => undefined), deadline]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export class ResolveCache {
  private readonly map = new Map<string, Loc[]>();

  static key(direction: string, path: string, line: number, character: number): string {
    return `${direction}:${path}:${line}:${character}`;
  }

  get(key: string): Loc[] | undefined {
    return this.map.get(key);
  }

  set(key: string, value: Loc[]): void {
    this.map.set(key, value);
  }

  clear(): void {
    this.map.clear();
  }
}
