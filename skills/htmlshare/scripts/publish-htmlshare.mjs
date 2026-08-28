#!/usr/bin/env node

import { createServer } from "node:http";
import { chmod, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, posix, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const appUrl = (process.env.HTMLSHARE_BASE_URL || "https://www.htmlshare.page").replace(/\/$/, "");
const lanvoBaseDomain = (process.env.LANVO_BASE_DOMAIN || "lanvo.app").replace(/^\./, "").toLowerCase();
const scriptDir = dirname(fileURLToPath(import.meta.url));
const skillVersion = await readPackageVersion(scriptDir);
const configPath = join(homedir(), ".htmlshare", "config.json");
const cliCallbackPort = 38765;
const args = process.argv.slice(2);
const replaceTarget = readOption(args, "--replace") || readOption(args, "--project");
const domainTarget = readOption(args, "--domain");
const htmlPath = args.find((arg) => !arg.startsWith("-") && arg !== replaceTarget && arg !== domainTarget);

if (!htmlPath) {
  console.error("Usage: node scripts/publish-htmlshare.mjs path/to/index.html|project-dir [--replace preview-url|slug|project-id]");
  process.exit(1);
}

const allowedExtensions = new Set([".html", ".htm", ".css", ".js", ".mjs", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".woff", ".woff2", ".ttf", ".json", ".txt"]);
const rewriteableExtensions = new Set([".html", ".htm", ".css", ".js", ".mjs", ".json", ".txt"]);

class HtmlShareApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "HtmlShareApiError";
    this.status = status;
    this.code = code;
  }
}

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${name} requires a preview URL, slug, or project ID.`);
  }
  return value;
}

function contentTypeFor(path) {
  const ext = extname(path).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
  };
  return types[ext] || "application/octet-stream";
}

function toObjectPath(root, filePath) {
  return relative(root, filePath).replaceAll("\\", "/");
}

function splitUrlPath(value) {
  const queryIndex = value.indexOf("?");
  const hashIndex = value.indexOf("#");
  const suffixIndex =
    queryIndex === -1 ? hashIndex : hashIndex === -1 ? queryIndex : Math.min(queryIndex, hashIndex);

  if (suffixIndex === -1) {
    return { path: value, suffix: "" };
  }

  return {
    path: value.slice(0, suffixIndex),
    suffix: value.slice(suffixIndex),
  };
}

function relativeAssetUrl(fromPath, targetPath, suffix) {
  const fromDir = posix.dirname(fromPath);
  let rewritten = posix.relative(fromDir === "." ? "" : fromDir, targetPath);

  if (!rewritten.startsWith(".")) {
    rewritten = `./${rewritten}`;
  }

  return `${rewritten}${suffix}`;
}

function rewriteRootRelativeAssetReferences(content, filePath, uploadedPaths) {
  return content.replace(/(^|["'`(\s=:])\/(?!\/)([A-Za-z0-9._~!$&+,;=:@%/-]+(?:[?#][^"'`()\s<>]*)?)/g, (match, prefix, value) => {
    const { path, suffix } = splitUrlPath(value);
    let decodedPath = path;
    try {
      decodedPath = decodeURIComponent(path);
    } catch {
      return match;
    }

    if (!uploadedPaths.has(path) && !uploadedPaths.has(decodedPath)) {
      return match;
    }

    return `${prefix}${relativeAssetUrl(filePath, uploadedPaths.has(path) ? path : decodedPath, suffix)}`;
  });
}

function htmlTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = match?.[1]
    ?.replace(/<[^>]*>/g, "")
    .replaceAll(/\s+/g, " ")
    .trim();

  return title || undefined;
}

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

function requestHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    ...(skillVersion ? { "X-HTMLShare-Skill-Version": skillVersion } : {}),
  };
}

async function collectFiles(root) {
  const files = [];

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !allowedExtensions.has(extname(entry.name).toLowerCase())) continue;
      const path = toObjectPath(root, fullPath);
      files.push({
        path,
        content: await readFile(fullPath),
        contentType: contentTypeFor(fullPath),
      });
    }
  }

  await walk(root);
  const uploadedPaths = new Set(files.map((file) => file.path));

  return files.map((file) => {
    const ext = extname(file.path).toLowerCase();
    const content = rewriteableExtensions.has(ext)
      ? Buffer.from(rewriteRootRelativeAssetReferences(file.content.toString("utf8"), file.path, uploadedPaths), "utf8")
      : file.content;

    return {
      path: file.path,
      contentBase64: content.toString("base64"),
      contentType: file.contentType,
    };
  });
}

function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.unref();
}

async function loadConfig() {
  if (!existsSync(configPath)) return null;
  try {
    const stored = JSON.parse(await readFile(configPath, "utf8"));
    if (!stored.accessToken) return null;
    return stored;
  } catch {
    return null;
  }
}

async function saveConfig(config) {
  await mkdir(join(homedir(), ".htmlshare"), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2));
  await chmod(configPath, 0o600).catch(() => undefined);
}

