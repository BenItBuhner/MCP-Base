/**
 * MCP Client CLI
 *
 * A command-line MCP client that:
 * - Loads server definitions from a JSON file (default: ./mcp-servers.json)
 * - Supports multiple authentication methods: none, bearer token, OAuth
 * - Resolves header/config placeholders like ${ENV_VAR} from process.env
 * - Connects to Streamable HTTP MCP servers or local stdio MCP servers
 * - Uses Anthropic for LLM calls (configured via .env)
 * - Supports multi-turn tool_use handling
 *
 * Usage:
 *  - Set environment variables (or use .env):
 *      ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, ANTHROPIC_MODEL
 *  - Create mcp-servers.json with server configs (see types.ts for schema)
 *  - Run: bun src/cli.ts
 */

import { Anthropic } from "@anthropic-ai/sdk";
import {
  MessageParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import readline from "readline/promises";
import dotenv from "dotenv";
import fs from "fs/promises";
import { URL } from "url";

import { CLIOAuthProvider, resolveOAuthConfig } from "./oauth.js";
import { ServerConfig, ServersFile, AuthConfig } from "./types.js";

// Load environment variables
dotenv.config({ path: ".env" });

// Required Anthropic configuration
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL;

if (!ANTHROPIC_API_KEY || !ANTHROPIC_BASE_URL || !ANTHROPIC_MODEL) {
  console.error(
    "Missing required environment variables. Please set ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, and ANTHROPIC_MODEL.",
  );
  throw new Error(
    "ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, or ANTHROPIC_MODEL is not set",
  );
}

/**
 * Load server configurations from a JSON file
 */
async function loadServerConfigs(
  filePath: string,
): Promise<ServerConfig[] | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as ServersFile;

    let configs: ServerConfig[];
    if (Array.isArray(parsed)) {
      configs = parsed;
    } else if (parsed.servers && Array.isArray(parsed.servers)) {
      configs = parsed.servers;
    } else {
      console.warn("Server config file found but unrecognized shape.");
      return undefined;
    }

    // Ensure backward compatibility: add type: "remote" if missing
    return configs.map((config) => {
      if (!("type" in config)) {
        return { ...(config as any), type: "remote" } as ServerConfig;
      }
      return config;
    });
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return undefined;
    }
    console.warn("Failed to read server config file:", err?.message ?? err);
    return undefined;
  }
}

/**
 * Resolve ${ENV_VAR} placeholders in a string
 */
function resolveEnvPlaceholder(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name) => {
    return process.env[name] ?? "";
  });
}

/**
 * Resolve placeholders in string arrays
 */
function resolveEnvPlaceholdersArray(values?: string[]): string[] | undefined {
  if (!values) return undefined;
  return values.map(resolveEnvPlaceholder);
}

/**
 * Resolve placeholders in objects with string values
 */
function resolveEnvPlaceholdersObject(
  obj?: Record<string, string>,
): Record<string, string> | undefined {
  if (!obj) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = resolveEnvPlaceholder(v);
  }
  return out;
}

/**
 * Resolve placeholders in header values
 */
function resolveEnvPlaceholders(
  headers?: Record<string, string>,
): Record<string, string> | undefined {
  if (!headers) return undefined;

  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v !== "string") {
      out[k] = String(v ?? "");
      continue;
    }
    out[k] = resolveEnvPlaceholder(v);
  }
  return out;
}

/**
 * Normalize headers - remove undefined/null entries
 */
