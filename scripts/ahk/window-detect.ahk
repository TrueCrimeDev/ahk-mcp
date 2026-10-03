#Requires AutoHotkey v2.0
#NoTrayIcon
#SingleInstance Off

; Waits for visible top-level windows owned by one process and prints them as a JSON
; array on stdout (src/core/window-detect.ts runs it):
;
;   window-detect.ahk pid=1234 timeout=5000 [title=Settings] [class=AutoHotkeyGUI]
;
;   [{"hwnd":132456,"title":"Settings","className":"AutoHotkeyGUI"}]
;
; title matches a substring, ignoring case by the user's locale (so "É" matches "é");
; class matches the whole class name.
; Returns as soon as one window matches. The exit code says why it stopped, because
; an empty array alone cannot tell a timeout from a process that already exited:
;   0 = windows found, 1 = timed out, 3 = the process is not running,
;   4 = bad arguments (message on stderr). 2 stays AutoHotkey's load-error code.

POLL_MS := 50
MAX_TIMEOUT_MS := 600000

options := ParseArgs(A_Args)
DetectHiddenWindows(false)
deadline := A_TickCount + options.timeout

Loop {
    windows := MatchingWindows(options)
    if (windows.Length > 0)
        Finish(windows, 0)
    if !ProcessExist(options.pid)
        Finish([], 3)
    if (A_TickCount >= deadline)
        Finish([], 1)
    Sleep(POLL_MS)
}

ParseArgs(args) {
    options := {pid: 0, timeout: 5000, title: "", cls: ""}
    for arg in args {
        if !RegExMatch(arg, "^(pid|timeout|title|class)=(.*)$", &m)
            Usage("unknown argument: " arg)
        key := m[1] = "class" ? "cls" : m[1]
        options.%key% := m[2]
    }
    if !IsInteger(options.pid) || options.pid <= 0
        Usage("pid must be a positive integer")
    if !IsInteger(options.timeout) || options.timeout < 0 || options.timeout > MAX_TIMEOUT_MS
        Usage("timeout must be an integer from 0 to " MAX_TIMEOUT_MS)
    options.pid := Integer(options.pid)
    options.timeout := Integer(options.timeout)
    return options
}

MatchingWindows(options) {
    windows := []
    for hwnd in WinGetList("ahk_pid " options.pid) {
        ; A window can close between the listing and these reads.
        try {
            title := WinGetTitle(hwnd)
            className := WinGetClass(hwnd)
        } catch
            continue
        if (options.title != "" && !InStr(title, options.title, "Locale"))
            continue
        if (options.cls != "" && className != options.cls)
            continue
        windows.Push({hwnd: hwnd, title: title, className: className})
    }
    return windows
}

Finish(windows, exitCode) {
    json := "["
    for window in windows {
        json .= (A_Index > 1 ? "," : "")
            . '{"hwnd":' window.hwnd
            . ',"title":' JsonString(window.title)
            . ',"className":' JsonString(window.className) '}'
    }
    FileAppend(json "]", "*", "UTF-8-RAW")
    ExitApp(exitCode)
}

JsonString(text) {
    out := '"'
    Loop Parse, text {
        code := Ord(A_LoopField)
        if (A_LoopField = '"' || A_LoopField = "\")
            out .= "\" A_LoopField
        else if (code < 0x20)
            out .= Format("\u{:04x}", code)
        else
            out .= A_LoopField
    }
    return out '"'
}

Usage(message) {
    FileAppend("window-detect: " message "`n", "**", "UTF-8-RAW")
    ExitApp(4)
}
