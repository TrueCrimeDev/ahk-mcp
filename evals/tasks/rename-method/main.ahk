#Requires AutoHotkey v2.0
#Include lib\store.ahk
#Include lib\report.ahk

store := Store("data.json")
store.Load()
MsgBox(LoadReport(store))
