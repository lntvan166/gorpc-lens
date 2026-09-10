import { MethodRef, PbFileModel } from './pbFile';

export type Role = 'client' | 'server';

export interface RpcSite {
  service: string;
  method: string;
  role: Role;
  clientMethod?: MethodRef;
  serverMethod?: MethodRef;
  protoSource?: string;
}

export function classify(model: PbFileModel, line: number, character: number): RpcSite | undefined {
  for (const svc of model.services.values()) {
    for (const role of ['client', 'server'] as const) {
      const iface = role === 'client' ? svc.client : svc.server;
      if (!iface) {
        continue;
      }
      for (const m of iface.methods.values()) {
        if (m.line !== line) {
          continue;
        }
        if (character < m.character || character > m.character + m.name.length) {
          continue;
        }
        return {
          service: svc.name,
          method: m.name,
          role,
          clientMethod: svc.client?.methods.get(m.name),
          serverMethod: svc.server?.methods.get(m.name),
          protoSource: model.protoSource,
        };
      }
    }
  }
  return undefined;
}
