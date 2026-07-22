#!/usr/bin/env node

import { createServer } from "node:http";
import { constants } from "node:fs";
import { access, chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const skillSource = join(packageRoot, "skills", "htmlshare");
const publisherScript = join(skillSource, "scripts", "publish-htmlshare.mjs");
const appUrl = (process.env.HTMLSHARE_BASE_URL || "https://htmlshare.page").replace(/\/$/, "");
const cliCallbackPort = 38765;
const configPath = join(homedir(), ".htmlshare", "config.json");
const supportedAgents = new Set(["codex", "claude", "cursor", "all"]);

const agentTargets = {
  codex: join(homedir(), ".codex", "skills", "htmlshare"),
  claude: join(homedir(), ".claude", "skills", "htmlshare"),
  cursor: join(homedir(), ".cursor", "skills", "htmlshare"),
};

function usage() {
  return `Usage:
  htmlshare login
  htmlshare publish <path/to/index.html|project-dir>
  htmlshare update <path/to/index.html|project-dir> --replace <preview-url|slug|project-id>
  htmlshare install [--agent codex|claude|cursor|all] [--dry-run]

Examples:
  npx @htmlshare/cli login
  npx @htmlshare/cli publish ./dist
  npx @htmlshare/cli update ./dist --replace https://preview.htmlshare.page/abc123/index.html
  npx @htmlshare/cli install
  npx @htmlshare/cli install --agent codex
  npx @htmlshare/cli install --agent all`;
}

function readOption(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function installSkill(target, dryRun) {
  if (!(await pathExists(skillSource))) {
    throw new Error(`Missing bundled Skill files at ${skillSource}. Run npm pack from the CLI package before publishing.`);
  }

  if (dryRun) {
    console.log(`Would install HTMLShare Skill to ${target}`);
    return;
  }

  await mkdir(dirname(target), { recursive: true });
  await rm(target, { recursive: true, force: true });
  await cp(skillSource, target, { recursive: true });
  await cp(join(packageRoot, "package.json"), join(target, "package.json"));
  console.log(`Installed HTMLShare Skill to ${target}`);
}

function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.unref();
}

function normalizeExpiresAt(value) {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function saveConfig(config) {
  await mkdir(join(homedir(), ".htmlshare"), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2));
  await chmod(configPath, 0o600).catch(() => undefined);
}

function waitForCliLogin() {
  return new Promise((resolveSession, reject) => {
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
      resolveSession({
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

async function login() {
  const session = await waitForCliLogin();
  await saveConfig(session);
  console.log(`HTMLShare login saved to ${configPath}`);
}

function runPublisher(args, command = "publish") {
  if (!args[0]) {
    throw new Error(`${command} requires a path.\n\nUsage: htmlshare ${command} <path/to/index.html|project-dir>${command === "update" ? " --replace <preview-url|slug|project-id>" : ""}`);
  }

  if (command === "update" && !args.includes("--replace") && !args.includes("--project")) {
    throw new Error("update requires --replace <preview-url|slug|project-id>.");
  }

  const child = spawn(process.execPath, [publisherScript, ...args], { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }

  if (command === "--version" || command === "-v") {
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    console.log(manifest.version);
    return;
  }

  if (command === "login") {
    await login();
    return;
  }

  if (command === "publish") {
    runPublisher(args.slice(1));
    return;
  }

  if (command === "update") {
    runPublisher(args.slice(1), "update");
    return;
  }

  if (command !== "install") {
    throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }

  const agent = readOption(args, "--agent", "codex").toLowerCase();
  const dryRun = args.includes("--dry-run");

  if (!supportedAgents.has(agent)) {
    throw new Error(`Unsupported agent "${agent}". Use codex, claude, cursor, or all.`);
  }

  const agents = agent === "all" ? ["codex", "claude", "cursor"] : [agent];
  for (const currentAgent of agents) {
    await installSkill(agentTargets[currentAgent], dryRun);
  }

  if (!dryRun) {
    console.log("\nNext: restart your AI tool, then ask it to use the HTMLShare Skill to publish an HTML file or project folder.");
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
