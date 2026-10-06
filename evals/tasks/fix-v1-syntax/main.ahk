#NoEnv
greeting = Hello
name := "World"
StringReplace, greeting, greeting, Hello, Hi
MsgBox, %greeting%, %name%!
Sleep, 500
IfWinExist, Untitled - Notepad
    WinActivate
