; Loaded ahead of the checked script by validate() in src/core/run-manager.ts, through
; AutoHotkey's /include switch; it never runs on its own.
;
; AutoHotkey v2 enables the VarUnset and Unreachable load-time warnings by default, in
; MsgBox mode. Under /Validate that dialog is hidden and nobody can dismiss it, so the
; process hangs until it is killed. StdOut mode prints the same warnings instead, in
; the "file (line) : ==> Warning: ..." format that /ErrorStdOut uses for errors. The
; set of warnings stays the default one. A #Warn directive in the checked script
; itself still wins.
#Warn VarUnset, StdOut
#Warn Unreachable, StdOut
