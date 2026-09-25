# DAP (Debug Adapter Protocol) Support

The MCP server can expose AutoHotkey's DBGp debugger via **DAP**, the protocol
that VS Code, Cursor, and JetBrains IDEs use to talk to any debugger. With this
enabled, a generic DAP client can debug `.ahk` scripts without installing an
AHK-specific extension.

## Architecture

```
VS Code / Cursor / JetBrains
            |
            |  DAP (TCP, Content-Length framed JSON)
            v
     port 9001 (default)
            |
  DapServer ──► DapSession ──► DBGpClient ──► port 9000 ──► AutoHotkey.exe /Debug
```

- The DAP server is a **TCP listener** that sits alongside the MCP server in the
  same Node process.
- Each DAP client that connects gets a new `DapSession` which owns a
  `DBGpClient`. The session translates DAP requests into DBGp commands and
  pushes DAP events (`stopped`, `continued`, `terminated`, `output`) back out.
- `src/core/dbgp-client.ts` is **untouched**. The translator only uses its
  public methods.

## Enabling

The DAP server is **off by default**. Turn it on with:

```bash
AHK_DAP_ENABLED=1 node dist/index.js
```

Optional env vars:

| Variable          | Default     | Purpose                                                                                  |
| ----------------- | ----------- | ---------------------------------------------------------------------------------------- |
| `AHK_DAP_ENABLED` | `0`         | Set to `1` to start the DAP server.                                                      |
| `AHK_DAP_PORT`    | `9001`      | TCP port the DAP server binds. Falls back to next free port if the chosen one is in use. |
| `AHK_BINARY`      | auto-detect | Path to `AutoHotkey64.exe`. Used by `launch` requests.                                   |

The server logs the resolved port at startup:

```
[2026-04-17T12:34:56.000Z] INFO: DAP server listening on 127.0.0.1:9001
[2026-04-17T12:34:56.001Z] INFO: DAP translator listening on port 9001
```

## launch vs attach

### launch

The DAP server spawns `AutoHotkey64.exe /Debug <program>` itself. The DBGp
listener is started _before_ the spawn so AHK can connect back.

```jsonc
{
  "type": "debugpy",
  "request": "launch",
  "name": "AHK (launch)",
  "program": "C:\\path\\to\\your_script.ahk",
  "cwd": "C:\\path\\to",
  "args": [],
  // Optional:
  // "ahkPath": "C:\\Tools\\AutoHotkey64.exe",
  // "dbgpPort": 9000,
  // "stopOnEntry": false
}
```

### attach

No process is spawned — you start AHK yourself and the DAP session connects its
`DBGpClient` to AHK's outbound DBGp stream.

```bash
AutoHotkey64.exe /Debug C:\path\to\your_script.ahk
```

```jsonc
{
  "type": "debugpy",
  "request": "attach",
  "name": "AHK (attach)",
  "connect": { "host": "localhost", "port": 9001 },
  "dbgpPort": 9000,
}
```

> **Why `"type": "debugpy"`?** Generic DAP clients like VS Code's debugpy
> connector work out of the box because they speak raw DAP. If your editor ships
> a dedicated "Debug Adapter Protocol" type (e.g. JetBrains' _Attach to DAP
> server_), use that.

## Minimal `.vscode/launch.json`

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "debugpy",
      "request": "attach",
      "name": "AHK (DAP)",
      "connect": { "host": "localhost", "port": 9001 }
    }
  ]
}
```

## DAP messages implemented

Requests: `initialize`, `launch`, `attach`, `configurationDone`,
`setBreakpoints`, `setExceptionBreakpoints`, `threads`, `stackTrace`, `scopes`,
`variables`, `continue`, `next`, `stepIn`, `stepOut`, `pause`, `evaluate`,
`source`, `disconnect`.

Events emitted: `initialized`, `stopped`, `continued`, `terminated`, `output`,
`thread`.

## Known limitations

- **`pause` fidelity is best-effort.** DBGp does not have an explicit break
  instruction; the request succeeds but AHK won't stop until it hits the next
  statement. Well-behaved scripts (loops) stop almost immediately.
- **`source` by reference is not supported.** The adapter assumes the DAP client
  has access to the source file paths returned in stack frames.
- **Child variable drill-down is flattened.** When you expand a complex variable
  in the client, the adapter evaluates the full name and returns the scalar form
  rather than recursively walking DBGp property children. Good enough for most
  scripts; richer property-tree walking is a future enhancement.
- **Single DAP client at a time.** A second TCP connection while one session is
  active is closed immediately. Disconnect the first client before connecting
  another.

## Manual verification

```bash
AHK_DAP_ENABLED=1 AHK_DAP_PORT=9001 node dist/index.js
```

```bash
C:\path\to\AutoHotkey64.exe /Debug C:\path\to\your_script.ahk
```

Then in VS Code / Cursor: Run and Debug → pick `AHK (DAP)` → set a breakpoint in
your `.ahk` file → the session hits it and stops.
