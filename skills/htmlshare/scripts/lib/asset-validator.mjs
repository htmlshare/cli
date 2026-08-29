import { basename, extname, join, posix, relative } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { allowedExtensions, contentTypeFor } from "./utils.mjs";

function isExternalOrAbsoluteRef(ref) {
  const s = ref.trim();
  return !s || /^(https?:|\/\/|data:|#|mailto:|tel:|javascript:|blob:)/i.test(s);
}

function normalizeRefPath(ref) {
  const pathPart = ref.split("?")[0].split("#")[0].trim();
  try {
    return decodeURIComponent(pathPart);
  } catch {
    return pathPart;
  }
}

// Resolve a relative or root-relative ref in a file to a project-root-relative path
function resolveProjectPath(fromFilePath, ref) {
  const pathPart = normalizeRefPath(ref);
  // Root-relative (/assets/foo.png) resolves from project root regardless of which file references it
  if (pathPart.startsWith("/")) return pathPart.slice(1);
  const absBase = posix.join("/~", posix.dirname(fromFilePath));
  const absTarget = posix.join(absBase, pathPart);
  return absTarget.slice("/~/".length);
}

// Compute relative ref from fromFilePath to targetPath (both project-root-relative)
function computeNewRef(fromFilePath, targetPath) {
  const absFrom = posix.join("/~", posix.dirname(fromFilePath));
  const absTarget = posix.join("/~", targetPath);
  const rel = posix.relative(absFrom, absTarget);
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function extractLocalRefs(content, filePath) {
  const ext = extname(filePath).toLowerCase();
  const refs = new Set();

  function add(ref) {
    const s = ref?.trim();
    if (s && !isExternalOrAbsoluteRef(s)) refs.add(s);
  }

  if ([".html", ".htm"].includes(ext)) {
    for (const m of content.matchAll(/\b(?:src|href|data-src|poster)\s*=\s*"([^"]+)"/gi)) add(m[1]);
    for (const m of content.matchAll(/\b(?:src|href|data-src|poster)\s*=\s*'([^']+)'/gi)) add(m[1]);
  }

  if ([".html", ".htm", ".css"].includes(ext)) {
    for (const m of content.matchAll(/\burl\(\s*"([^"]+)"\s*\)/gi)) add(m[1]);
    for (const m of content.matchAll(/\burl\(\s*'([^']+)'\s*\)/gi)) add(m[1]);
    for (const m of content.matchAll(/\burl\(\s*([^"'][^)]*?)\s*\)/gi)) add(m[1]);
  }

  return refs;
}

function rewriteRefInContent(content, oldRef, newRef) {
  const esc = oldRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  content = content.replace(new RegExp(`"${esc}"`, "g"), `"${newRef}"`);
  content = content.replace(new RegExp(`'${esc}'`, "g"), `'${newRef}'`);
  content = content.replace(new RegExp(`url\\(\\s*${esc}\\s*\\)`, "g"), `url(${newRef})`);
  return content;
}

// Build a basename → [{absPath, projectPath}] index by walking a directory
async function buildSearchIndex(searchRoot, excludeDir) {
  const index = new Map();
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const absPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (absPath !== excludeDir) await walk(absPath);
        continue;
      }
      if (!entry.isFile() || !allowedExtensions.has(extname(entry.name).toLowerCase())) continue;
      const name = basename(entry.name);
      let decodedName;
      try { decodedName = decodeURIComponent(name); } catch { decodedName = name; }
      const projectPath = relative(searchRoot, absPath).replaceAll("\\", "/");
      for (const key of new Set([name, decodedName])) {
        if (!index.has(key)) index.set(key, []);
        index.get(key).push({ absPath, projectPath });
      }
    }
  }
  await walk(searchRoot);
  return index;
}

export async function validateAndFixLocalRefs(files, searchRoot) {
  const uploadedPaths = new Set(files.map((f) => f.path));

  // Index files by their decoded basename for fuzzy lookup within publish dir
  const byBasename = new Map();
  for (const f of files) {
    const name = posix.basename(f.path);
    let decodedName;
    try { decodedName = decodeURIComponent(name); } catch { decodedName = name; }
    for (const key of new Set([name, decodedName])) {
      if (!byBasename.has(key)) byBasename.set(key, []);
      byBasename.get(key).push(f.path);
    }
  }

  // Build search index from outside the publish dir if searchRoot is provided
  const searchIndex = searchRoot ? await buildSearchIndex(searchRoot, null) : new Map();

  const fixed = [];
  const missing = [];
  // Extra files to add from searchRoot: projectPath → file object
  const extraFiles = new Map();

  const newFiles = files.map((file) => {
    const ext = extname(file.path).toLowerCase();
    if (![".html", ".htm", ".css"].includes(ext)) return file;

    const content = Buffer.from(file.contentBase64, "base64").toString("utf8");
    const refs = extractLocalRefs(content, file.path);
    if (refs.size === 0) return file;

    const fixes = new Map();

    for (const ref of refs) {
      const resolved = resolveProjectPath(file.path, ref);
      const decodedResolved = normalizeRefPath(resolved);

      if (uploadedPaths.has(resolved) || uploadedPaths.has(decodedResolved)) continue;

      // Search by filename within publish dir
      const refBasename = posix.basename(normalizeRefPath(ref));
      let decodedBasename;
      try { decodedBasename = decodeURIComponent(refBasename); } catch { decodedBasename = refBasename; }
      const candidates = [...new Set([
        ...(byBasename.get(refBasename) ?? []),
        ...(byBasename.get(decodedBasename) ?? []),
      ])];

      if (candidates.length === 1) {
        const newRef = computeNewRef(file.path, candidates[0]);
        fixes.set(ref, newRef);
        fixed.push({ file: file.path, from: ref, to: newRef });
        continue;
      }

      // Not in publish dir — search in searchRoot
      const searchCandidates = [...new Set([
        ...(searchIndex.get(refBasename) ?? []),
        ...(searchIndex.get(decodedBasename) ?? []),
      ])];

      if (searchCandidates.length === 1) {
        const { absPath } = searchCandidates[0];
        // Place it at the resolved path (where HTML expects it)
        const targetPath = decodedResolved || resolved;
        if (!extraFiles.has(targetPath)) {
          extraFiles.set(targetPath, { absPath, targetPath });
        }
        const newRef = computeNewRef(file.path, targetPath);
        fixes.set(ref, newRef);
        fixed.push({ file: file.path, from: ref, to: newRef, addedFrom: absPath });
      } else {
        missing.push({ file: file.path, ref });
      }
    }

    if (fixes.size === 0) return file;

    let newContent = content;
    for (const [oldRef, newRef] of fixes) {
      newContent = rewriteRefInContent(newContent, oldRef, newRef);
    }

    return { ...file, contentBase64: Buffer.from(newContent, "utf8").toString("base64") };
  });

  // Read and append extra files from searchRoot
  for (const { absPath, targetPath } of extraFiles.values()) {
    const content = await readFile(absPath);
    newFiles.push({
      path: targetPath,
      contentBase64: content.toString("base64"),
      contentType: contentTypeFor(absPath),
    });
  }

  return { files: newFiles, issues: { fixed, missing } };
}
