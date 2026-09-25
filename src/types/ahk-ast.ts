// AutoHotkey v2 Abstract Syntax Tree types

export interface AhkNode {
  type: string;
  start: number;
  end: number;
  line: number;
  column: number;
}

export interface AhkFunction extends AhkNode {
  type: 'function';
  name: string;
  parameters: AhkParameter[];
  returnType?: string;
  body: AhkNode[];
  isStatic?: boolean;
  visibility?: 'public' | 'private';
}

export interface AhkParameter {
  name: string;
  type?: string;
  defaultValue?: unknown;
  isOptional?: boolean;
  isVariadic?: boolean;
}

export interface AhkClass extends AhkNode {
  type: 'class';
  name: string;
  extends?: string;
  methods: AhkMethod[];
  properties: AhkProperty[];
  constructor?: AhkMethod;
}

export interface AhkMethod extends AhkNode {
  type: 'method';
  name: string;
  parameters: AhkParameter[];
  returnType?: string;
  body: AhkNode[];
  isStatic?: boolean;
  visibility?: 'public' | 'private';
  className: string;
}

export interface AhkProperty extends AhkNode {
  type: 'property';
  name: string;
  value?: unknown;
  getter?: AhkMethod;
  setter?: AhkMethod;
  isStatic?: boolean;
  visibility?: 'public' | 'private';
  className: string;
}

export interface AhkVariable extends AhkNode {
  type: 'variable';
  name: string;
  scope: 'local' | 'global' | 'static';
  value?: unknown;
  dataType?: string;
}

export interface AhkHotkey extends AhkNode {
  type: 'hotkey';
  key: string;
  modifiers: string[];
  action: AhkNode[];
}

export interface AhkHotstring extends AhkNode {
  type: 'hotstring';
  abbreviation: string;
  expansion: string;
  options?: string[];
}

export interface AhkDirective extends AhkNode {
  type: 'directive';
  name: string;
  value?: string;
}

export interface AhkIfStatement extends AhkNode {
  type: 'if';
  condition: AhkExpression;
  thenBranch: AhkNode[];
  elseBranch?: AhkNode[];
}

export interface AhkLoopStatement extends AhkNode {
  type: 'loop';
  loopType: 'for' | 'while' | 'loop' | 'files' | 'read' | 'parse';
  condition?: AhkExpression;
  body: AhkNode[];
  iterator?: AhkVariable;
}

export interface AhkExpression extends AhkNode {
  type: 'expression';
  operator?: string;
  left?: AhkExpression;
  right?: AhkExpression;
  value?: unknown;
}

export interface AhkAssignment extends AhkNode {
  type: 'assignment';
  operator: ':=' | '+=' | '-=' | '*=' | '/=' | '//=' | '.=' | '|=' | '&=' | '^=' | '>>=' | '<<=';
  left: AhkExpression;
  right: AhkExpression;
}

export interface AhkFunctionCall extends AhkNode {
  type: 'function_call';
  name: string;
  arguments: AhkExpression[];
  isMethod?: boolean;
  object?: AhkExpression;
}

export interface AhkComment extends AhkNode {
  type: 'comment';
  text: string;
  isBlockComment?: boolean;
}

export interface AhkString extends AhkNode {
  type: 'string';
  value: string;
  isRaw?: boolean;
}

export interface AhkNumber extends AhkNode {
  type: 'number';
  value: number;
  isHex?: boolean;
  isFloat?: boolean;
}

export interface AhkArray extends AhkNode {
  type: 'array';
  elements: AhkExpression[];
}

export interface AhkMap extends AhkNode {
  type: 'map';
  pairs: Array<{ key: AhkExpression; value: AhkExpression }>;
}

export interface AhkDocument {
  type: 'document';
  body: AhkNode[];
  uri?: string;
  version?: number;
}
