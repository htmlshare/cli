#!/usr/bin/env node

import { stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { getAccessToken, authorize, clearConfig, isAuthorizationError, readJsonResponse, requestHeaders } from "./lib/auth.mjs";
import { publishHtml, publishFiles } from "./lib/publish.mjs";

const appUrl = (process.env.HTMLSHARE_BASE_URL || "https://www.htmlshare.page").replace(/\/$/, "");
const lanvoBaseDomain = (process.env.LANVO_BASE_DOMAIN || "lanvo.app").replace(/^\./, "").toLowerCase();

const args = process.argv.slice(2);
const replaceTarget = readOption(args, "--replace") || readOption(args, "--project");
const domainTarget = readOption(args, "--domain");
const htmlPath = args.find((arg) => !arg.startsWith("-") && arg !== replaceTarget && arg !== domainTarget);

if (!htmlPath) {
  console.error("Usage: node scripts/publish-htmlshare.mjs path/to/index.html|project-dir [--replace preview-url|slug|project-id]");
  process.exit(1);
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

  let existingDomain = null;
  let effectiveReplace = replaceTarget;

  if (label) {
    existingDomain = await lookupDomain(accessToken, label);
    if (existingDomain && !replaceTarget) {
      effectiveReplace = existingDomain.projectId;
    }
  }

  const { url, projectId, clientUpdate } = await publish(accessToken, effectiveReplace);

  if (label && !existingDomain) {
    try {
      await bindDomain(accessToken, projectId, label);
    } catch (bindError) {
      console.log(`${effectiveReplace ? "Updated" : "Published"} to HTMLShare:\n${url}`);
      throw bindError;
    }
  }

  return { url, label, wasUpdate: Boolean(effectiveReplace), clientUpdate };
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

  const { url, label, wasUpdate, clientUpdate } = result;
  const verb = wasUpdate ? "Updated" : "Published";
  if (label) {
    console.log(`${verb} to HTMLShare:\n${url}\nSubdomain: https://${label}.${lanvoBaseDomain}`);
  } else {
    console.log(`${verb} to HTMLShare:\n${url}`);
  }

  if (clientUpdate) {
    console.log(`\nA newer HTMLShare Skill is available (${clientUpdate.version}).`);
    console.log(clientUpdate.notes);
    console.log(`Install it with:\n  ${clientUpdate.installCommand}`);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
