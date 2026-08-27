; scripts/studio/ShowDesktopMessage.ahk
#Requires AutoHotkey v2.0
#SingleInstance Force
if A_Args.Length != 1
    ExitApp 3
message := A_Args[1]
if StrLen(message) < 1 || StrLen(message) > 120
    ExitApp 3
MsgBox(message, "AHK Macro Studio", "OK Iconi")
ExitApp 0
