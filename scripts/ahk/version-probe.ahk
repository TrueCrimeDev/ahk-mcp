#Requires AutoHotkey v2.0
#NoTrayIcon
#SingleInstance Off

; Capability probe for ahk-mcp (src/core/ahk-runtime.ts). Prints one JSON object on
; stdout and exits:
;
;   {"version":"2.1-alpha.31+Console","ptrSize":8,"print":true,"eval":true,"vars":{...}}
;
; "print" and "eval" detect the v2.1-alpha Console fork, whose Print() and Eval()
; built-ins AHK_Eval and the UIA inspector depend on. The lookup is dynamic and
; wrapped in try, so on a stock build it reports false instead of failing to load.
; "vars" holds the directory variables AutoHotkey substitutes into #Include paths
; (%A_MyDocuments%\..., and A_MyDocuments locates the user library for <Lib>);
; validate() needs the same values to check an include before AutoHotkey opens it.
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

; Listed one by one rather than looked up by name, so a variable missing from some
; build fails loudly here instead of reporting an empty path.
IncludeVars() {
    return '{"A_MyDocuments":' JsonString(A_MyDocuments)
        . ',"A_AppData":' JsonString(A_AppData)
        . ',"A_AppDataCommon":' JsonString(A_AppDataCommon)
        . ',"A_Desktop":' JsonString(A_Desktop)
        . ',"A_DesktopCommon":' JsonString(A_DesktopCommon)
        . ',"A_ProgramFiles":' JsonString(A_ProgramFiles)
        . ',"A_Programs":' JsonString(A_Programs)
        . ',"A_ProgramsCommon":' JsonString(A_ProgramsCommon)
        . ',"A_StartMenu":' JsonString(A_StartMenu)
        . ',"A_StartMenuCommon":' JsonString(A_StartMenuCommon)
        . ',"A_Startup":' JsonString(A_Startup)
        . ',"A_StartupCommon":' JsonString(A_StartupCommon)
        . ',"A_Temp":' JsonString(A_Temp)
        . ',"A_WinDir":' JsonString(A_WinDir)
        . ',"A_ComSpec":' JsonString(A_ComSpec)
        . '}'
}

FileAppend('{"version":' JsonString(A_AhkVersion)
    . ',"ptrSize":' A_PtrSize
    . ',"print":' Bool(HasBuiltin("Print"))
    . ',"eval":' Bool(HasBuiltin("Eval"))
    . ',"vars":' IncludeVars()
    . '}', "*", "UTF-8-RAW")
ExitApp(0)
