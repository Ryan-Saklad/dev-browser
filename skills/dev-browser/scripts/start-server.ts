import { serve } from "@/index.js";
import { execSync } from "child_process";
import { mkdirSync, existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createServer } from "net";
import { randomBytes } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const tmpDir = join(__dirname, "..", "tmp");
const profileDir = join(__dirname, "..", "profiles");

// Create tmp and profile directories if they don't exist
console.log("Creating tmp directory...");
mkdirSync(tmpDir, { recursive: true });
console.log("Creating profiles directory...");
mkdirSync(profileDir, { recursive: true });

// Install Playwright browsers if not already installed
console.log("Checking Playwright browser installation...");

function findPackageManager(): { name: string; command: string } | null {
  const managers = [
    { name: "bun", command: "bunx playwright install chromium" },
    { name: "pnpm", command: "pnpm exec playwright install chromium" },
    { name: "npm", command: "npx playwright install chromium" },
  ];

  for (const manager of managers) {
    try {
      execSync(`which ${manager.name}`, { stdio: "ignore" });
      return manager;
    } catch {
      // Package manager not found, try next
    }
  }
  return null;
}

function isChromiumInstalled(): boolean {
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const playwrightCacheDir = join(homeDir, ".cache", "ms-playwright");

  if (!existsSync(playwrightCacheDir)) {
    return false;
  }

  // Check for chromium directories (e.g., chromium-1148, chromium_headless_shell-1148)
  try {
    const entries = readdirSync(playwrightCacheDir);
    return entries.some((entry) => entry.startsWith("chromium"));
  } catch {
    return false;
  }
}

try {
  if (!isChromiumInstalled()) {
    console.log("Playwright Chromium not found. Installing (this may take a minute)...");

    const pm = findPackageManager();
    if (!pm) {
      throw new Error("No package manager found (tried bun, pnpm, npm)");
    }

    console.log(`Using ${pm.name} to install Playwright...`);
    execSync(pm.command, { stdio: "inherit" });
    console.log("Chromium installed successfully.");
  } else {
    console.log("Playwright Chromium already installed.");
  }
} catch (error) {
  console.error("Failed to install Playwright browsers:", error);
  console.log("You may need to run: npx playwright install chromium");
}

async function getFreePort(host: string): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to determine free port")));
        return;
      }
      const { port } = address;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function isPortAvailable(port: number, host: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

async function choosePort(preferred: number, host: string, label: string): Promise<number> {
  if (await isPortAvailable(preferred, host)) return preferred;
  const port = await getFreePort(host);
  console.warn(`${label} port ${preferred} is in use; using ${port} instead.`);
  return port;
}

console.log("Starting dev browser server...");
const headless = process.env.HEADLESS === "true";
const host = process.env.DEV_BROWSER_HOST || "127.0.0.1";
const preferredPort = Number(process.env.DEV_BROWSER_PORT || 9222);
const preferredCdpPort = Number(process.env.DEV_BROWSER_CDP_PORT || 9223);
const allowRemote = process.env.DEV_BROWSER_ALLOW_REMOTE === "true";
const lockdown = process.env.DEV_BROWSER_LOCKDOWN === "true";
let authToken = process.env.DEV_BROWSER_TOKEN;
const requireAuth = lockdown || process.env.DEV_BROWSER_REQUIRE_AUTH === "true";
const allowedHosts = process.env.DEV_BROWSER_ALLOWED_HOSTS
  ? process.env.DEV_BROWSER_ALLOWED_HOSTS.split(",").map((s) => s.trim()).filter(Boolean)
  : undefined;
const tmpDirEnv = process.env.DEV_BROWSER_TMP_DIR;

if (requireAuth && !authToken) {
  authToken = randomBytes(32).toString("hex");
  console.log("Generated DEV_BROWSER_TOKEN (not set in env).");
  console.log(`  DEV_BROWSER_TOKEN=${authToken}`);
}

const port = await choosePort(preferredPort, host, "HTTP");
const cdpPort = await choosePort(preferredCdpPort, host, "CDP");

const server = await serve({
  host,
  port,
  headless,
  cdpHost: host,
  cdpPort,
  profileDir,
  allowRemote,
  authToken,
  requireAuth,
  lockdown,
  allowedHosts,
  tmpDir: tmpDirEnv,
});

console.log(`Dev browser server started`);
console.log(`  HTTP API: http://${host}:${server.port}`);
if (lockdown) {
  console.log(`  Mode: lockdown (no wsEndpoint exposed)`);
} else {
  console.log(`  WebSocket: ${server.wsEndpoint}`);
}
console.log(`  Tmp directory: ${tmpDir}`);
console.log(`  Profile directory: ${profileDir}`);
console.log(`\nReady`);
console.log(`\nPress Ctrl+C to stop`);

// Keep the process running
await new Promise(() => {});
