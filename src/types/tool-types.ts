// Tool argument types for MCP tools

import { Position } from './lsp-types.js';

export interface AnalyzeCodeArgs {
  code: string;
  fix?: boolean;
}

export interface FindVariablesArgs {
  prompt: string;
}

export interface GetFunctionInfoArgs {
  name?: string;
  search?: string;
}

export interface GetClassInfoArgs {
  name?: string;
  method?: string;
  search?: string;
}

export interface AhkCompleteArgs {
  code: string;
  position: Position;
  context?: 'function' | 'variable' | 'class' | 'auto';
}

export interface AhkDiagnosticsArgs {
  code: string;
  enableClaudeStandards?: boolean;
  severity?: 'error' | 'warning' | 'info' | 'all';
}

export interface AhkAnalyzeArgs {
  code: string;
  includeDocumentation?: boolean;
  includeUsageExamples?: boolean;
  analyzeComplexity?: boolean;
}

export interface AhkGotoArgs {
  code: string;
  position: Position;
}

export interface AhkReferencesArgs {
  code: string;
  position: Position;
  includeDeclaration?: boolean;
}

export interface SearchDocumentationArgs {
  query: string;
  limit?: number;
  categories?: string[];
  tags?: string[];
  type?: string;
}

export interface GetDocumentArgs {
  documentId?: string;
  chunkId?: string;
}

// Data structure types for AHK index
export interface AhkIndexVariable {
  Name: string;
  Category: string;
  Description: string;
  Type: string;
}

export interface AhkIndexFunction {
  Name: string;
  Category: string;
  Description: string;
  Parameters?: Array<{
    Name: string;
    Description: string;
    Type?: string;
    Optional?: boolean;
  }>;
  ReturnType?: string;
  Examples?: Array<{
    Description: string;
    Code: string;
  }>;
}

export interface AhkIndexClass {
  Name: string;
  Category: string;
  Description: string;
  Methods?: AhkIndexMethod[];
  Properties?: Array<{
    Name: string;
    Description: string;
    Type?: string;
  }>;
}

export interface AhkIndexMethod {
  Name: string;
  Path: string;
  Category: string;
  Description: string;
  Parameters?: Array<{
    Name: string;
    Description: string;
    Type?: string;
    Optional?: boolean;
  }>;
  ReturnType?: string;
  Examples?: Array<{
    Description: string;
    Code: string;
  }>;
}

export interface AhkIndexDirective {
  Name: string;
  Category: string;
  Description: string;
}

export interface AhkIndexFlowControl {
  Name: string;
  Category: string;
  Description: string;
}

export interface AhkIndexOperator {
  Name: string;
  Category: string;
  Description: string;
}

export interface AhkIndex {
  version: string;
  description: string;
  variables: AhkIndexVariable[];
  functions: AhkIndexFunction[];
  classes: AhkIndexClass[];
  methods: AhkIndexMethod[];
  directives: AhkIndexDirective[];
  flowControls: AhkIndexFlowControl[];
  operators: AhkIndexOperator[];
}

/** Shape of items in ahk_documentation_full.json */
export interface AhkDocFullVariable {
  Name: string;
  Path?: string;
  Type?: string;
  ReturnType?: string;
  Description?: string;
  Parameters?: string;
}

export interface AhkDocFullClassItem {
  Name: string;
  Type?: string;
  Path?: string;
  ReturnType?: string;
  Description?: string;
  Parameters?: string;
}

export interface AhkDocumentationFull {
  data: {
    BuiltInVariables?: AhkDocFullVariable[];
    Classes?: AhkDocFullClassItem[];
    Functions?: AhkIndexFunction[];
    // Index signature allows accessing other top-level keys without casting
    [key: string]: unknown;
  };
}

// Claude standards types
export interface ClaudeStandard {
  name: string;
  description: string;
  correct: string;
  incorrect: string;
  message: string;
  category: string;
}

export interface StandardViolation {
  rule: string;
  message: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info';
  suggestion?: string;
}
