import { createServer } from "node:http";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HtmlShareApiError } from "./utils.mjs";

const appUrl = (process.env.HTMLSHARE_BASE_URL || "https://www.htmlshare.page").replace(/\/$/, "");
const configPath = join(homedir(), ".htmlshare", "config.json");
const cliCallbackPort = 38765;

async function readPackageVersion(startDir) {
  let currentDir = startDir;
  while (true) {
    const manifestPath = join(currentDir, "package.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        if (typeof manifest.version === "string" && manifest.version.trim()) {
          return manifest.version.trim();
        }
      } catch {
        return undefined;
      }
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) return undefined;
    currentDir = parentDir;
  }
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const skillVersion = await readPackageVersion(scriptDir);

export function requestHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    ...(skillVersion ? { "X-HTMLShare-Skill-Version": skillVersion } : {}),
  };
}

export async function readJsonResponse(response, fallbackMessage) {
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new HtmlShareApiError(result.message || result.error || fallbackMessage, response.status, result.error);
  }
  return result;
}

export async function loadConfig() {
  if (!existsSync(configPath)) return null;
  try {
    const stored = JSON.parse(await readFile(configPath, "utf8"));
    if (!stored.accessToken) return null;
    return stored;
  } catch {
    return null;
  }
}

export async function saveConfig(config) {
  await mkdir(join(homedir(), ".htmlshare"), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2));
  await chmod(configPath, 0o600).catch(() => undefined);
}

export async function clearConfig() {
  if (!existsSync(configPath)) return;
  await unlink(configPath).catch(() => undefined);
}

function normalizeExpiresAt(value) {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : undefined;
}

function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.unref();
}

function waitForWebAccessToken() {
  return new Promise((resolveToken, reject) => {
    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
      if (requestUrl.pathname !== "/auth/callback") {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found.");
        return;
      }

      const accessToken = requestUrl.searchParams.get("access_token");
      const refreshToken = requestUrl.searchParams.get("refresh_token");
      const expiresAt = normalizeExpiresAt(requestUrl.searchParams.get("expires_at"));

      if (!accessToken || !refreshToken) {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Missing session token.");
        return;
      }

      response.writeHead(302, { Location: `${appUrl}/cli/success` });
      response.end();
      server.close();
      resolveToken({ accessToken, refreshToken, tokenType: "Bearer", expiresAt });
    });

    server.on("error", (error) => {
      if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE") {
        reject(new Error(`Port ${cliCallbackPort} is already in use. Close the other HTMLShare login process and try again.`));
        return;
      }
      reject(error);
    });

    server.listen(cliCallbackPort, "127.0.0.1", () => {
      const loginUrl = new URL("/cli/login", appUrl);
      console.log(`Open this login link to authorize HTMLShare:\n${loginUrl.toString()}`);
      console.log(`Keep this process running until login redirects back to 127.0.0.1:${cliCallbackPort}.`);
      openBrowser(loginUrl.toString());
    });
  });
}

export async function authorize() {
  const config = await waitForWebAccessToken();
  await saveConfig(config);
  return config.accessToken;
}

export async function refreshConfig(config) {
  if (!config.refreshToken) return null;
  const response = await fetch(`${appUrl}/api/cli/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: config.refreshToken }),
  });
  const result = await readJsonResponse(response, "HTMLShare login refresh failed.");
  const refreshed = {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    tokenType: result.tokenType ?? "Bearer",
    expiresAt: normalizeExpiresAt(result.expiresAt),
  };
  await saveConfig(refreshed);
  return refreshed;
}

export async function getAccessToken() {
  const config = await loadConfig();
  if (!config) return authorize();

  const expiresAt = normalizeExpiresAt(config.expiresAt);
  if (!expiresAt || Date.now() <= expiresAt - 60_000) {
    return config.accessToken;
  }

  const refreshed = await refreshConfig(config).catch(() => null);
  if (refreshed?.accessToken) return refreshed.accessToken;

  await clearConfig();
  return authorize();
}

export function isAuthorizationError(error) {
  return (
    error instanceof HtmlShareApiError &&
    (error.status === 401 || error.code === "unauthorized" || error.code === "authorization_expired")
  );
}
