# Claude Extension Setup Guide

**Date:** October 20, 2025 **Purpose:** Convert AHK MCP Server to a Claude
Extension for mobile access

---

## Overview

Claude Extensions allow your MCP server to work on:

- ✅ **Claude Desktop** (Windows, Mac, Linux)
- ✅ **Claude Mobile App** (iOS, Android)
- ✅ **Claude Web** (Browser)

Unlike stdio-only MCP servers in `claude_desktop_config.json`, extensions are:

- **Portable**: Work across all Claude platforms
- **Discoverable**: Show up in Claude's extension marketplace
- **Shareable**: Can be published for others to use

---

## Extension vs. Desktop Config

| Feature        | Desktop Config (stdio) | Claude Extension                      |
| -------------- | ---------------------- | ------------------------------------- |
| Claude Desktop | ✅ Yes                 | ✅ Yes                                |
| Claude Mobile  | ❌ No                  | ✅ Yes                                |
| Claude Web     | ❌ No                  | ✅ Yes                                |
| Installation   | Manual JSON edit       | Install from marketplace or directory |
| Updates        | Manual                 | Automatic                             |
| Discovery      | None                   | Listed in Claude UI                   |

---

## Prerequisites

1. **Node.js 18+** (already installed ✅)
2. **Built dist/** directory (`npm run build`) ✅
3. **Icon image** (512x512 PNG recommended)

---

## Step 1: Create Extension Icon

Create a 512x512 PNG icon for your extension:

**Option 1: Use AI Image Generator**

```
Prompt: "Create a professional icon for an AutoHotkey development tool.
Features: Red/white color scheme, keyboard/automation theme, modern flat design,
512x512 pixels, transparent or white background."
```

**Option 2: Use Online Tool**

- Canva: https://www.canva.com/
- Figma: https://www.figma.com/
- Adobe Express: https://www.adobe.com/express/

**Save as:**

```
C:\\Users\\YourUsername\Documents\Design\Coding\ahk-mcp\extension\icon.png
```

**Temporary Placeholder:** If you don't have an icon yet, copy any PNG:

```bash
# Use Windows Logo as placeholder (not recommended for production)
copy C:\Windows\System32\@WindowsAnimationLogo.png extension\icon.png
```

---

## Step 2: Verify Manifest

The manifest lives at:

```
C:\\Users\\YourUsername\Documents\Design\Coding\ahk-mcp\extension\manifest.json
```

If you only see `manifest.json.disabled`, rename it to `manifest.json` or let
the installer handle it.

**Key Fields to Customize:**

```json
{
  "author": {
    "name": "Your Name", // ← Change this
    "email": "your.email@example.com", // ← Change this
    "url": "https://github.com/yourusername" // ← Change this
  },
  "homepage": "https://github.com/yourusername/ahk-mcp", // ← Change this
  "repository": {
    "url": "git+https://github.com/yourusername/ahk-mcp.git" // ← Change this
  }
}
```

---

## Step 3: Build Extension Package

Extension assets live under `extension/`; the installer copies them to the
extension package root:

```
ahk-mcp/
├── extension/
│   ├── manifest.json  ← Created ✅
│   └── icon.png      ← You need to add this
├── dist/              ← Already exists ✅
│   └── index.js       ← Entry point
├── node_modules/      ← Already exists ✅
└── package.json       ← Already exists ✅
```

**Verify structure:**

```bash
cd C:\\Users\\YourUsername\Documents\Design\Coding\ahk-mcp

# Check files exist
ls extension/manifest.json
ls extension/icon.png
ls dist/index.js
ls package.json
```

---

## Step 4: Install Extension Locally

### Method 1: Direct Copy (Development)

Copy the required files to Claude Extensions folder:

```powershell
$src = "C:\\Users\\YourUsername\Documents\Design\Coding\ahk-mcp"
$dest = "C:\\Users\\YourUsername\AppData\Roaming\Claude\Claude Extensions\ahk-mcp"

New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item "$src\extension\manifest.json" "$dest\manifest.json" -Force
Copy-Item "$src\extension\icon.png" "$dest\icon.png" -Force -ErrorAction SilentlyContinue
Copy-Item "$src\package.json" "$dest\package.json" -Force
Copy-Item "$src\dist" "$dest\dist" -Recurse -Force
Copy-Item "$src\data" "$dest\data" -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item "$src\docs" "$dest\docs" -Recurse -Force -ErrorAction SilentlyContinue
```

**What NOT to copy** (exclude these):

```
- .git/
- node_modules/ (if large, may need to reinstall)
- src/ (not needed in production)
- tests/
- .specify/
```

### Method 2: Create Extension Package (Production)

For cleaner installation:

```bash
cd C:\\Users\\YourUsername\Documents\Design\Coding\ahk-mcp

# Create extension directory
mkdir extension-package

# Copy essential files
copy extension\manifest.json extension-package\
copy extension\icon.png extension-package\
copy package.json extension-package\
xcopy /E /I dist extension-package\dist
xcopy /E /I data extension-package\data
xcopy /E /I docs extension-package\docs

# Install production dependencies only
cd extension-package
npm ci --only=production

# Copy to Claude Extensions
cd ..
xcopy /E /I extension-package "C:\\Users\\YourUsername\AppData\Roaming\Claude\Claude Extensions\ahk-mcp"
```

---

## Step 5: Create \_update_metadata.json

Claude Extensions need metadata for updates:

```bash
cd "C:\\Users\\YourUsername\AppData\Roaming\Claude\Claude Extensions\ahk-mcp"

# Create metadata file
cat > _update_metadata.json << 'EOF'
{
  "extensionId": "ahk-mcp",
  "version": "2.0.0",
  "downloadedAt": <TIMESTAMP>,
  "manifest": <MANIFEST_CONTENT>,
  "isInternalDxt": false
}
EOF
```

Or use PowerShell:

```powershell
$extensionDir = "C:\\Users\\YourUsername\AppData\Roaming\Claude\Claude Extensions\ahk-mcp"
$manifest = Get-Content "$extensionDir\manifest.json" | ConvertFrom-Json
$timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

@{
  extensionId = "ahk-mcp"
  version = "2.0.0"
  downloadedAt = $timestamp
  manifest = $manifest
  isInternalDxt = $false
} | ConvertTo-Json -Depth 10 | Set-Content "$extensionDir\_update_metadata.json"
```

---

## Step 6: Restart Claude

1. **Quit Claude Desktop completely** (File → Quit, not just close)
2. **Reopen Claude Desktop**
3. Extension should load automatically

**Verify installation:**

```
Settings → Extensions → Should see "AutoHotkey v2 MCP"
```

---

## Step 7: Access on Mobile

Once installed as an extension on desktop, it will automatically sync to:

### Claude iOS App

1. Open Claude app
2. Go to Settings → Extensions
3. "AutoHotkey v2 MCP" should appear
4. Toggle to enable

### Claude Android App

1. Open Claude app
2. Go to Settings → Extensions
3. "AutoHotkey v2 MCP" should appear
4. Toggle to enable

**Note:** Mobile access requires the extension to be enabled on your Claude
account, not just installed locally.

---

## Troubleshooting

### Extension Not Showing Up

**Check extension directory:**

```bash
ls "C:\\Users\\YourUsername\AppData\Roaming\Claude\Claude Extensions\ahk-mcp"

# Should see:
# - manifest.json
# - icon.png
# - dist/index.js
# - _update_metadata.json
# - package.json
# - node_modules/
```

**Check manifest validation:**

```bash
cd "C:\\Users\\YourUsername\AppData\Roaming\Claude\Claude Extensions\ahk-mcp"
node -e "console.log(JSON.parse(require('fs').readFileSync('manifest.json')))"
```

**Check Claude logs:**

```
C:\\Users\\YourUsername\AppData\Roaming\Claude\logs\
```

Look for errors mentioning "ahk-mcp" or "extension".

### Extension Shows But Tools Don't Work

**Check dist/index.js has shebang:**

```bash
head -1 "C:\\Users\\YourUsername\AppData\Roaming\Claude\Claude Extensions\ahk-mcp\dist\index.js"

# Should output:
#!/usr/bin/env node
```

**Add shebang if missing:**

Edit `src/index.ts`:

```typescript
#!/usr/bin/env node
import { AutoHotkeyMCPServer } from './server.js';
// ... rest of file
```

Then rebuild:

```bash
npm run build
```

### Node Modules Missing

Extensions need their own node_modules:

```bash
cd "C:\\Users\\YourUsername\AppData\Roaming\Claude\Claude Extensions\ahk-mcp"
npm ci --only=production
```

### Permission Errors

**Windows:** Run as Administrator if copying fails:

```bash
# PowerShell (Admin)
$src = "C:\\Users\\YourUsername\Documents\Design\Coding\ahk-mcp"
$dest = "C:\\Users\\YourUsername\AppData\Roaming\Claude\Claude Extensions\ahk-mcp"
Copy-Item "$src\extension\manifest.json" "$dest\manifest.json" -Force
Copy-Item "$src\extension\icon.png" "$dest\icon.png" -Force -ErrorAction SilentlyContinue
Copy-Item "$src\package.json" "$dest\package.json" -Force
Copy-Item "$src\dist" "$dest\dist" -Recurse -Force
```

---

## Development Workflow

### Making Changes

When you update your MCP server:

```bash
# 1. Make changes to src/
# (edit your TypeScript files)

# 2. Rebuild
cd C:\\Users\\YourUsername\Documents\Design\Coding\ahk-mcp
npm run build

# 3. Copy updated dist/ to extension
xcopy /E /Y /I dist "C:\\Users\\YourUsername\AppData\Roaming\Claude\Claude Extensions\ahk-mcp\dist"

# 4. Restart Claude Desktop
# (Quit and reopen)
```

### Quick Update Script

Create `update-extension.ps1`:

```powershell
# Build
npm run build

# Copy to extension directory
$src = "C:\\Users\\YourUsername\Documents\Design\Coding\ahk-mcp"
$dest = "C:\\Users\\YourUsername\AppData\Roaming\Claude\Claude Extensions\ahk-mcp"

Copy-Item "$src\dist" "$dest\dist" -Recurse -Force
Copy-Item "$src\extension\manifest.json" "$dest\manifest.json" -Force

Write-Host "Extension updated! Restart Claude Desktop to apply changes."
```

**Run:**

```powershell
.\update-extension.ps1
```

---

## Publishing Your Extension (Optional)

To share your extension with others:

### Option 1: GitHub Release

1. **Create GitHub repository** (if not already)
2. **Add extension files:**

   ```bash
   git add extension/manifest.json extension/icon.png
   git commit -m "Add Claude Extension support"
   git push
   ```

3. **Create release:**
   - Go to GitHub → Releases → Create new release
   - Tag: `v2.0.0`
   - Upload extension package ZIP

4. **Installation instructions:**
   ```bash
   # Users can install via:
   git clone https://github.com/yourusername/ahk-mcp.git
   cd ahk-mcp
   npm install
   npm run build
   # Then copy to Claude Extensions directory
   ```

### Option 2: Claude Extension Marketplace (Future)

Anthropic may add an extension marketplace. Your extension would be ready to
submit with:

- ✅ Valid manifest.json
- ✅ Icon
- ✅ Documentation
- ✅ Working dist/ build

---

## Extension Features

### Automatic Features

Extensions automatically get:

- ✅ **Tool Discovery**: All 33 tools listed in Claude UI
- ✅ **Resource Access**: Documentation and standards available
- ✅ **Prompt Templates**: Built-in AutoHotkey prompts
- ✅ **Cross-Platform**: Works on desktop + mobile + web
- ✅ **Updates**: Can be updated without reinstalling

### Configuration

Users can configure your extension via Claude settings:

```json
{
  "env": {
    "AHK_MCP_LOG_LEVEL": "debug",
    "NODE_ENV": "production"
  }
}
```

---

## Comparison: Desktop Config vs Extension

### Keep Desktop Config For:

- ✅ Local development (faster iteration)
- ✅ Custom environment variables
- ✅ Absolute path requirements
- ✅ Development builds

### Use Extension For:

- ✅ Production use
- ✅ Mobile access
- ✅ Sharing with others
- ✅ Automatic updates
- ✅ Better discoverability

**You can have BOTH!**

- Desktop config: Points to development directory
- Extension: Stable production version

---

## Complete Extension Checklist

- [ ] Create extension/icon.png (512x512)
- [ ] Update extension/manifest.json author info
- [ ] Verify dist/index.js has shebang `#!/usr/bin/env node`
- [ ] Build project: `npm run build`
- [ ] Copy files to `Claude Extensions\ahk-mcp\`
- [ ] Install node_modules in extension dir
- [ ] Create \_update_metadata.json
- [ ] Restart Claude Desktop
- [ ] Verify extension shows in Settings → Extensions
- [ ] Test tools in Claude chat
- [ ] Check mobile app (if applicable)

---

## Quick Reference

### File Locations

**Development:**

```
C:\\Users\\YourUsername\Documents\Design\Coding\ahk-mcp\
```

**Extension:**

```
C:\\Users\\YourUsername\AppData\Roaming\Claude\Claude Extensions\ahk-mcp\
```

**Desktop Config:**

```
C:\\Users\\YourUsername\AppData\Roaming\Claude\claude_desktop_config.json
```

### Key Commands

```bash
# Build
npm run build

# Copy extension
xcopy /E /I /Y "src" "dest"

# Restart Claude (quit completely first)
# File → Quit → Reopen

# Verify installation
ls "C:\\Users\\YourUsername\AppData\Roaming\Claude\Claude Extensions\ahk-mcp\manifest.json"
```

---

## Example: Full Setup Script

Save as `extension/install-extension.ps1`:

```powershell
#!/usr/bin/env pwsh

# Configuration
$projectDir = "C:\\Users\\YourUsername\Documents\Design\Coding\ahk-mcp"
$extensionDir = "C:\\Users\\YourUsername\AppData\Roaming\Claude\Claude Extensions\ahk-mcp"

Write-Host "Building AHK MCP Extension..." -ForegroundColor Cyan

# Build
cd $projectDir
npm run build

# Create extension directory
New-Item -ItemType Directory -Force -Path $extensionDir | Out-Null

# Copy essential files
Write-Host "Copying files..." -ForegroundColor Cyan
Copy-Item "$projectDir\extension\manifest.json" "$extensionDir\manifest.json" -Force
Copy-Item "$projectDir\extension\icon.png" "$extensionDir\icon.png" -Force -ErrorAction SilentlyContinue
Copy-Item "$projectDir\package.json" "$extensionDir\" -Force
Copy-Item "$projectDir\dist" "$extensionDir\dist" -Recurse -Force
Copy-Item "$projectDir\data" "$extensionDir\data" -Recurse -Force
Copy-Item "$projectDir\docs" "$extensionDir\docs" -Recurse -Force

# Install production dependencies
Write-Host "Installing dependencies..." -ForegroundColor Cyan
cd $extensionDir
npm ci --only=production --silent

# Create metadata
Write-Host "Creating metadata..." -ForegroundColor Cyan
$manifest = Get-Content "$extensionDir\manifest.json" | ConvertFrom-Json
$timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

@{
  extensionId = "ahk-mcp"
  version = "2.0.0"
  downloadedAt = $timestamp
  manifest = $manifest
  isInternalDxt = $false
} | ConvertTo-Json -Depth 10 | Set-Content "$extensionDir\_update_metadata.json"

Write-Host "`n✅ Extension installed successfully!" -ForegroundColor Green
Write-Host "`nNext steps:" -ForegroundColor Yellow
Write-Host "1. Quit Claude Desktop completely (File → Quit)"
Write-Host "2. Reopen Claude Desktop"
Write-Host "3. Check Settings → Extensions for 'AutoHotkey v2 MCP'"
Write-Host "4. Test tools in Claude chat"
```

**Run:**

```powershell
.\extension\install-extension.ps1
```

---

## Related Documentation

- [REMOTE_ACCESS_GUIDE.md](./REMOTE_ACCESS_GUIDE.md) - Remote/SSE access
- [DOCKER_SETUP_SUMMARY.md](./DOCKER_SETUP_SUMMARY.md) - Docker deployment
- [README.md](../README.md) - General usage

---

## Summary

### What You Need:

1. ✅ **extension/manifest.json** - Extension manifest template
2. ⏳ **extension/icon.png** - You need to create (512x512 PNG)
3. ✅ **dist/** directory - Already built
4. ✅ **package.json** - Already exists

### Installation Steps:

1. Create extension/icon.png
2. Copy files to `Claude Extensions\ahk-mcp\`
3. Run `npm ci --only=production` in extension dir
4. Create \_update_metadata.json
5. Restart Claude Desktop

### Result:

- ✅ Works on Claude Desktop
- ✅ Works on Claude Mobile App
- ✅ Works on Claude Web
- ✅ All 33 tools available
- ✅ Automatic sync across devices

---

_Last Updated: October 20, 2025_ _Extension Format: dxt_version 0.1_


