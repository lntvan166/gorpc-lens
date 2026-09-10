import * as vscode from 'vscode';
import { TraceLevel } from '../core/trace';

export interface GorpcConfig {
  enabled: boolean;
  timeoutMs: number;
  includeTests: boolean;
  codeLensHandlers: boolean;
  ignoreGeneratedFiles: boolean;
  excludeGlobs: string[];
  trace: TraceLevel;
}

export function readConfig(): GorpcConfig {
  const c = vscode.workspace.getConfiguration('gorpcLens');
  return {
    enabled: c.get<boolean>('enabled', true),
    timeoutMs: c.get<number>('timeoutMs', 2000),
    includeTests: c.get<boolean>('includeTests', false),
    codeLensHandlers: c.get<boolean>('codeLens.handlers', false),
    ignoreGeneratedFiles: c.get<boolean>('ignoreGeneratedFiles', true),
    excludeGlobs: c.get<string[]>('excludeGlobs', ['**/*.pb.go']),
    trace: c.get<TraceLevel>('trace', 'off'),
  };
}
