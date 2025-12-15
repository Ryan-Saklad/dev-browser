// API request/response types - shared between client and server

export interface ServeOptions {
  port?: number;
  /** Host/interface to bind the HTTP API to (default: 127.0.0.1) */
  host?: string;
  headless?: boolean;
  cdpPort?: number;
  /** Host/interface to bind the CDP endpoint to (default: 127.0.0.1) */
  cdpHost?: string;
  /** Directory to store persistent browser profiles (cookies, localStorage, etc.) */
  profileDir?: string;
  /**
   * If true, allows binding to non-loopback interfaces (e.g. 0.0.0.0).
   * Strongly discouraged unless you understand CDP exposure risks.
   */
  allowRemote?: boolean;
  /**
   * Shared secret required for the HTTP API when auth is enabled.
   * If omitted, DEV_BROWSER_TOKEN env var is used.
   */
  authToken?: string;
  /**
   * Require an auth token for the HTTP API.
   * Defaults to true when a token is provided; otherwise false.
   */
  requireAuth?: boolean;
}

export interface GetPageRequest {
  name: string;
}

export interface GetPageResponse {
  wsEndpoint: string;
  name: string;
  targetId: string; // CDP target ID for reliable page matching
}

export interface ListPagesResponse {
  pages: string[];
}

export interface ServerInfoResponse {
  wsEndpoint: string;
}
