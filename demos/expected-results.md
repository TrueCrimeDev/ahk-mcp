# Expected Results for Window Detection Test

## Your AutoHotkey Test Script Analysis

**Script:** `C:\path\to\your\test-script.ahk`

**What the script does:**
- Creates a GUI window with title (default: no custom title, so it would be the script name)
- Size: 280x160 pixels
- Contains: Text input field, Submit button, Cancel button
- Shows GUI with `this.gui.Show("w280 h160")`

## Expected MCP Responses

### Test 1: WITHOUT Window Detection
```
Request: { mode: "run", wait: false, detectWindow: false, filePath: "C:\\...\\__Test-MCP.ahk" }

Response:
AHK launched: C:\path\to\your\test-script.ahk

{
  "command": "\"C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey64.exe\" \"C:\\path\\to\\your\\test-script.ahk\"",
  "runner": "native",
  "waited": false,
  "exitCode": null,
  "pid": 15432,
  "started": true,
  "filePath": "C:\\path\\to\\your\\test-script.ahk",
  "ahkPath": "C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey64.exe"
}
```

### Test 2: WITH Window Detection ENABLED
```
Request: { mode: "run", wait: false, detectWindow: true, windowDetectTimeout: 5000, filePath: "C:\\...\\__Test-MCP.ahk" }

Response:
AHK launched: C:\path\to\your\test-script.ahk
✅ Window detected: test-script.ahk

{
  "command": "\"C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey64.exe\" \"C:\\path\\to\\your\\test-script.ahk\"",
  "runner": "native",
  "waited": false,
  "exitCode": null,
  "pid": 15487,
  "started": true,
  "windowDetected": true,
  "windowInfo": {
    "title": "test-script.ahk",
    "pid": 15487,
    "detectionTime": 320
  },
  "filePath": "C:\\path\\to\\your\\test-script.ahk",
  "ahkPath": "C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey64.exe"
}
```

## Key Differences

| Feature | Without Detection | With Detection |
|---------|------------------|----------------|
| **windowDetected** | `undefined` | `true` |
| **windowInfo** | Not present | `{ title, pid, detectionTime }` |
| **Visual Feedback** | None | "✅ Window detected: __Test-MCP.ahk" |
| **Response Time** | Immediate | +320ms for detection |

## Technical Process

### Window Detection Steps:
1. **Launch Script** → Gets PID (e.g., 15487)
2. **PowerShell Query** → `Get-Process -Id 15487 | ForEach-Object { $_.MainWindowTitle }`
3. **Poll Every 100ms** → Check for window title
4. **Detection Success** → Returns window info
5. **Timeout Handling** → 5000ms max wait time

### What This Enables:
- ✅ **Confirm GUI Launch** - Know your script's window actually appeared
- ✅ **Get Window Title** - Automatically discover the window name
- ✅ **Timing Analysis** - See how long the GUI takes to load (320ms)
- ✅ **Error Detection** - If no window appears, something went wrong
- ✅ **Automation Ready** - Can trigger next steps based on window state

## Real-World Usage

This feature is especially useful for:
- **GUI Testing** - Verify interfaces launch correctly
- **Automation Workflows** - Chain actions after GUI appears
- **Performance Monitoring** - Track GUI startup times
- **Error Handling** - Detect failed GUI launches
- **Development Debugging** - Confirm window properties

The MCP becomes a "state-aware" tool that not only runs your scripts but **verifies they're working** by detecting their visual presence!