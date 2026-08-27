import type { z } from 'zod';

export type StudioParameters = Readonly<Record<string, unknown>>;

export interface PublicMacro {
  id: string;
  title: string;
  description: string;
  effect: string;
  targets: readonly string[];
  inputSchema: Readonly<Record<string, unknown>>;
}

export interface StudioMacroDefinition {
  metadata: PublicMacro;
  scriptPath: string;
  parameterSchema: z.ZodType<StudioParameters>;
  timeoutMs: number;
  buildArguments(parameters: StudioParameters): readonly string[];
  successSummary: string;
  failureSummary: string;
}

export interface StudioMacroCatalog {
  readonly rootPath: string;
  list(): readonly PublicMacro[];
  get(id: string): StudioMacroDefinition | undefined;
}
