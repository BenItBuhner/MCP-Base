/**
 * OAuth Provider implementations for MCP client authentication.
 *
 * This module provides OAuth providers that implement the MCP SDK's OAuthClientProvider interface.
 * For CLI apps, we handle the full OAuth flow including token exchange since we can run a local
 * callback server and wait for user authorization.
 *
 * Providers:
 * 1. CLIOAuthProvider - For CLI/desktop apps that can open a browser and run a local callback server
 * 2. DelegatedOAuthProvider - For web apps where frontend handles the OAuth flow
 */

import { createServer, Server, IncomingMessage, ServerResponse } from "http";
import { URL } from "url";
import { exec } from "child_process";
import { promisify } from "util";

// Import types and functions from the MCP SDK
import type { OAuthClientProvider as SDKOAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  exchangeAuthorization,
  discoverOAuthMetadata,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientMetadata,
  OAuthClientInformationFull,
  OAuthTokens as SDKOAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

const execAsync = promisify(exec);

/**
 * OAuth tokens structure (matches SDK)
 */
export interface OAuthTokens {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

/**
 * OAuth configuration for a server
 */
export interface OAuthConfig {
  clientId: string;
  clientSecret?: string;
  authorizationUrl: string;
  tokenUrl: string;
  redirectUri: string;
  scopes?: string[];
  clientName?: string;
}

/**
 * Auth configuration union type
 */
export type AuthConfig =
  | { type: "none" }
  | { type: "bearer"; token: string }
  | { type: "oauth"; oauth: OAuthConfig };

/**
 * Re-export OAuthClientProvider type for external use
 */
export type OAuthClientProvider = SDKOAuthClientProvider;

/**
 * Callbacks for delegated OAuth flow (web apps)
 */
export interface DelegatedAuthCallbacks {
  /**
   * Called when auth is required - frontend should handle redirect/popup
   * @param authorizationUrl The authorization URL to redirect to
   */
  onAuthRequired: (authorizationUrl: URL) => Promise<void>;

  /**
   * Called when tokens are received - persist them as needed
   */
  onTokensReceived?: (tokens: SDKOAuthTokens) => Promise<void>;

  /**
   * Called to retrieve stored tokens
   */
  getStoredTokens?: () => Promise<SDKOAuthTokens | undefined>;

  /**
   * Called to retrieve stored client information
   */
  getStoredClientInfo?: () => Promise<OAuthClientInformationFull | undefined>;

  /**
   * Called to save client information after dynamic registration
   */
  onClientInfoReceived?: (
    clientInfo: OAuthClientInformationFull,
  ) => Promise<void>;

  /**
   * Called to retrieve the stored code verifier
   */
  getCodeVerifier?: () => Promise<string>;

  /**
   * Called to save the code verifier
   */
  saveCodeVerifier?: (verifier: string) => Promise<void>;
}

/**
 * Opens a URL in the default browser (cross-platform)
 */
async function openBrowser(url: string): Promise<void> {
  const platform = process.platform;
  let command: string;

  if (platform === "win32") {
    command = `start "" "${url}"`;
  } else if (platform === "darwin") {
    command = `open "${url}"`;
  } else {
    // Linux and others
    command = `xdg-open "${url}"`;
  }

  try {
    await execAsync(command);
  } catch (error) {
    console.error("Failed to open browser automatically.");
    console.log(`Please open this URL manually: ${url}`);
  }
}

/**
 * CLI OAuth Provider
 *
 * For command-line and desktop applications that can:
 * - Open a browser for user authorization
 * - Run a local HTTP server to receive the OAuth callback
 *
 * Implements the MCP SDK's OAuthClientProvider interface. The SDK handles:
 * - PKCE code challenge generation
 * - Authorization URL construction
 * - Token exchange
 *
 * This provider handles:
 * - Client metadata/information
 * - Token storage
 * - Code verifier storage (for PKCE)
 * - Browser redirection
 *
 * Usage:
 * ```ts
 * const provider = new CLIOAuthProvider({
 *   clientId: "your-client-id",
 *   authorizationUrl: "https://example.com/oauth/authorize",
 *   tokenUrl: "https://example.com/oauth/token",
 *   redirectUri: "http://localhost:8090/callback",
 *   scopes: ["read", "write"]
 * });
 *
 * const transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
 * ```
 */
export class CLIOAuthProvider implements SDKOAuthClientProvider {
  private _tokens: SDKOAuthTokens | undefined = undefined;
  private _clientInfo: OAuthClientInformationFull | undefined = undefined;
  private _codeVerifier: string = "";
  private config: OAuthConfig;
  private callbackPort: number;
  private callbackPath: string;
  private server: Server | null = null;
  // Promise that resolves when the callback receives the authorization code
  private callbackPromise: Promise<string> | null = null;
  private callbackResolve: ((code: string) => void) | null = null;
  private callbackReject: ((error: Error) => void) | null = null;

  constructor(config: OAuthConfig, options?: { callbackPort?: number }) {
    this.config = config;

    // Parse callback port and path from redirectUri
    const redirectUrl = new URL(config.redirectUri);
    this.callbackPort =
      options?.callbackPort ?? parseInt(redirectUrl.port || "8090", 10);
    this.callbackPath = redirectUrl.pathname || "/callback";
  }

  /**
   * The redirect URL for OAuth callbacks
   */
  get redirectUrl(): string {
    return this.config.redirectUri;
  }

  /**
   * Client metadata for dynamic registration
   */
  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.config.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: this.config.clientName ?? "MCP CLI Client",
      token_endpoint_auth_method: this.config.clientSecret
        ? "client_secret_post"
        : "none",
    } as OAuthClientMetadata;
  }

  /**
   * Returns stored client information (client_id, client_secret, etc.)
   * This is called by the SDK to get client credentials for token requests.
   */
  clientInformation(): OAuthClientInformationFull | undefined {
    // If we have dynamically registered client info, return it
    if (this._clientInfo) {
      return this._clientInfo;
    }

    // Otherwise return static client info from config
    if (this.config.clientId) {
      return {
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        redirect_uris: [this.config.redirectUri],
      } as OAuthClientInformationFull;
    }

    return undefined;
  }

  /**
   * Saves client information after dynamic registration
   */
  saveClientInformation(clientInfo: OAuthClientInformationFull): void {
    this._clientInfo = clientInfo;
    console.log("Client registered with ID:", clientInfo.client_id);
  }

  /**
   * Returns current tokens or undefined
   */
  tokens(): SDKOAuthTokens | undefined {
    return this._tokens;
  }

  /**
   * Saves tokens after successful authentication
   */
  saveTokens(tokens: SDKOAuthTokens): void {
    this._tokens = tokens;
    console.log("✅ Tokens saved successfully");

    // Cleanup the callback server now that auth is complete
    this.cleanup();
  }

  /**
   * Saves the PKCE code verifier before redirecting to authorization
   */
  saveCodeVerifier(codeVerifier: string): void {
    this._codeVerifier = codeVerifier;
  }

  /**
   * Returns the stored PKCE code verifier
   */
  codeVerifier(): string {
    return this._codeVerifier;
  }

  /**
   * Called when authorization is required - opens browser, waits for callback, and exchanges code for tokens.
   * For CLI apps, we do the full flow here so tokens are available when this method returns.
   */
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    console.log("\n🔐 Authorization required.");
    console.log("Opening browser for authentication...\n");

    // Create a promise that will be resolved when we receive the auth code
    this.callbackPromise = new Promise<string>((resolve, reject) => {
      this.callbackResolve = resolve;
      this.callbackReject = reject;
    });

    // Start callback server to receive the OAuth callback
    await this.startCallbackServer();

    // Open browser with the authorization URL (SDK has already added PKCE params)
    const authUrl = authorizationUrl.toString();
    console.log(`If browser doesn't open automatically, visit:\n${authUrl}\n`);
    await openBrowser(authUrl);

    // Wait for the callback to receive the authorization code
    let authorizationCode: string;
    try {
      authorizationCode = await this.callbackPromise;
      console.log("Authorization code received, exchanging for tokens...");
    } finally {
      this.cleanup();
    }

    // Now exchange the authorization code for tokens
    // We need to do this here for CLI apps because the SDK expects tokens
    // to be available after redirectToAuthorization returns
    try {
      // Extract the authorization server URL from the authorization URL
      const authServerUrl = new URL(authorizationUrl.origin);

      // Discover OAuth metadata to get the token endpoint
      const metadata = await discoverOAuthMetadata(authServerUrl);

      // Get client information
      const clientInfo = this.clientInformation();
      if (!clientInfo) {
        throw new Error("No client information available for token exchange");
      }

      // Exchange the code for tokens
      const tokens = await exchangeAuthorization(authServerUrl, {
        metadata,
        clientInformation: clientInfo,
        authorizationCode,
        codeVerifier: this._codeVerifier,
        redirectUri: this.config.redirectUri,
      });

      // Save the tokens
      this.saveTokens(tokens);
      console.log("✅ Authentication successful!\n");
    } catch (error) {
      console.error("Token exchange failed:", error);
      throw error;
    }
  }

  /**
   * Invalidate stored credentials when server indicates they're no longer valid
   */
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier"): void {
    switch (scope) {
      case "all":
        this._tokens = undefined;
        this._clientInfo = undefined;
        this._codeVerifier = "";
        break;
      case "client":
        this._clientInfo = undefined;
        break;
      case "tokens":
        this._tokens = undefined;
        break;
      case "verifier":
        this._codeVerifier = "";
        break;
    }
  }

  /**
   * Starts a local HTTP server to receive the OAuth callback
   * The server displays success/error messages and closes the window
   */
  private startCallbackServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer(
        (req: IncomingMessage, res: ServerResponse) => {
          // Ignore favicon requests
          if (req.url?.startsWith("/favicon")) {
            res.writeHead(404);
            res.end();
            return;
          }

          // Check if this is our callback path
          if (!req.url?.startsWith(this.callbackPath)) {
            res.writeHead(404);
            res.end("Not found");
            return;
          }

          const url = new URL(req.url, `http://localhost:${this.callbackPort}`);
          const code = url.searchParams.get("code");
          const error = url.searchParams.get("error");

          if (error) {
            const errorDescription =
              url.searchParams.get("error_description") || error;
            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            res.end(`
              <!DOCTYPE html>
              <html>
                <head><meta charset="utf-8"></head>
                <body style="font-family: system-ui; padding: 40px; text-align: center;">
                  <h1>❌ Authorization Failed</h1>
                  <p>${errorDescription}</p>
                </body>
              </html>
            `);
            // Signal the error
            if (this.callbackReject) {
              this.callbackReject(
                new Error(`OAuth error: ${errorDescription}`),
              );
            }
            return;
          }

          if (code) {
            // Resolve the callback promise with the code
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(`
              <!DOCTYPE html>
              <html>
                <head><meta charset="utf-8"></head>
                <body style="font-family: system-ui; padding: 40px; text-align: center;">
                  <h1>✅ Authorization Successful!</h1>
                  <p>You can close this window and return to the terminal.</p>
                  <script>setTimeout(() => window.close(), 2000);</script>
                </body>
              </html>
            `);
            // Signal that we received the code
            if (this.callbackResolve) {
              this.callbackResolve(code);
            }
            return;
          }

          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`
            <!DOCTYPE html>
            <html>
              <head><meta charset="utf-8"></head>
              <body style="font-family: system-ui; padding: 40px; text-align: center;">
                <h1>❌ Authorization Failed</h1>
                <p>No authorization code received.</p>
              </body>
            </html>
          `);
        },
      );

      // Handle server errors
      this.server.on("error", (err) => {
        reject(new Error(`Callback server error: ${err.message}`));
      });

      // Start listening
      this.server.listen(this.callbackPort, () => {
        console.log(
          `Callback server listening on http://localhost:${this.callbackPort}${this.callbackPath}`,
        );
        resolve();
      });
    });
  }

  /**
   * Cleans up the callback server and resets state
   */
  private cleanup(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.callbackPromise = null;
    this.callbackResolve = null;
    this.callbackReject = null;
  }
}

