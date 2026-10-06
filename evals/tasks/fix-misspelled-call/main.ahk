#Requires AutoHotkey v2.0
#Include lib\config.ahk

settings := Map("theme", "dark", "volume", 40)
SaveConfg(settings, A_ScriptDir "\settings.ini")
MsgBox("Saved")
