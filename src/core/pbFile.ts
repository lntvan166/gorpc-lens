export interface MethodRef {
  name: string;
  line: number;
  character: number;
}

export interface ServiceInterface {
  name: string;
  methods: Map<string, MethodRef>;
}

export interface ServiceModel {
  name: string;
  client?: ServiceInterface;
  server?: ServiceInterface;
}

export interface PbFileModel {
  protoSource?: string;
  services: Map<string, ServiceModel>;
}

const SOURCE_COMMENT = /^\/\/\s*source:\s*(\S+)\s*$/;
const INTERFACE_START = /^type\s+(\w+)\s+interface\s*\{/;
const METHOD_LINE = /^\s+([A-Z]\w*)\s*\(/;

export function isGeneratedGrpcFile(filePath: string): boolean {
  return filePath.endsWith('_grpc.pb.go');
}

export function stripLineComment(line: string): string {
  const idx = line.indexOf('//');
  return idx === -1 ? line : line.slice(0, idx);
}

export function parsePbFile(text: string): PbFileModel {
  const lines = text.split(/\r?\n/);
  const services = new Map<string, ServiceModel>();
  let protoSource: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    if (protoSource === undefined) {
      const src = SOURCE_COMMENT.exec(lines[i]);
      if (src) {
        protoSource = src[1];
        continue;
      }
    }

    const start = INTERFACE_START.exec(lines[i]);
    if (!start) {
      continue;
    }

    const typeName = start[1];
    const methods = new Map<string, MethodRef>();

    // The opening brace is on the start line; anything after it counts too,
    // so `type X interface{}` closes immediately.
    const openIdx = lines[i].indexOf('{');
    let depth = 1;
    depth += braceDelta(stripLineComment(lines[i].slice(openIdx + 1)));

    let j = i;
    while (depth > 0 && ++j < lines.length) {
      const code = stripLineComment(lines[j]);
      if (depth === 1) {
        const m = METHOD_LINE.exec(code);
        if (m) {
          methods.set(m[1], { name: m[1], line: j, character: code.indexOf(m[1]) });
        }
      }
      depth += braceDelta(code);
    }
    i = j;

    const role = interfaceRole(typeName);
    if (!role) {
      continue;
    }

    const svc = services.get(role.service) ?? { name: role.service };
    if (role.kind === 'client') {
      svc.client = { name: typeName, methods };
    } else {
      svc.server = { name: typeName, methods };
    }
    services.set(role.service, svc);
  }

  return { protoSource, services };
}

function braceDelta(code: string): number {
  let delta = 0;
  for (const ch of code) {
    if (ch === '{') {
      delta++;
    } else if (ch === '}') {
      delta--;
    }
  }
  return delta;
}

function interfaceRole(typeName: string): { kind: 'client' | 'server'; service: string } | undefined {
  if (typeName.startsWith('Unsafe') || typeName.startsWith('Unimplemented')) {
    return undefined;
  }
  if (typeName.endsWith('Client')) {
    return { kind: 'client', service: typeName.slice(0, -'Client'.length) };
  }
  if (typeName.endsWith('Server')) {
    return { kind: 'server', service: typeName.slice(0, -'Server'.length) };
  }
  return undefined;
}