/**
 * Delegated OAuth Provider
 *
 * For web applications where the frontend handles the OAuth flow.
 * The backend orchestrates MCP connections and delegates auth to the frontend.
 *
 * Usage:
 * ```ts
 * const provider = new DelegatedOAuthProvider(oauthConfig, {
 *   onAuthRequired: async (authorizationUrl) => {
 *     // Signal frontend to open authorizationUrl (via WebSocket, SSE, etc.)
 *     await notifyFrontend({ type: 'auth_required', url: authorizationUrl.toString() });
 *   },
 *   onTokensReceived: async (tokens) => {
 *     // Persist tokens to database
 *     await saveTokensToDb(userId, serverId, tokens);
 *   },
 *   getStoredTokens: async () => {
 *     // Retrieve tokens from database
 *     return await getTokensFromDb(userId, serverId);
 *   }
 * });
 *
 * const transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
 * ```
 */
export class DelegatedOAuthProvider implements SDKOAuthClientProvider {
  private _tokens: SDKOAuthTokens | undefined = undefined;
  private _clientInfo: OAuthClientInformationFull | undefined = undefined;
  private _codeVerifier: string = "";
  private config: OAuthConfig;
  private callbacks: DelegatedAuthCallbacks;

  constructor(
    config: OAuthConfig,
    callbacks: DelegatedAuthCallbacks,
    initialTokens?: SDKOAuthTokens,
  ) {
    this.config = config;
    this.callbacks = callbacks;
    this._tokens = initialTokens;
  }

