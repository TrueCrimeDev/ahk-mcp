; scripts/studio/Approval.ahk
#Requires AutoHotkey v2.0
#SingleInstance Force
if A_Args.Length != 2
    ExitApp 3
title := SubStr(A_Args[1], 1, 80)
effect := SubStr(A_Args[2], 1, 240)
decision := MsgBox("Run " title "?" Chr(10) Chr(10) effect, "AHK Macro Studio", "YesNo Icon?")
ExitApp(decision = "Yes" ? 0 : 2)