async function clearConfig() {
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
      resolveToken({
        accessToken,
        refreshToken,
        tokenType: "Bearer",
        expiresAt,
      });
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

async function authorize() {
  const config = await waitForWebAccessToken();
  await saveConfig(config);
  return config.accessToken;
}

async function refreshConfig(config) {
  if (!config.refreshToken) return null;

  const response = await fetch(`${appUrl}/api/cli/refresh`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      refreshToken: config.refreshToken,
    }),
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

async function getAccessToken() {
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

async function readJsonResponse(response, fallbackMessage) {
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new HtmlShareApiError(result.message || result.error || fallbackMessage, response.status, result.error);
  }

  return result;
}

function isAuthorizationError(error) {
  return (
    error instanceof HtmlShareApiError &&
    (error.status === 401 || error.code === "unauthorized" || error.code === "authorization_expired")
  );
}

function extractLanvoLabel(hostname) {
  const normalized = hostname.trim().toLowerCase();
  const suffix = `.${lanvoBaseDomain}`;
  if (normalized.endsWith(suffix)) {
    return normalized.slice(0, normalized.length - suffix.length);
  }
  if (!normalized.includes(".")) {
    return normalized;
  }
  throw new Error(`Unrecognized domain format "${hostname}". Use a subdomain like "myapp.${lanvoBaseDomain}".`);
}

async function lookupDomain(accessToken, label) {
  const response = await fetch(`${appUrl}/api/cli/domains?label=${encodeURIComponent(label)}`, {
    headers: requestHeaders(accessToken),
  });
  const result = await readJsonResponse(response, "Domain lookup failed.");
  return result.domain ?? null;
}

async function bindDomain(accessToken, projectId, label) {
  const response = await fetch(`${appUrl}/api/cli/domains`, {
    method: "POST",
    headers: requestHeaders(accessToken),
    body: JSON.stringify({ projectId, label }),
  });
  const result = await readJsonResponse(response, "Domain binding failed.");
  return result.domain;
}

async function publishHtml(accessToken, absolutePath, replace) {
  const html = await readFile(absolutePath, "utf8");
  const response = await fetch(`${appUrl}/api/skill/publish`, {
    method: "POST",
    headers: requestHeaders(accessToken),
    body: JSON.stringify({
      name: basename(absolutePath),
      html,
      sourceType: "html",
      ...(replace ? { replace } : {}),
      ...(skillVersion ? { skillVersion } : {}),
    }),
  });

  const result = await readJsonResponse(response, "HTMLShare upload failed.");
  return { url: result.url, projectId: result.projectId };
}

async function publishFiles(accessToken, root, replace) {
  const files = await collectFiles(root);
  const entry = files.find((file) => file.path === "index.html");
  const name = entry ? htmlTitle(Buffer.from(entry.contentBase64, "base64").toString("utf8")) : undefined;
  const response = await fetch(`${appUrl}/api/skill/publish-files`, {
    method: "POST",
    headers: requestHeaders(accessToken),
    body: JSON.stringify({
      name: name ?? basename(root),
      files,
      sourceType: "files",
      ...(replace ? { replace } : {}),
      ...(skillVersion ? { skillVersion } : {}),
    }),
  });

  const result = await readJsonResponse(response, "HTMLShare upload failed.");
  return { url: result.url, projectId: result.projectId };
}

async function publish(accessToken, replace) {
  const absolutePath = resolve(htmlPath);
  const inputStat = await stat(absolutePath);

  if (inputStat.isDirectory()) {
    return publishFiles(accessToken, absolutePath, replace);
  }

  if (absolutePath.toLowerCase().endsWith(".zip")) {
    throw new Error("ZIP files are not supported by the Skill publisher. Pass the extracted project directory instead.");
  }

  if (basename(absolutePath).toLowerCase() === "index.html") {
    return publishFiles(accessToken, dirname(absolutePath), replace);
  }

  return publishHtml(accessToken, absolutePath, replace);
}

async function run(accessToken) {
  const label = domainTarget ? extractLanvoLabel(domainTarget) : null;

  // If --domain given, check if the label is already bound to this user's project
  let existingDomain = null;
  let effectiveReplace = replaceTarget;

  if (label) {
    existingDomain = await lookupDomain(accessToken, label);
    if (existingDomain && !replaceTarget) {
      effectiveReplace = existingDomain.projectId;
    }
  }

  const { url, projectId } = await publish(accessToken, effectiveReplace);

  // If --domain given and we just created a new project, bind the label
  if (label && !existingDomain) {
    try {
      await bindDomain(accessToken, projectId, label);
    } catch (bindError) {
      // Publish succeeded — show the URL before surfacing the bind error
      console.log(`${effectiveReplace ? "Updated" : "Published"} to HTMLShare:\n${url}`);
      throw bindError;
    }
  }

  return { url, label, wasUpdate: Boolean(effectiveReplace) };
}

let token = await getAccessToken();

try {
  let result;
  try {
    result = await run(token);
  } catch (error) {
    if (!isAuthorizationError(error)) throw error;

    console.error("HTMLShare authorization expired or was revoked. Opening login to reconnect...");
    await clearConfig();
    token = await authorize();
    result = await run(token);
  }

  const { url, label, wasUpdate } = result;
  const verb = wasUpdate ? "Updated" : "Published";
  if (label) {
    console.log(`${verb} to HTMLShare:\n${url}\nSubdomain: https://${label}.${lanvoBaseDomain}`);
  } else {
    console.log(`${verb} to HTMLShare:\n${url}`);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
