/**
 * Regression tests for the built-in static checkers (src/lsp/diagnostics.ts and
 * src/compiler/ahk-linter.ts). Both used to report errors on valid AutoHotkey v2 code
 * (fat-arrow functions, ++, compound assignment, `loop n {`, repeated calls) and missed
 * v1 comma command syntax.
 */

import { AhkDiagnosticProvider } from '../../src/lsp/diagnostics';
import { AhkCompiler } from '../../src/compiler/ahk-compiler';
import { DiagnosticSeverity } from '../../src/types/index';

const VALID_V2: Record<string, string> = {
  classes: [
    'class Foo {',
    '  __New(x) {',
    '    this.x := x',
    '  }',
    '  Get() => this.x',
    '  Value {',
    '    get => this.x',
    '    set => this.x := value',
    '  }',
    '}',
    'class Bar {',
    '  __New(x) {',
    '    this.y := x',
    '  }',
    '}',
    'f := Foo(1)',
    'MsgBox(f.Get())',
  ].join('\n'),
  operators: [
    'x := 1',
    'x++',
    'x += 2',
    'x //= 2',
    'x .= "a"',
    'y := -x',
    'z := x >> 2',
    'w := x >>> 1',
    'a := x ?? 0',
    'b := x == -1',
    'c := x !== y',
    'd := !(a && b) || c',
    'fn := (*) => 1',
  ].join('\n'),
  controlFlow: [
    'arr := [1, 2, 3]',
    'loop arr.Length {',
    '  v := arr[A_Index]',
    '}',
    'for k, v in Map("a", 1)',
    '  OutputDebug(k)',
    'try {',
    '  throw ValueError("bad", -1)',
    '} catch ValueError as e {',
    '  MsgBox(e.Message)',
    '} finally {',
    '  MsgBox("done")',
    '}',
    'if x = 5',
    '  MsgBox("five")',
  ].join('\n'),
  guiAndHotkeys: [
    '#Requires AutoHotkey v2.0',
    'g := Gui("+Resize", "Title")',
    'g.AddEdit("w200 vName")',
    'btn := g.AddButton("Default", "OK")',
    'btn.OnEvent("Click", (*) => MsgBox(g.Submit(false).Name))',
    'g.Show()',
    '^j::{',
    '  static n := 0',
    '  n++',
    '  ToolTip(Format("{1}", n))',
    '}',
    '::btw::by the way',
  ].join('\n'),
  continuation: [
    'items := [',
    '  "one",',
    '  two,',
    ']',
    'text := "',
    '(',
    'Hello, world',
    ')"',
    'Sleep 100',
  ].join('\n'),
};

async function providerErrors(code: string) {
  const diagnostics = await new AhkDiagnosticProvider().getDiagnostics(code, false);
  return diagnostics.filter(
    d => d.severity === DiagnosticSeverity.Error || d.severity === DiagnosticSeverity.Warning
  );
}

function linterErrors(code: string) {
  return (AhkCompiler.lint(code).data ?? []).filter(d => d.severity !== 'info');
}

describe('static checkers on valid AutoHotkey v2 code', () => {
  for (const [name, code] of Object.entries(VALID_V2)) {
    it(`diagnostic provider reports nothing for ${name}`, async () => {
      expect(await providerErrors(code)).toEqual([]);
    });

    it(`compiler linter reports nothing for ${name}`, () => {
      expect(linterErrors(code)).toEqual([]);
    });
  }
});

describe('static checkers on invalid code', () => {
  it('flags v1 comma command syntax as an error', async () => {
    const errors = await providerErrors('MsgBox, Hello\nSleep, 100');
    const v1 = errors.filter(d => d.code === 'semantic.v1CommandSyntax');
    expect(v1.map(d => d.range.start.line)).toEqual([0, 1]);
    expect(v1.every(d => d.severity === DiagnosticSeverity.Error)).toBe(true);
  });

  it('flags v1 `name = value` assignment in statement position only', () => {
    const warnings = linterErrors('x = 5\nif x = 5\n  MsgBox("y")').filter(
      d => d.code === 'UseAssignmentOperator'
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.range.start[0]).toBe(1);
  });

  it('flags an operator run that is not an AutoHotkey operator', () => {
    const errors = linterErrors('x := 1 */ 2').filter(d => d.code === 'InvalidOperatorSequence');
    expect(errors).toHaveLength(1);
  });

  it('flags duplicate functions in the same scope but not same-named methods', async () => {
    const code = [
      'Foo() {',
      '}',
      'Foo() {',
      '}',
      'class A {',
      '  Run() {',
      '  }',
      '}',
      'class B {',
      '  Run() {',
      '  }',
      '}',
    ].join('\n');
    const duplicates = (await providerErrors(code)).filter(
      d => d.code === 'semantic.duplicateFunction'
    );
    expect(duplicates.map(d => d.range.start.line)).toEqual([2]);
  });

  it('reports command-style calls only as a hint', async () => {
    const diagnostics = await new AhkDiagnosticProvider().getDiagnostics('MsgBox "hi"', false);
    const styled = diagnostics.filter(d => d.code === 'style.commandStyleCall');
    expect(styled).toHaveLength(1);
    expect(styled[0]?.severity).toBe(DiagnosticSeverity.Hint);
  });

  it('reports an unclosed brace', async () => {
    const errors = await providerErrors('Foo() {\n  if (1) {\n    MsgBox("a")\n}\n');
    expect(errors.some(d => /unclosed/i.test(d.message))).toBe(true);
  });
});
