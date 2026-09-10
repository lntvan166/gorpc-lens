import { Loc, Logger, LspClient, Pos } from './types';
import { PbFileModel, isGeneratedGrpcFile, parsePbFile } from './pbFile';
import { RpcSite, classify } from './locator';

export type Stage = 'self' | 'definition' | 'implementation';

export const PROVIDER_STAGES: Stage[] = ['self', 'definition'];
export const COMMAND_STAGES: Stage[] = ['self', 'definition', 'implementation'];
export const REFERENCE_STAGES: Stage[] = ['self', 'implementation'];

export interface ResolvedSite {
  site: RpcSite;
  pbPath: string;
}

export class Pipeline {
  private readonly models = new Map<string, PbFileModel>();

  constructor(
    private readonly lsp: LspClient,
    private readonly log: Logger,
  ) {}

  invalidate(): void {
    this.models.clear();
  }

  async siteAt(path: string, pos: Pos, stages: Stage[]): Promise<ResolvedSite | undefined> {
    if (stages.includes('self') && isGeneratedGrpcFile(path)) {
      const hit = await this.siteIn({ path, line: pos.line, character: pos.character }, 'self');
      if (hit) {
        return hit;
      }
    }

    if (stages.includes('definition')) {
      const hit = await this.firstSiteIn(await this.lsp.definitions(path, pos), 'definition');
      if (hit) {
        return hit;
      }
    }

    if (stages.includes('implementation')) {
      const hit = await this.firstSiteIn(await this.lsp.implementations(path, pos), 'implementation');
      if (hit) {
        return hit;
      }
    }

    return undefined;
  }

  private async firstSiteIn(locs: Loc[], stage: Stage): Promise<ResolvedSite | undefined> {
    for (const loc of locs) {
      const hit = await this.siteIn(loc, stage);
      if (hit) {
        return hit;
      }
    }
    return undefined;
  }

  private async siteIn(loc: Loc, stage: Stage): Promise<ResolvedSite | undefined> {
    if (!isGeneratedGrpcFile(loc.path)) {
      return undefined;
    }
    const model = await this.model(loc.path);
    if (!model) {
      return undefined;
    }
    const site = classify(model, loc.line, loc.character);
    if (!site) {
      return undefined;
    }
    this.log.trace('pipeline', `${stage} hit ${site.service}/${site.method} (${site.role})`);
    return { site, pbPath: loc.path };
  }

  private async model(path: string): Promise<PbFileModel | undefined> {
    const cached = this.models.get(path);
    if (cached) {
      return cached;
    }
    const text = await this.lsp.documentText(path);
    if (text === undefined) {
      return undefined;
    }
    const model = parsePbFile(text);
    this.models.set(path, model);
    return model;
  }
}
