# Remote Access Guide - AHK MCP Server

> **Protocol update (July 2026):** Streamable HTTP at `/mcp` is the supported
> remote transport. The SSE instructions below are retained only for legacy
> clients and require `AHK_MCP_LEGACY_SSE=1`. For current host binding, Origin,
> bearer-token, and rate-limit settings, use
> [MCP Transport Compatibility](MCP_TRANSPORT_COMPATIBILITY.md).

**Date:** October 20, 2025 **Purpose:** Configure Claude Desktop and remote
access via SSE/HTTPS

---

## Table of Contents

1. [Claude Desktop Setup](#claude-desktop-setup) (Local Access)
2. [Remote Access via SSE](#remote-access-via-sse) (ChatGPT, Remote LLMs)
3. [HTTPS Setup for Production](#https-setup-for-production)
4. [Network Configuration](#network-configuration)
5. [Security Considerations](#security-considerations)

---

## Claude Desktop Setup

### Current Configuration ✅

Your Claude Desktop is **already configured** at:

```
C:\\Users\\YourUsername\AppData\Roaming\Claude\claude_desktop_config.json
```

**Configuration:**

```json
{
  "mcpServers": {
    "ahk-server": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "C:\\Users\\YourUsername\\Documents\\Design\\Coding\\ahk-mcp\\dist\\index.js"
      ],
      "env": {
        "NODE_ENV": "production",
        "AHK_MCP_LOG_LEVEL": "debug"
      },
      "alwaysAllow": [
        "AHK_Smart_Orchestrator",
        "AHK_File_Edit_Advanced",
        ...
      ]
    }
  }
}
```

### Why Local (Not Docker)?

Claude Desktop requires **stdio transport**:

- ✅ Local: Direct stdin/stdout communication
- ❌ Docker: Containers don't expose stdio easily
- ✅ Best Performance: No network overhead

### Update Steps

When you make changes to the server:

```bash
# 1. Rebuild TypeScript
cd C:\\Users\\YourUsername\Documents\Design\Coding\ahk-mcp
npm run build

# 2. Restart Claude Desktop
# - Quit Claude Desktop (File → Quit)
# - Reopen Claude Desktop
# - Server will auto-start with new build
```

### Verify Connection

After restarting Claude Desktop, ask Claude:

```
Can you use the AHK_Config tool to show me your configuration?
```

If successful, you'll see server details and available tools.

### Troubleshooting

**Issue: "MCP server not responding"**

Check logs:

```
C:\\Users\\YourUsername\AppData\Roaming\Claude\logs\mcp*.log
```

Common fixes:

- Ensure `dist/index.js` exists: `ls dist/index.js`
- Check Node.js path: `where node`
- Verify build: `npm run build`
- Restart Claude Desktop completely

---

## Remote Access via SSE

### Overview

For **remote access** (ChatGPT, other LLMs, network access), use the **SSE
Docker container**:

```
Local:    C:\Users\...\dist\index.js  (stdio - Claude Desktop)
Remote:   Docker container on port 3000 (SSE - Network access)
```

### Current SSE Setup ✅

Your SSE container is already running:

```bash
$ docker-compose ps
NAME          STATUS                    PORTS
ahk-mcp-sse   Up and healthy           0.0.0.0:3000->3000/tcp
```

**SSE Endpoint:**

```
http://localhost:3000/sse
```

### Access Methods

#### 1. Local Network Access

From any device on your network:

```bash
# Replace <YOUR_IP> with your computer's IP address
# Find IP: ipconfig (Windows) or hostname -I (Linux)

http://<YOUR_IP>:3000/sse
```

**Example:**

```
http://192.168.1.100:3000/sse
```

#### 2. ChatGPT Actions

Configure ChatGPT to use your MCP server:

**ChatGPT Action Configuration:**

```json
{
  "openapi": "3.0.0",
  "info": {
    "title": "AutoHotkey MCP Server",
    "version": "2.0.0"
  },
  "servers": [
    {
      "url": "http://<YOUR_IP>:3000"
    }
  ],
  "paths": {
    "/sse": {
      "get": {
        "summary": "Connect to MCP Server",
        "operationId": "connectMCP",
        "responses": {
          "200": {
            "description": "SSE connection established"
          }
        }
      }
    }
  }
}
```

**Note:** ChatGPT can only access public IPs or use ngrok/cloudflare tunnels for
local development.

#### 3. Test Connection

```bash
# Test health endpoint
curl http://localhost:3000/health

# Expected response:
{
  "status": "ok",
  "server": "AutoHotkey MCP Server",
  "mode": "SSE",
  "uptime": 123.45,
  "memory": {...}
}

# Test SSE endpoint
curl http://localhost:3000/sse

# Expected response:
event: endpoint
data: /message?sessionId=abc123...
```

---

## HTTPS Setup for Production

### Why HTTPS?

For **production remote access**, you need HTTPS:

- ✅ Encrypted communication
- ✅ Required for ChatGPT Actions
- ✅ Browser security requirements
- ✅ Industry standard

### Option 1: Reverse Proxy (Recommended)

Use **nginx** or **Caddy** as a reverse proxy with automatic HTTPS:

#### Using Caddy (Easiest)

**Install Caddy:**

```bash
# Windows (via Chocolatey)
choco install caddy

# Or download from: https://caddyserver.com/download
```

**Caddyfile:**

```caddy
ahk-mcp.yourdomain.com {
    reverse_proxy localhost:3000

    # Optional: Basic auth
    basicauth /* {
        admin $2a$14$...hashed_password...
    }

    # CORS for ChatGPT
    header Access-Control-Allow-Origin *
    header Access-Control-Allow-Methods "GET, POST, OPTIONS"
}
```

**Start Caddy:**

```bash
caddy run --config Caddyfile
```

Caddy automatically:

- Gets SSL certificate from Let's Encrypt
- Renews certificates
- Redirects HTTP → HTTPS

**Result:**

```
https://ahk-mcp.yourdomain.com/sse
```

#### Using nginx

**nginx.conf:**

```nginx
server {
    listen 443 ssl http2;
    server_name ahk-mcp.yourdomain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;

        # SSE specific
        proxy_set_header Connection '';
        proxy_http_version 1.1;
        chunked_transfer_encoding off;
        proxy_buffering off;
        proxy_cache off;
    }

    # Health check
    location /health {
        proxy_pass http://localhost:3000/health;
    }
}
```

### Option 2: Cloudflare Tunnel (Free)

For **development/testing** without a domain:

**Install Cloudflare Tunnel:**

```bash
# Download from: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/

# Or via npm
npm install -g cloudflared
```

**Start Tunnel:**

```bash
cloudflared tunnel --url http://localhost:3000
```

**Output:**

```
Your quick Tunnel has been created! Visit it at:
https://random-name-1234.trycloudflare.com
```

**Benefits:**

- ✅ Free HTTPS
- ✅ No domain needed
- ✅ No port forwarding
- ✅ Works behind firewalls

**Limitations:**

- ⚠️ Random URL changes each restart
- ⚠️ Not for production use

### Option 3: ngrok (Alternative)

```bash
# Install ngrok
choco install ngrok

# Start tunnel
ngrok http 3000
```

**Output:**

```
Forwarding: https://abc123.ngrok.io → http://localhost:3000
```

---

## Network Configuration

### Firewall Rules

To allow remote access, configure Windows Firewall:

**PowerShell (Admin):**

```powershell
# Allow port 3000 inbound
New-NetFirewallRule -DisplayName "AHK MCP Server" `
  -Direction Inbound `
  -LocalPort 3000 `
  -Protocol TCP `
  -Action Allow
```

**Or via GUI:**

1. Windows Defender Firewall → Advanced Settings
2. Inbound Rules → New Rule
3. Port → TCP → 3000 → Allow

### Router Port Forwarding

For **internet access**, configure your router:

1. Login to router admin panel (usually 192.168.1.1)
2. Find "Port Forwarding" or "NAT" section
3. Add rule:
   - **External Port:** 3000
   - **Internal IP:** Your computer's IP (e.g., 192.168.1.100)
   - **Internal Port:** 3000
   - **Protocol:** TCP

**Security Warning:** Only expose port 3000 if you:

- Use HTTPS (via reverse proxy)
- Have authentication enabled
- Trust all network clients

### Docker Network Settings

Current configuration exposes on all interfaces:

```yaml
# docker-compose.yml
ports:
  - "0.0.0.0:3000:3000"  # All interfaces

# For localhost only (more secure):
ports:
  - "127.0.0.1:3000:3000"  # Localhost only
```

---

## Security Considerations

### Authentication

The MCP server **does not have built-in authentication**. For production:

#### Option 1: Reverse Proxy Auth

**Caddy with Basic Auth:**

```caddy
ahk-mcp.yourdomain.com {
    reverse_proxy localhost:3000

    basicauth /* {
        admin JDJhJDE0JFpRN3...
    }
}
```

**Generate password:**

```bash
caddy hash-password
```

#### Option 2: API Key Middleware

Add custom auth to `src/server.ts`:

```typescript
app.use((req, res, next) => {
  const apiKey = req.headers['x-api-key'];

  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
});
```

### Network Isolation

**Development:**

```yaml
# docker-compose.yml
ports:
  - '127.0.0.1:3000:3000' # Localhost only
```

**Production:**

```yaml
# Use reverse proxy on different port
# Only expose HTTPS port 443 externally
```

### Input Validation

Already implemented via Zod schemas:

- ✅ All tool inputs validated
- ✅ Path sanitization
- ✅ Type checking
- ✅ Error handling

### Rate Limiting

For public access, add rate limiting:

```typescript
import rateLimit from 'express-rate-limit';

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests',
});

app.use('/sse', limiter);
```

---

## Complete Setup Examples

### Example 1: Local Development Only

**Use Case:** Claude Desktop on local machine

```bash
# Build server
npm run build

# Claude Desktop config (already set)
# Uses: dist/index.js via stdio

# No network exposure needed
```

**Security:** ✅ Maximum (local only)

### Example 2: Local Network Access

**Use Case:** Access from other devices on your home network

```bash
# Start SSE container
docker-compose up -d sse

# Find your IP
ipconfig  # Look for IPv4 Address

# Access from other devices
http://192.168.1.100:3000/sse
```

**Security:** ⚠️ Trusted network only

### Example 3: Public Internet Access (Development)

**Use Case:** Testing with ChatGPT or remote access

```bash
# Start SSE container
docker-compose up -d sse

# Start Cloudflare tunnel
cloudflared tunnel --url http://localhost:3000

# Use provided HTTPS URL
https://random-name.trycloudflare.com/sse
```

**Security:** ⚠️ Temporary, consider auth

### Example 4: Production Deployment

**Use Case:** Production server with HTTPS and auth

```bash
# 1. Deploy server with domain
# docker-compose up -d sse

# 2. Configure Caddy reverse proxy
# Caddyfile with auth + HTTPS

# 3. Configure firewall
# Only allow ports 80/443

# 4. Access via domain
https://ahk-mcp.yourdomain.com/sse
```

**Security:** ✅ Production-ready

---

## Quick Reference

| Access Method         | URL                                  | Security     | Use Case            |
| --------------------- | ------------------------------------ | ------------ | ------------------- |
| **Claude Desktop**    | N/A (stdio)                          | ✅ Local     | Primary development |
| **Local Network**     | http://192.168.x.x:3000/sse          | ⚠️ Trusted   | Home network        |
| **Cloudflare Tunnel** | https://random.trycloudflare.com/sse | ⚠️ Temporary | Quick testing       |
| **ngrok**             | https://abc123.ngrok.io/sse          | ⚠️ Temporary | Quick testing       |
| **Reverse Proxy**     | https://yourdomain.com/sse           | ✅ Secure    | Production          |

---

## Testing Checklist

### Claude Desktop

- [ ] Built latest changes: `npm run build`
- [ ] Restarted Claude Desktop
- [ ] Test tool: "Use AHK_Config to show configuration"
- [ ] Verify tools load in Claude UI

### Remote SSE

- [ ] SSE container running: `docker-compose ps`
- [ ] Health check: `curl http://localhost:3000/health`
- [ ] SSE endpoint: `curl http://localhost:3000/sse`
- [ ] Network access (if needed): `curl http://<YOUR_IP>:3000/health`
- [ ] HTTPS (if configured): `curl https://yourdomain.com/health`

---

## Troubleshooting

### Claude Desktop Not Connecting

**Symptom:** "MCP server not responding"

**Checks:**

1. Build exists: `ls dist/index.js`
2. Node works: `node dist/index.js` (should start server)
3. Path in config correct
4. Restart Claude Desktop (full quit + reopen)

### SSE Container Unhealthy

**Symptom:** Docker health check failing

**Checks:**

1. Health endpoint: `curl http://localhost:3000/health`
2. Container logs: `docker logs ahk-mcp-sse`
3. Restart: `docker-compose restart sse`

### Network Access Not Working

**Symptom:** Can't connect from other devices

**Checks:**

1. Container bound to 0.0.0.0: Check docker-compose.yml
2. Firewall allows port 3000: Test with `telnet <YOUR_IP> 3000`
3. Correct IP address: `ipconfig` (Windows) or `hostname -I` (Linux)

### HTTPS Certificate Issues

**Symptom:** "Certificate invalid" or "Not secure"

**Checks:**

1. Domain points to server IP: `nslookup yourdomain.com`
2. Caddy/nginx running: Check process
3. Certificate exists: Check reverse proxy logs
4. Port 80/443 accessible: Firewall and router config

---

## Related Documentation

- [DOCKER_SETUP_SUMMARY.md](./DOCKER_SETUP_SUMMARY.md) - Docker optimization
- [DOCKER_HEALTH_CHECK_FIX.md](./DOCKER_HEALTH_CHECK_FIX.md) - Health endpoint
  setup
- [SECURITY.md](../SECURITY.md) - Security policies
- [README.md](../README.md) - General usage

---

## Summary

### Two Access Methods

1. **Claude Desktop** (Local)
   - ✅ Already configured
   - Uses local `dist/index.js`
   - stdio transport
   - Update: `npm run build` + restart Claude

2. **Remote SSE** (Network)
   - ✅ Docker container running on port 3000
   - URL: `http://localhost:3000/sse`
   - For: ChatGPT, remote LLMs, network access
   - Production: Add HTTPS via reverse proxy

### Next Steps

**For Claude Desktop:**

1. `npm run build` (when you make changes)
2. Restart Claude Desktop
3. Test in Claude chat

**For Remote Access:**

1. Container already running ✅
2. Choose security level:
   - Development: Cloudflare tunnel
   - Production: Reverse proxy with HTTPS + auth
3. Configure firewall/router if needed
4. Test connection

---

_Last Updated: October 20, 2025_ _Status: Both local and remote access
configured_


