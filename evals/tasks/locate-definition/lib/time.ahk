; Time helpers
; Stamp() is used by main.ahk

; Formats a YYYYMMDDHH24MISS timestamp
Stamp(ts) {
  return FormatTime(ts, "yyyy-MM-dd HH:mm")
}