  /**
   * The redirect URL for OAuth callbacks
   */
  get redirectUrl(): string {
    return this.config.redirectUri;
  }

  /**
   * Client metadata for dynamic registration
   */
  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.config.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: this.config.clientName ?? "MCP Web Client",
      token_endpoint_auth_method: this.config.clientSecret
        ? "client_secret_post"
        : "none",
    } as OAuthClientMetadata;
  }

  /**
   * Returns stored client information
   */
  async clientInformation(): Promise<OAuthClientInformationFull | undefined> {
    // Check callback for stored info first
    if (this.callbacks.getStoredClientInfo) {
      const stored = await this.callbacks.getStoredClientInfo();
      if (stored) return stored;
    }

    // Return in-memory info
    if (this._clientInfo) {
      return this._clientInfo;
    }

    // Return static config
    if (this.config.clientId) {
      return {
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        redirect_uris: [this.config.redirectUri],
      } as OAuthClientInformationFull;
    }

    return undefined;
  }

  /**
   * Saves client information after dynamic registration
   */
  async saveClientInformation(
    clientInfo: OAuthClientInformationFull,
  ): Promise<void> {
    this._clientInfo = clientInfo;
    await this.callbacks.onClientInfoReceived?.(clientInfo);
  }

  /**
   * Returns current tokens
   */
  async tokens(): Promise<SDKOAuthTokens | undefined> {
    // Check callback for stored tokens first
    if (this.callbacks.getStoredTokens) {
      const stored = await this.callbacks.getStoredTokens();
      if (stored) return stored;
    }
    return this._tokens;
  }

  /**
   * Saves tokens after successful authentication
   */
  async saveTokens(tokens: SDKOAuthTokens): Promise<void> {
    this._tokens = tokens;
    await this.callbacks.onTokensReceived?.(tokens);
  }

  /**
   * Saves the PKCE code verifier
   */
  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this._codeVerifier = codeVerifier;
    await this.callbacks.saveCodeVerifier?.(codeVerifier);
  }

  /**
   * Returns the stored PKCE code verifier
   */
  async codeVerifier(): Promise<string> {
    if (this.callbacks.getCodeVerifier) {
      return await this.callbacks.getCodeVerifier();
    }
    return this._codeVerifier;
  }

  /**
   * Called when authorization is required - delegates to frontend
   */
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.callbacks.onAuthRequired(authorizationUrl);
  }

  /**
   * Invalidate credentials
   */
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier"): void {
    switch (scope) {
      case "all":
        this._tokens = undefined;
        this._clientInfo = undefined;
        this._codeVerifier = "";
        break;
      case "client":
        this._clientInfo = undefined;
        break;
      case "tokens":
        this._tokens = undefined;
        break;
      case "verifier":
        this._codeVerifier = "";
        break;
    }
  }

  /**
   * Manually set tokens (useful when frontend already has tokens)
   */
  setTokens(tokens: SDKOAuthTokens): void {
    this._tokens = tokens;
  }
}

