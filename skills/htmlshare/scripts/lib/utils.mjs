import { extname } from "node:path";

export const allowedExtensions = new Set([".html", ".htm", ".css", ".js", ".mjs", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".woff", ".woff2", ".ttf", ".json", ".txt"]);
export const rewriteableExtensions = new Set([".html", ".htm", ".css", ".js", ".mjs", ".json", ".txt"]);

export function contentTypeFor(path) {
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

export class HtmlShareApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "HtmlShareApiError";
    this.status = status;
    this.code = code;
  }
}
