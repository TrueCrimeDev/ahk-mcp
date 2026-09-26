#Requires AutoHotkey v2.0
#NoTrayIcon
#SingleInstance Off

; Capability probe for ahk-mcp (src/core/ahk-runtime.ts). Prints one JSON object on
; stdout and exits:
;
;   {"version":"2.1-alpha.31+Console","ptrSize":8,"print":true,"eval":true}
;
; "print" and "eval" detect the v2.1-alpha Console fork, whose Print() and Eval()
; built-ins AHK_Eval and the UIA inspector depend on. The lookup is dynamic and
; wrapped in try, so on a stock build it reports false instead of failing to load.
; The server also runs this file with /Validate, where it must print nothing: that
; is how it learns whether the interpreter honours /Validate at all.
;
; Stays v2.0-compatible on purpose; a v1 interpreter rejects it at #Requires, which
; the server reports as "not AutoHotkey v2".

HasBuiltin(name) {
    try return %name% is Func
    catch
        return false
}

JsonString(text) {
    text := StrReplace(text, "\", "\\")
    text := StrReplace(text, '"', '\"')
    return '"' text '"'
}

Bool(value) => value ? "true" : "false"

FileAppend('{"version":' JsonString(A_AhkVersion)
    . ',"ptrSize":' A_PtrSize
    . ',"print":' Bool(HasBuiltin("Print"))
    . ',"eval":' Bool(HasBuiltin("Eval"))
    . '}', "*", "UTF-8-RAW")
ExitApp(0)
