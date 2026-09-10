export interface Pos {
  line: number;
  character: number;
}

export interface Loc {
  path: string;
  line: number;
  character: number;
}

export interface Logger {
  trace(stage: string, detail: string, ms?: number): void;
  error(stage: string, err: unknown): void;
}

export interface LspClient {
  definitions(path: string, pos: Pos): Promise<Loc[]>;
  implementations(path: string, pos: Pos): Promise<Loc[]>;
  references(path: string, pos: Pos): Promise<Loc[]>;
  documentText(path: string): Promise<string | undefined>;
  lineText(path: string, line: number): Promise<string | undefined>;
}
