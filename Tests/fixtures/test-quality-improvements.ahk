#Requires AutoHotkey v2.0
#SingleInstance Force

; Shared fixture for the contract and integration tests of the edit tools.
; Tests copy this file before editing it, so this original is never modified.
; The toggle method names its property twice on one line on purpose: dry-run
; previews must count occurrences, not matching lines.

class TestClass {
    __New() {
        this.oldText := "original value"
        this.DarkMode := true
        this.testValue := "initial"
    }

    ColorCheckbox(ctrl) {
        if (this.DarkMode) {
            ctrl.Opt("+Background202020 cWhite")
        } else {
            ctrl.Opt("-Background cBlack")
        }
    }

    ToggleDarkMode() {
        this.DarkMode := !this.DarkMode
        return this.DarkMode
    }
}

app := TestClass()
app.ToggleDarkMode()
