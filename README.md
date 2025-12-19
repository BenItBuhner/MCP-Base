# MCP Testing Client

A command-line MCP (Model Context Protocol) client that connects to remote MCP servers and uses Anthropic's Claude for LLM-powered tool execution.

## Features

- **Multiple Auth Methods**: Supports no auth, bearer tokens, and full OAuth flows
- **Multi-Server Config**: Define multiple MCP servers in a JSON file with different auth configurations
- **Environment Variable Placeholders**: Use `${ENV_VAR}` syntax in configs for secrets
- **Multi-Turn Tool Execution**: Automatically handles Claude's tool_use requests across multiple turns
- **Interactive CLI**: Simple chat interface with server selection
- **Local Server Support**: Run MCP servers locally via npx commands or custom executables

## Installation

```bash
bun install
```

## Configuration

### Environment Variables

Create a `.env` file (must be UTF-8 encoded):

```env
# Required - Anthropic configuration
ANTHROPIC_API_KEY=your-anthropic-api-key
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_MODEL=claude-sonnet-4-20250514

# Optional - MCP server tokens (referenced in mcp-servers.json)
NOTION_ACCESS_TOKEN=your-notion-token
NOTION_CLIENT_ID=your-oauth-client-id
NOTION_CLIENT_SECRET=your-oauth-client-secret
GITHUB_TOKEN=your-github-token
CUSTOM_API_KEY=your-custom-api-key

# Optional - Override default servers file
MCP_SERVERS_FILE=./mcp-servers.json

# Optional - Fallback URL if no servers file exists
MCP_URL=https://mcp.example.com/mcp
```

### Server Configuration

Create `mcp-servers.json` in the project root:

```json
[
  {
    "name": "Public Server",
    "url": "https://mcp.example.com/mcp",
    "auth": {
      "type": "none"
    }
  },
  {
    "name": "API Key Server",
    "url": "https://api.example.com/mcp",
    "auth": {
      "type": "bearer",
      "token": "${MY_API_TOKEN}"
    }
  },
  {
    "name": "OAuth Server",
    "url": "https://oauth.example.com/mcp",
    "auth": {
      "type": "oauth",
      "oauth": {
        "clientId": "${OAUTH_CLIENT_ID}",
        "clientSecret": "${OAUTH_CLIENT_SECRET}",
        "authorizationUrl": "https://oauth.example.com/authorize",
        "tokenUrl": "https://oauth.example.com/token",
        "redirectUri": "http://localhost:8090/callback",
        "scopes": ["read", "write"]
      }
    }
  },
  {
    "name": "Server with Custom Headers",
    "url": "http://localhost:3000/mcp",
    "headers": {
      "x-api-key": "${CUSTOM_API_KEY}",
      "x-client-version": "1.0.0"
    },
    "auth": {
      "type": "none"
    }
  }
]
```

### Local Server Configuration

For local MCP servers that run on your machine, use the following structure:

```json
[
  {
    "name": "Filesystem Server",
    "type": "local",
    "command": "npx",
    "args": ["@modelcontextprotocol/server-filesystem", "${HOME}/Documents"],
    "env": {
      "NODE_ENV": "development"
    }
  }
]
```

- `command`: The executable to run (e.g., "npx", "node", "python")
- `args`: Array of arguments passed to the command, supports `${ENV_VAR}` placeholders
- `env`: Optional environment variables for the server process, supports `${ENV_VAR}` placeholders

Local servers communicate via stdio and do not require authentication.

### Auth Types

| Type | Description | Config |
|------|-------------|--------|
| `none` | No authentication | `{ "type": "none" }` |
| `bearer` | Static bearer token | `{ "type": "bearer", "token": "${TOKEN}" }` |
| `oauth` | Full OAuth 2.0 flow | `{ "type": "oauth", "oauth": { ... } }` |

## Usage

### Run the CLI

```bash
bun src/cli.ts
```

### Server Selection

When you run the CLI, you'll see a list of configured servers:

```
Available MCP servers:
1. Context7 🌐
2. Notion (Bearer Token) 🌐 🔑
3. Notion (OAuth) 🌐 🔐
4. Custom Server with Headers 🌐
5. Filesystem Server 💻
Select server number:
```

- 🌐 indicates remote server
- 💻 indicates local server
- 🔑 indicates bearer token auth
- 🔐 indicates OAuth auth

### OAuth Flow

When connecting to an OAuth server:

1. The CLI starts a local callback server on port 8090
2. Your browser opens to the authorization URL
3. After you authorize, the browser redirects to the callback
4. The CLI exchanges the code for tokens automatically
5. Connection continues with the access token

### Chat Interface

Once connected:

```
MCP Client Started!
Type your queries or 'quit' to exit.

Query: What tools are available?

Query: quit
```

## Project Structure

```
mcp-testing/
├── src/
│   ├── cli.ts      # Main CLI application
│   ├── oauth.ts    # OAuth providers (CLI and Delegated)
│   └── types.ts    # TypeScript type definitions
├── mcp-servers.json # Server configurations
├── .env            # Environment variables (not committed)
├── package.json
├── tsconfig.json
└── README.md
```

## OAuth Providers

### CLIOAuthProvider

For CLI/desktop applications:

- Opens system browser for authorization
- Runs local HTTP server to receive callback
- Exchanges authorization code for tokens
- Cross-platform browser opening (Windows, macOS, Linux)

### DelegatedOAuthProvider

For web applications where frontend handles auth:

```typescript
import { DelegatedOAuthProvider } from "./src/oauth.js";

const provider = new DelegatedOAuthProvider(oauthConfig, {
  onAuthRequired: async (authUrl, state) => {
    // Signal frontend to open authUrl
    await sendToFrontend({ type: "auth_required", authUrl, state });
  },
  getAuthorizationCode: async (state) => {
    // Wait for frontend to POST code back
    return await waitForCodeFromFrontend(state);
  },
  onTokensReceived: async (tokens) => {
    // Persist tokens to database
    await saveTokens(userId, serverId, tokens);
  },
});
```

## Troubleshooting

### dotenv shows "injecting env (0)"

Your `.env` file may be saved as UTF-16 (common on Windows/PowerShell). Fix:

1. Open `.env` in VS Code
2. Click encoding in bottom-right status bar
3. Select "Save with Encoding" → "UTF-8"

### OAuth callback timeout

- Ensure port 8090 is available
- Check firewall settings
- Verify `redirectUri` matches exactly what's registered with the OAuth provider

### "Invalid token" errors

- Check that your token environment variable is set correctly
- Ensure the token hasn't expired
- Verify the token has the required scopes

## Development

### Type Checking

```bash
bunx tsc --noEmit
```

### Adding a New Server

1. Add entry to `mcp-servers.json`
2. Add any required env vars to `.env`
3. Run `bun src/cli.ts` and select the new server

## License

MIT