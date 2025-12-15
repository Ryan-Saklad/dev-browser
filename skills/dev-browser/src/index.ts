import express, { type Express, type Request, type Response } from "express";
import { chromium, type BrowserContext, type Page } from "playwright";
import { mkdirSync } from "fs";
import { join, resolve, sep } from "path";
import type { Socket } from "net";
import { isIP } from "net";
import type {
  ServeOptions,
  GetPageRequest,
  GetPageResponse,
  ListPagesResponse,
  ServerInfoResponse,
} from "./types";

export type { ServeOptions, GetPageResponse, ListPagesResponse, ServerInfoResponse };

export interface DevBrowserServer {
  wsEndpoint: string;
  port: number;
  stop: () => Promise<void>;
}

// Helper to retry fetch with exponential backoff
async function fetchWithRetry(
  url: string,
  maxRetries = 5,
  delayMs = 500
): Promise<globalThis.Response> {
  let lastError: Error | null = null;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (i < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * (i + 1)));
      }
    }
  }
  throw new Error(`Failed after ${maxRetries} retries: ${lastError?.message}`);
}

// Helper to add timeout to promises
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: ${message}`)), ms)
    ),
  ]);
}

export async function serve(options: ServeOptions = {}): Promise<DevBrowserServer> {
  const port = options.port ?? 9222;
  const host = options.host ?? "127.0.0.1";
  const headless = options.headless ?? false;
  const cdpPort = options.cdpPort ?? 9223;
  const cdpHost = options.cdpHost ?? "127.0.0.1";
  const profileDir = options.profileDir;
  const allowRemote = options.allowRemote ?? false;
  const lockdown = options.lockdown ?? process.env.DEV_BROWSER_LOCKDOWN === "true";
  const tmpDir = options.tmpDir ?? process.env.DEV_BROWSER_TMP_DIR ?? join(process.cwd(), "tmp");

  const allowedHostsRaw =
    options.allowedHosts ??
    (process.env.DEV_BROWSER_ALLOWED_HOSTS
      ? process.env.DEV_BROWSER_ALLOWED_HOSTS.split(",").map((s) => s.trim())
      : ["localhost", "127.0.0.1", "::1"]);
  const allowedHosts = allowedHostsRaw.filter(Boolean);

  const authToken = options.authToken ?? process.env.DEV_BROWSER_TOKEN;
  const requireAuth = options.requireAuth ?? Boolean(authToken);

  // Validate port numbers
  if (port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${port}. Must be between 1 and 65535`);
  }
  if (cdpPort < 1 || cdpPort > 65535) {
    throw new Error(`Invalid cdpPort: ${cdpPort}. Must be between 1 and 65535`);
  }
  if (port === cdpPort) {
    throw new Error("port and cdpPort must be different");
  }

  function isLoopbackHost(h: string): boolean {
    if (h === "localhost" || h === "127.0.0.1" || h === "::1") return true;
    const ipVersion = isIP(h);
    if (ipVersion === 4) return h.startsWith("127.");
    if (ipVersion === 6) return h === "::1";
    return false;
  }

  if (!allowRemote) {
    if (!isLoopbackHost(host)) {
      throw new Error(
        `Refusing to bind HTTP server to non-loopback host "${host}". Set allowRemote: true if you really want this.`
      );
    }
    if (!isLoopbackHost(cdpHost)) {
      throw new Error(
        `Refusing to bind CDP server to non-loopback host "${cdpHost}". Set allowRemote: true if you really want this.`
      );
    }
  }

  if (requireAuth && !authToken) {
    throw new Error(
      "HTTP auth is required but no token was provided. Set DEV_BROWSER_TOKEN or pass authToken."
    );
  }

  if (lockdown && !requireAuth) {
    throw new Error(
      "Lockdown mode requires HTTP auth. Set DEV_BROWSER_TOKEN (and optionally DEV_BROWSER_REQUIRE_AUTH=true)."
    );
  }

  // Determine user data directory for persistent context
  const userDataDir = profileDir
    ? join(profileDir, "browser-data")
    : join(process.cwd(), ".browser-data");

  // Create directory if it doesn't exist
  mkdirSync(userDataDir, { recursive: true });
  console.log(`Using persistent browser profile: ${userDataDir}`);

  console.log("Launching browser with persistent context...");

  // Launch persistent context - this persists cookies, localStorage, cache, etc.
  const browserArgs: string[] = [];
  if (!lockdown) {
    browserArgs.push(`--remote-debugging-port=${cdpPort}`, `--remote-debugging-address=${cdpHost}`);
  }

  const context: BrowserContext = await chromium.launchPersistentContext(userDataDir, {
    headless,
    acceptDownloads: false,
    args: browserArgs,
  });
  console.log("Browser launched with persistent profile...");

  // In lockdown mode we never expose a browser control endpoint.
  let wsEndpoint: string | null = null;
  if (!lockdown) {
    // Get the CDP WebSocket endpoint from Chrome's JSON API (with retry for slow startup)
    const cdpResponse = await fetchWithRetry(`http://${cdpHost}:${cdpPort}/json/version`);
    const cdpInfo = (await cdpResponse.json()) as { webSocketDebuggerUrl: string };
    wsEndpoint = cdpInfo.webSocketDebuggerUrl;
    console.log(`CDP WebSocket endpoint: ${wsEndpoint}`);
  } else {
    console.log("Lockdown mode enabled (no CDP port exposed).");
    if (allowedHosts.length === 0) {
      throw new Error("Lockdown mode requires a non-empty allowedHosts allowlist.");
    }
    console.log(`Allowed hosts: ${allowedHosts.join(", ")}`);
  }

  // Registry entry type for page tracking
  interface PageEntry {
    page: Page;
    targetId: string;
  }

  // Registry: name -> PageEntry
  const registry = new Map<string, PageEntry>();

  // Helper to get CDP targetId for a page
  async function getTargetId(page: Page): Promise<string> {
    if (lockdown) {
      throw new Error("Target IDs are not available in lockdown mode.");
    }
    const cdpSession = await context.newCDPSession(page);
    try {
      const { targetInfo } = await cdpSession.send("Target.getTargetInfo");
      return targetInfo.targetId;
    } finally {
      await cdpSession.detach();
    }
  }

  // Express server for page management
  const app: Express = express();
  app.use(express.json());

  mkdirSync(tmpDir, { recursive: true });

  if (requireAuth) {
    app.use((req: Request, res: Response, next) => {
      const header = String(req.headers.authorization || "");
      const bearerPrefix = "Bearer ";
      const bearer = header.startsWith(bearerPrefix) ? header.slice(bearerPrefix.length) : null;
      const tokenHeader = req.headers["x-dev-browser-token"];
      const token =
        bearer ??
        (typeof tokenHeader === "string" ? tokenHeader : null) ??
        (Array.isArray(tokenHeader) ? tokenHeader[0] : null);

      if (token && token === authToken) return next();
      res.status(401).json({ error: "unauthorized" });
    });
  }

  function isAllowedUrl(url: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }

    const protocol = parsed.protocol.toLowerCase();
    if (protocol === "data:" || protocol === "blob:") return true;
    if (protocol !== "http:" && protocol !== "https:") return false;

    const hostname = parsed.hostname.toLowerCase();
    return allowedHosts.some((allowed) => {
      const a = allowed.toLowerCase();
      if (a.startsWith("*.")) {
        const suffix = a.slice(1); // ".example.com"
        return hostname.endsWith(suffix) && hostname !== suffix.slice(1);
      }
      return hostname === a;
    });
  }

  if (lockdown) {
    await context.route("**/*", async (route) => {
      const requestUrl = route.request().url();
      if (isAllowedUrl(requestUrl)) return await route.continue();
      await route.abort("blockedbyclient");
    });

    // Close popups aggressively; internal app flows generally shouldn't need arbitrary popups.
    context.on("page", (page) => {
      page.on("popup", async (popup) => {
        try {
          await popup.close();
        } catch {
          // Best effort
        }
      });
    });
  }

  function resolveTmpPath(relativePath: string): string {
    if (!relativePath || typeof relativePath !== "string") {
      throw new Error("path is required and must be a string");
    }
    if (relativePath.includes("\0")) {
      throw new Error("invalid path");
    }
    const clean = relativePath.replace(/^([/\\\\])+/, "");
    const abs = resolve(tmpDir, clean);
    const root = resolve(tmpDir) + sep;
    if (!(abs + sep).startsWith(root)) {
      throw new Error("path must stay within tmpDir");
    }
    return abs;
  }

  const asyncHandler =
    (fn: (req: Request, res: Response) => Promise<void> | void) =>
    (req: Request, res: Response) => {
      Promise.resolve(fn(req, res)).catch((err) => {
        console.error("Request handler error:", err);
        if (!res.headersSent) res.status(500).json({ error: "internal error" });
      });
    };

  // GET / - server info
  app.get("/", (_req: Request, res: Response) => {
    const response: ServerInfoResponse = { wsEndpoint, mode: lockdown ? "lockdown" : "cdp" };
    res.json(response);
  });

  // GET /pages - list all pages
  app.get("/pages", (_req: Request, res: Response) => {
    const response: ListPagesResponse = {
      pages: Array.from(registry.keys()),
    };
    res.json(response);
  });

  // POST /pages - get or create page
  app.post(
    "/pages",
    asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as GetPageRequest;
    const { name } = body;

    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "name is required and must be a string" });
      return;
    }

    if (name.length === 0) {
      res.status(400).json({ error: "name cannot be empty" });
      return;
    }

    if (name.length > 256) {
      res.status(400).json({ error: "name must be 256 characters or less" });
      return;
    }

    // Check if page already exists
    let entry = registry.get(name);
    if (!entry) {
      // Create new page in the persistent context (with timeout to prevent hangs)
      const page = await withTimeout(context.newPage(), 30000, "Page creation timed out after 30s");
      const targetId = lockdown ? `lockdown:${name}` : await getTargetId(page);
      entry = { page, targetId };
      registry.set(name, entry);

      // Clean up registry when page is closed (e.g., user clicks X)
      page.on("close", () => {
        registry.delete(name);
      });
    }

    const response: GetPageResponse = {
      wsEndpoint,
      name,
      ...(lockdown ? {} : { targetId: entry.targetId }),
    };
    res.json(response);
    })
  );

  if (lockdown) {
    app.post(
      "/pages/:name/goto",
      asyncHandler(async (req: Request, res: Response) => {
        const name = String(req.params.name ?? "");
        const entry = registry.get(name);
        if (!entry) {
          res.status(404).json({ error: "page not found" });
          return;
        }

        const { url } = (req.body ?? {}) as { url?: unknown };
        if (typeof url !== "string" || url.length === 0 || url.length > 2048) {
          res.status(400).json({ error: "url is required and must be a string (max 2048 chars)" });
          return;
        }
        if (!isAllowedUrl(url)) {
          res.status(403).json({ error: "url not allowed by DEV_BROWSER_ALLOWED_HOSTS" });
          return;
        }

        await entry.page.goto(url);
        res.json({ success: true, url: entry.page.url(), title: await entry.page.title() });
      })
    );

    app.post(
      "/pages/:name/snapshot",
      asyncHandler(async (req: Request, res: Response) => {
        const name = String(req.params.name ?? "");
        const entry = registry.get(name);
        if (!entry) {
          res.status(404).json({ error: "page not found" });
          return;
        }
        const { getSnapshotScript } = await import("./snapshot/browser-script");
        const snapshotScript = getSnapshotScript();
        const snapshot = await entry.page.evaluate((script: string) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const w = globalThis as any;
          if (!w.__devBrowser_getAISnapshot) {
            // eslint-disable-next-line no-eval
            eval(script);
          }
          return w.__devBrowser_getAISnapshot();
        }, snapshotScript);
        res.json({ snapshot });
      })
    );

    app.post(
      "/pages/:name/click-ref",
      asyncHandler(async (req: Request, res: Response) => {
        const name = String(req.params.name ?? "");
        const entry = registry.get(name);
        if (!entry) {
          res.status(404).json({ error: "page not found" });
          return;
        }
        const { ref } = (req.body ?? {}) as { ref?: unknown };
        if (typeof ref !== "string" || !/^e\d+$/.test(ref)) {
          res.status(400).json({ error: "ref is required and must look like e123" });
          return;
        }

        const handle = await entry.page.evaluateHandle((refId: string) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const w = globalThis as any;
          const refs = w.__devBrowserRefs;
          if (!refs) throw new Error("No snapshot refs found. Call /snapshot first.");
          const el = refs[refId];
          if (!el) throw new Error(`Ref "${refId}" not found`);
          return el;
        }, ref);
        const element = handle.asElement();
        if (!element) {
          await handle.dispose();
          res.status(404).json({ error: "ref did not resolve to an element" });
          return;
        }
        await element.click();
        await handle.dispose();
        res.json({ success: true });
      })
    );

    app.post(
      "/pages/:name/fill-ref",
      asyncHandler(async (req: Request, res: Response) => {
        const name = String(req.params.name ?? "");
        const entry = registry.get(name);
        if (!entry) {
          res.status(404).json({ error: "page not found" });
          return;
        }
        const { ref, text } = (req.body ?? {}) as { ref?: unknown; text?: unknown };
        if (typeof ref !== "string" || !/^e\d+$/.test(ref)) {
          res.status(400).json({ error: "ref is required and must look like e123" });
          return;
        }
        if (typeof text !== "string") {
          res.status(400).json({ error: "text is required and must be a string" });
          return;
        }

        const handle = await entry.page.evaluateHandle((refId: string) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const w = globalThis as any;
          const refs = w.__devBrowserRefs;
          if (!refs) throw new Error("No snapshot refs found. Call /snapshot first.");
          const el = refs[refId];
          if (!el) throw new Error(`Ref "${refId}" not found`);
          return el;
        }, ref);
        const element = handle.asElement();
        if (!element) {
          await handle.dispose();
          res.status(404).json({ error: "ref did not resolve to an element" });
          return;
        }
        await element.fill(text);
        await handle.dispose();
        res.json({ success: true });
      })
    );

    app.post(
      "/pages/:name/press",
      asyncHandler(async (req: Request, res: Response) => {
        const name = String(req.params.name ?? "");
        const entry = registry.get(name);
        if (!entry) {
          res.status(404).json({ error: "page not found" });
          return;
        }
        const { key } = (req.body ?? {}) as { key?: unknown };
        if (typeof key !== "string" || key.length === 0 || key.length > 64) {
          res.status(400).json({ error: "key is required and must be a string (max 64 chars)" });
          return;
        }
        await entry.page.keyboard.press(key);
        res.json({ success: true });
      })
    );

    app.post(
      "/pages/:name/screenshot",
      asyncHandler(async (req: Request, res: Response) => {
        const name = String(req.params.name ?? "");
        const entry = registry.get(name);
        if (!entry) {
          res.status(404).json({ error: "page not found" });
          return;
        }
        const { path, fullPage } = (req.body ?? {}) as { path?: unknown; fullPage?: unknown };
        if (typeof path !== "string" || path.length === 0 || path.length > 256) {
          res.status(400).json({ error: "path is required and must be a short relative string" });
          return;
        }
        const abs = resolveTmpPath(path);
        const fp = typeof fullPage === "boolean" ? fullPage : false;
        await entry.page.screenshot({ path: abs, fullPage: fp });
        res.json({ success: true, path: abs });
      })
    );
  }

  // DELETE /pages/:name - close a page
  app.delete(
    "/pages/:name",
    asyncHandler(async (req: Request, res: Response) => {
      const name = String(req.params.name ?? "");
      const entry = registry.get(name);

      if (entry) {
        await entry.page.close();
        registry.delete(name);
        res.json({ success: true });
        return;
      }

      res.status(404).json({ error: "page not found" });
    })
  );

  // Start the server
  const server = app.listen(port, host, () => {
    console.log(`HTTP API server running on http://${host}:${port}`);
  });

  // Track active connections for clean shutdown
  const connections = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
  });

  // Track if cleanup has been called to avoid double cleanup
  let cleaningUp = false;

  // Cleanup function
  const cleanup = async () => {
    if (cleaningUp) return;
    cleaningUp = true;

    console.log("\nShutting down...");

    // Close all active HTTP connections
    for (const socket of connections) {
      socket.destroy();
    }
    connections.clear();

    // Close all pages
    for (const entry of registry.values()) {
      try {
        await entry.page.close();
      } catch {
        // Page might already be closed
      }
    }
    registry.clear();

    // Close context (this also closes the browser)
    try {
      await context.close();
    } catch {
      // Context might already be closed
    }

    server.close();
    console.log("Server stopped.");
  };

  // Synchronous cleanup for forced exits
  const syncCleanup = () => {
    try {
      context.close();
    } catch {
      // Best effort
    }
  };

  // Signal handlers (consolidated to reduce duplication)
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

  const signalHandler = async () => {
    await cleanup();
    process.exit(0);
  };

  const errorHandler = async (err: unknown) => {
    console.error("Unhandled error:", err);
    await cleanup();
    process.exit(1);
  };

  // Register handlers
  signals.forEach((sig) => process.on(sig, signalHandler));
  process.on("uncaughtException", errorHandler);
  process.on("unhandledRejection", errorHandler);
  process.on("exit", syncCleanup);

  // Helper to remove all handlers
  const removeHandlers = () => {
    signals.forEach((sig) => process.off(sig, signalHandler));
    process.off("uncaughtException", errorHandler);
    process.off("unhandledRejection", errorHandler);
    process.off("exit", syncCleanup);
  };

  return {
    wsEndpoint: wsEndpoint ?? "",
    port,
    async stop() {
      removeHandlers();
      await cleanup();
    },
  };
}