/**
 * Simple in-memory token storage for CLI use
 * Can be extended to persist to file system
 */
export class TokenStorage {
  private tokens: Map<string, SDKOAuthTokens> = new Map();

  /**
   * Get tokens for a server
   */
  get(serverId: string): SDKOAuthTokens | undefined {
    return this.tokens.get(serverId);
  }

  /**
   * Store tokens for a server
   */
  set(serverId: string, tokens: SDKOAuthTokens): void {
    this.tokens.set(serverId, tokens);
  }

  /**
   * Clear tokens for a server
   */
  clear(serverId: string): void {
    this.tokens.delete(serverId);
  }

  /**
   * Clear all tokens
   */
  clearAll(): void {
    this.tokens.clear();
  }
}

/**
 * Resolve environment variable placeholders in OAuth config
 */
export function resolveOAuthConfig(config: OAuthConfig): OAuthConfig {
  const resolve = (value: string | undefined): string => {
    if (!value) return "";
    return value.replace(/\$\{([^}]+)\}/g, (_, name) => {
      return process.env[name] ?? "";
    });
  };

  return {
    clientId: resolve(config.clientId),
    clientSecret: config.clientSecret
      ? resolve(config.clientSecret)
      : undefined,
    authorizationUrl: resolve(config.authorizationUrl),
    tokenUrl: resolve(config.tokenUrl),
    redirectUri: resolve(config.redirectUri),
    scopes: config.scopes,
    clientName: config.clientName,
  };
}
