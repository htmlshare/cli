import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, extname, join, posix, relative } from "node:path";
import { allowedExtensions, contentTypeFor, rewriteableExtensions } from "./utils.mjs";
import { requestHeaders, readJsonResponse, skillVersion } from "./auth.mjs";
import { validateAndFixLocalRefs } from "./asset-validator.mjs";

const appUrl = (process.env.HTMLSHARE_BASE_URL || "https://www.htmlshare.page").replace(/\/$/, "");

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

export async function collectFiles(root) {
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

export async function publishHtml(accessToken, absolutePath, replace) {
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
  return { url: result.url, projectId: result.projectId, clientUpdate: result.clientUpdate ?? null };
}

export async function publishFiles(accessToken, root, replace) {
  const rawFiles = await collectFiles(root);
  const { files, issues } = await validateAndFixLocalRefs(rawFiles, dirname(root));
  if (issues.fixed.length > 0) {
    console.log("\nFixed misplaced asset references:");
    for (const f of issues.fixed) {
      const extra = f.addedFrom ? ` (copied from ${f.addedFrom})` : "";
      console.log(`  ${f.file}: "${f.from}" -> "${f.to}"${extra}`);
    }
  }
  if (issues.missing.length > 0) {
    console.warn("\nMissing assets (will 404 after publish):");
    for (const m of issues.missing) {
      console.warn(`  ${m.file}: "${m.ref}"`);
    }
    console.warn("");
  }
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
  return { url: result.url, projectId: result.projectId, clientUpdate: result.clientUpdate ?? null };
}
