#Requires AutoHotkey v2.0
clicks := 0
g := Gui("+Resize", "Counter")
btn := g.AddButton("w120", "Click me")
btn.OnEvent("Click", (*) => Count())
g.Show()

Count() {
  global clicks
  clicks++
}

^j::{
  MsgBox("Clicks so far")
}
