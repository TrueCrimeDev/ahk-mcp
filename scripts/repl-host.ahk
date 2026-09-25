#Requires AutoHotkey v2.1-alpha.30
#EnableEval

; REPL host for the autohotkey-debug MCP server. The server keeps this process
; alive and feeds it one framed command per line on stdin; we Eval each
; expression and Print the result, then a per-command end marker so the server
; knows the lineout for that command is complete.
;
; Wire format (one line per command): <seq><0x1F><payload>
;   payload has literal newlines encoded as 0x1A and backslashes doubled.
; Eval is expression-level — full multi-line scripts go through ahk_run, not here.
; A dedicated blocking read loop is used (no GUI/message pump), which is more
; robust with Node's pipes than overlapped reads. Lib/AsyncProcessIO.ahk's
; AsyncStdinReader is the async fallback if line delivery ever stalls.

FIELD_SEP := Chr(0x1F)
NL_ENCODE := Chr(0x1A)
ERR_PREFIX := Chr(0x02)
MARK := Chr(0x1E)

stdin := FileOpen("*", "r", "UTF-8")
while !stdin.AtEOF {
    line := stdin.ReadLine()
    if line = ""
        continue
    ProcessLine(line)
}

ProcessLine(line) {
    sep := InStr(line, FIELD_SEP)
    if !sep
        return
    seq := SubStr(line, 1, sep - 1)
    payload := SubStr(line, sep + StrLen(FIELD_SEP))
    payload := StrReplace(payload, NL_ENCODE, "`n")
    payload := StrReplace(payload, "\\", "\")
    try {
        result := Eval(payload)
        ; Stringify so Print never throws on a non-string result (Array/Map/Object).
        Print("{}", Stringify(result))
    } catch as e {
        ; An expression that runs but yields nothing (e.g. arr.Push(x)) makes Eval
        ; raise "No value was returned" — a successful empty result for a REPL, not
        ; an error. Reporting it as empty (rather than an error) also lets the
        ; server keep such statements in its replayed history so their state sticks.
        if InStr(e.Message, "No value was returned")
            Print("{}", "")
        else
            Print("{}", ERR_PREFIX (Type(e) ": ") e.Message)
    }
    ; End marker — the value slot keeps any braces in seq from being parsed.
    Print("{}", MARK seq MARK)
}

; Render any Eval result as a single-line string so Print never throws on
; non-string values. Primitives pass through unchanged; Arrays/Maps/objects get
; a readable form; anything unusual falls back to its type name.
Stringify(value) {
    if !IsObject(value)
        return value ""
    try {
        if value is Array {
            out := ""
            for v in value
                out .= (A_Index > 1 ? ", " : "") Stringify(v ?? "")
            return "[" out "]"
        }
        if value is Map {
            out := ""
            for k, v in value
                out .= (A_Index > 1 ? ", " : "") Stringify(k) ": " Stringify(v ?? "")
            return "Map(" out ")"
        }
        out := ""
        for k, v in value.OwnProps()
            out .= (out = "" ? "" : ", ") k ": " Stringify(v ?? "")
        return "{" out "}"
    } catch {
        return Type(value)
    }
}