function normalizeHeaders(
  headers?: Record<string, string>,
): Record<string, string> | undefined {
  if (!headers) return undefined;

  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || v === null || v === "") continue;
    out[k] = String(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * MCP Client class that handles connection and tool execution
 */
class MCPClient {
  private mcp: Client;
  private anthropic: Anthropic;
  private transport:
    | StreamableHTTPClientTransport
    | StdioClientTransport
    | null = null;
  private tools: Tool[] = [];
  private authProvider: CLIOAuthProvider | null = null;

  constructor() {
    this.anthropic = new Anthropic({
      apiKey: ANTHROPIC_API_KEY!,
      baseURL: ANTHROPIC_BASE_URL!,
    });
    this.mcp = new Client({ name: "mcp-client-cli", version: "1.0.0" });
  }

  /**
   * Connect to an MCP server (remote or local)
   */
  async connectToServer(config: ServerConfig): Promise<void> {
    // Handle local servers
    if (config.type === "local") {
      const resolvedCommand = resolveEnvPlaceholder(config.command);
      const resolvedArgs = resolveEnvPlaceholdersArray(config.args);
      const resolvedEnv = resolveEnvPlaceholdersObject(config.env);

      // Close previous transport if any
      if (this.transport) {
        await this.transport.close().catch(() => {});
      }

      // Create stdio transport
      const envVars: Record<string, string> = {};
      Object.entries(process.env).forEach(([k, v]) => {
        if (v !== undefined) envVars[k] = v;
      });
      if (resolvedEnv) {
        Object.assign(envVars, resolvedEnv);
      }
      this.transport = new StdioClientTransport({
        command: resolvedCommand,
        args: resolvedArgs,
        env: envVars,
      });

      // Connect the MCP client
      await this.mcp.connect(this.transport);

      // Retrieve and cache tools
      const toolsResult = await this.mcp.listTools();
      this.tools = toolsResult.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      })) as Tool[];

      console.log(
        "Connected to local server with tools:",
        this.tools.map(({ name }) => name),
      );
      return;
    }

    // Handle remote servers (existing logic)
    const urlObj = new URL(config.url);

    // Resolve header placeholders
    const resolvedHeaders = normalizeHeaders(
      resolveEnvPlaceholders(config.headers),
    );

    // Handle authentication
    const auth = config.auth ?? { type: "none" as const };
    let oauthConfig: ReturnType<typeof resolveOAuthConfig> | null = null;

    if (auth.type === "oauth" && auth.oauth) {
      oauthConfig = resolveOAuthConfig(auth.oauth);
      this.authProvider = new CLIOAuthProvider(oauthConfig);
    }

    // Helper to create transport with current auth state
    const createTransport = () => {
      const transportOpts: {
        requestInit?: RequestInit;
        sessionId?: string;
        authProvider?: OAuthClientProvider;
      } = {
        sessionId: config.sessionId,
      };

      if (auth.type === "bearer" && auth.token) {
        // Simple bearer token - add to headers
        const token = resolveEnvPlaceholder(auth.token);
        transportOpts.requestInit = {
          headers: {
            ...resolvedHeaders,
            Authorization: `Bearer ${token}`,
          },
        };
      } else if (auth.type === "oauth" && this.authProvider) {
        // OAuth flow - check if we have tokens already
        const tokens = this.authProvider.tokens();
        if (tokens?.access_token) {
          // We have tokens from a previous auth flow, use them directly
          transportOpts.requestInit = {
            headers: {
              ...resolvedHeaders,
              Authorization: `Bearer ${tokens.access_token}`,
            },
          };
        } else {
          // No tokens yet, let the SDK handle auth
          transportOpts.authProvider = this.authProvider;
          transportOpts.requestInit = resolvedHeaders
            ? { headers: resolvedHeaders }
            : undefined;
        }
      } else {
        // No auth
        transportOpts.requestInit = resolvedHeaders
          ? { headers: resolvedHeaders }
          : undefined;
      }

      return new StreamableHTTPClientTransport(urlObj, transportOpts as any);
    };

    // Try to connect, with retry after OAuth flow completes
    let attempts = 0;
    const maxAttempts = 2;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        // Close previous transport if any
        if (this.transport) {
          await this.transport.close().catch(() => {});
        }

        // Create new transport
        this.transport = createTransport();

        // Connect the MCP client
        await this.mcp.connect(this.transport);

        // Retrieve and cache tools
        const toolsResult = await this.mcp.listTools();
        this.tools = toolsResult.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema,
        })) as Tool[];

        console.log(
          "Connected to remote server with tools:",
          this.tools.map(({ name }) => name),
        );
        return; // Success!
      } catch (e: any) {
        const isUnauthorized =
          e?.message?.includes("Unauthorized") ||
          e?.name === "UnauthorizedError";

        // If we got Unauthorized after OAuth flow and have tokens, retry with tokens in header
        if (
          isUnauthorized &&
          attempts < maxAttempts &&
          this.authProvider?.tokens()?.access_token
        ) {
          console.log("Retrying connection with obtained tokens...");
          // Reset the MCP client for a fresh connection
          this.mcp = new Client({ name: "mcp-client-cli", version: "1.0.0" });
          continue;
        }

        console.error("Failed to connect to MCP server:", e?.message ?? e);
        throw e;
      }
    }
  }

  /**
   * Process a user query with multi-turn tool execution
   */
  async processQuery(query: string): Promise<string> {
    const messages: MessageParam[] = [
      {
        role: "user",
        content: query,
      },
    ];

    const finalText: string[] = [];

    while (true) {
      const response = await this.anthropic.messages.create({
        model: ANTHROPIC_MODEL!,
        max_tokens: 1000,
        messages,
        tools: this.tools,
      });

      // Defensive check for valid response
      if (!response?.content || !Array.isArray(response.content)) {
        console.error("Empty or malformed model response:", response);
        break;
      }

      // Add assistant response to history
      messages.push({
        role: "assistant",
        content: response.content as any,
      });

      let hasToolUse = false;
      const toolResults: Array<{
        type: string;
        tool_use_id?: string;
        content: string;
      }> = [];

      // Process each content block
      for (const content of response.content) {
        if (content.type === "text") {
          finalText.push(content.text);
        } else if (content.type === "tool_use") {
          hasToolUse = true;
          const toolName = content.name;
          const toolArgs = content.input as Record<string, unknown> | undefined;

          console.log(`[Executing tool: ${toolName}]`);

          // Execute tool via MCP server
          const result = await this.mcp.callTool({
            name: toolName,
            arguments: toolArgs,
          });

          finalText.push(
            `[Calling tool ${toolName} with args ${JSON.stringify(toolArgs)}]`,
          );

          // Format result content as string
          const resultContent =
            typeof result?.content === "string"
              ? result.content
              : JSON.stringify(result?.content ?? result);

          toolResults.push({
            type: "tool_result",
            tool_use_id: content.id,
            content: resultContent,
          });
        } else {
          finalText.push(
            `[Unknown content type from model: ${JSON.stringify(content)}]`,
          );
        }
      }

      // If no tool use, we're done
      if (!hasToolUse) {
        break;
      }

      // Add tool results for next turn
      messages.push({
        role: "user",
        content: toolResults as any,
      });
    }

    return finalText.join("\n");
  }

  /**
   * Run the interactive chat loop
   */
  async chatLoop(): Promise<void> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      console.log("\nMCP Client Started!");
      console.log("Type your queries or 'quit' to exit.");

      while (true) {
        const message = await rl.question("\nQuery: ");

        if (message.toLowerCase() === "quit") {
          break;
        }

        try {
          const response = await this.processQuery(message);
          console.log("\n" + response);
        } catch (err) {
          console.error("Error processing query:", err);
        }
      }
    } finally {
      rl.close();
    }
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    try {
      if (this.transport) {
        await this.transport.close();
      }
    } catch {
      // Ignore cleanup errors
    }
    await this.mcp.close();
  }
}

