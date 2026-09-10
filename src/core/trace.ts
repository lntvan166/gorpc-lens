export type TraceLevel = 'off' | 'verbose';

export function formatTrace(stage: string, detail: string, ms?: number): string {
  const suffix = ms === undefined ? '' : ` (${Math.round(ms)}ms)`;
  return `[${stage}] ${detail}${suffix}`;
}
