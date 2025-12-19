/**
 * Type definitions for MCP client configuration
 */

import { OAuthConfig } from "./oauth.js";

/**
 * Authentication configuration for an MCP server
 */
export type AuthConfig =
  | { type: "none" }
  | { type: "bearer"; token: string }
  | { type: "oauth"; oauth: OAuthConfig };

/**
 * Server type discriminator
 */
export type ServerType = "remote" | "local";

/**
 * Configuration for a remote MCP server
 */
export interface RemoteServerConfig {
  type: "remote";
  /**
   * URL of the MCP server endpoint
   */
  url: string;
  /**
   * Optional static headers to send with every request
   * Values can include ${ENV_VAR} placeholders
   */
  headers?: Record<string, string>;
  /**
   * Optional session ID to use for the connection
   */
  sessionId?: string;
  /**
   * Authentication configuration
   */
  auth?: AuthConfig;
}

/**
 * Configuration for a local MCP server
 */
export interface LocalServerConfig {
  type: "local";
  /**
   * Command to execute the server (e.g., "npx")
   */
  command: string;
  /**
   * Arguments to pass to the command
   * Values can include ${ENV_VAR} placeholders
   */
  args?: string[];
  /**
   * Optional environment variables
   * Values can include ${ENV_VAR} placeholders
   */
  env?: Record<string, string>;
}

/**
 * Configuration for a single MCP server
 */
export type ServerConfig = (RemoteServerConfig | LocalServerConfig) & {
  /**
   * Display name for the server (used in selection menu)
   */
  name?: string;
};

/**
 * Root structure of the mcp-servers.json file
 * Supports both array format and object with "servers" key
 */
export type ServersFile = ServerConfig[] | { servers: ServerConfig[] };
