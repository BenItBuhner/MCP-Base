# MCP Testing Client

A command-line MCP (Model Context Protocol) client supporting both Anthropic Claude and OpenAI GPT models for LLM-powered tool execution.

Need a small AI/MCP project made clearer before you share it? See the [$20 AI Agent Launch Rescue](./AI_AGENT_LAUNCH_RESCUE.md).

## Features

- **Multi-Provider Support**: Switch between Anthropic Claude and OpenAI GPT via environment variables
- **Multiple Auth Methods**: No auth, bearer tokens, and OAuth flows
- **Multi-Server Config**: JSON-based server configurations with environment variable placeholders
- **Multi-Turn Tool Execution**: Automatic handling of tool calls across conversation turns
- **Interactive CLI**: Chat interface with server selection
- **Local Server Support**: Run MCP servers locally via stdio

## Installation

```bash
bun install
```

## Configuration

### Environment Variables

Create the `.env` file from the `.env.example` and fill in the necessary fieals for your usage.

### Server Configuration

Open up and edit the `mcp-servers.json`; add your preferred servers:

```json
[
  {
    "name": "Public Server",
    "url": "https://mcp.example.com/mcp",
    "auth": { "type": "none" }
  },
  {
    "name": "API Key Server",
    "url": "https://api.example.com/mcp",
    "auth": {
      "type": "bearer",
      "token": "${API_TOKEN}"
    }
  },
  {
    "name": "OAuth Server",
    "url": "https://oauth.example.com/mcp",
    "auth": {
      "type": "oauth",
      "oauth": {
        "clientId": "${CLIENT_ID}",
        "clientSecret": "${CLIENT_SECRET}",
        "authorizationUrl": "https://oauth.example.com/authorize",
        "tokenUrl": "https://oauth.example.com/token",
        "redirectUri": "http://localhost:8090/callback",
        "scopes": ["read", "write"]
      }
    }
  },
  {
    "name": "Local Server",
    "type": "local",
    "command": "npx",
    "args": ["@modelcontextprotocol/server-filesystem", "/path/to/dir"]
  }
]
```

## Usage

Run the CLI:

```bash
bun src/cli.ts
```

Select a server and start chatting. Type 'quit' to exit.
