import * as vscode from 'vscode';
import { TraceLevel, formatTrace } from '../core/trace';

export { TraceLevel, formatTrace };

export class Logger {
  private readonly channel: vscode.OutputChannel;

  constructor(private readonly level: () => TraceLevel) {
    this.channel = vscode.window.createOutputChannel('gorpc-lens');
  }

  trace(stage: string, detail: string, ms?: number): void {
    if (this.level() !== 'verbose') {
      return;
    }
    this.channel.appendLine(formatTrace(stage, detail, ms));
  }

  error(stage: string, err: unknown): void {
    this.channel.appendLine(formatTrace(stage, `ERROR ${String(err)}`));
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