/**
 * Interactive server selection
 */
async function pickServer(
  servers: ServerConfig[],
): Promise<ServerConfig | undefined> {
  if (!servers || servers.length === 0) return undefined;
  if (servers.length === 1) return servers[0];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("Available MCP servers:");
  servers.forEach((s, i) => {
    const serverType = s.type;
    const typeBadge = serverType === "local" ? " 💻" : " 🌐";
    const authBadge =
      serverType === "remote" && s.auth?.type
        ? s.auth.type === "oauth"
          ? " 🔐"
          : s.auth.type === "bearer"
            ? " 🔑"
            : ""
        : "";
    const displayName = s.name ?? (serverType === "local" ? s.command : s.url);
    console.log(`${i + 1}. ${displayName}${typeBadge}${authBadge}`);
  });

  while (true) {
    const ans = await rl.question("Select server number: ");
    const n = parseInt(ans, 10);

    if (!Number.isNaN(n) && n >= 1 && n <= servers.length) {
      rl.close();
      return servers[n - 1];
    }
    console.log("Invalid selection");
  }
}

/**
 * Main entrypoint
 */
async function main(): Promise<void> {
  const client = new MCPClient();

  try {
    const serversFile = process.env.MCP_SERVERS_FILE ?? "./mcp-servers.json";
    const servers = (await loadServerConfigs(serversFile)) ?? [];

    let chosen: ServerConfig | undefined;

    if (servers.length === 0) {
      console.log(
        `No server config found at ${serversFile}, falling back to MCP_URL env.`,
      );
      const envUrl = process.env.MCP_URL;

      if (!envUrl) {
        console.log(
          "No MCP servers defined and MCP_URL not set. Please configure mcp-servers.json or set MCP_URL.",
        );
        return;
      }

      chosen = { type: "remote", url: envUrl };
    } else {
      chosen = await pickServer(servers);
    }

    if (!chosen) {
      console.log("No MCP server chosen, exiting.");
      return;
    }

    const displayName =
      chosen.name ?? (chosen.type === "local" ? chosen.command : chosen.url);
    console.log(`Connecting to ${displayName} ...`);
    await client.connectToServer(chosen);
    await client.chatLoop();
  } catch (err) {
    console.error("Error:", err);
  } finally {
    await client.cleanup();
  }
}

// Run
main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
