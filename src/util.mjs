import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function randomId(prefix = "") {
  return `${prefix}${crypto.randomUUID()}`;
}

export function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function signValue(value, secret) {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

export function packSignedValue(value, secret) {
  return `${value}.${signValue(value, secret)}`;
}

export function unpackSignedValue(packed, secret) {
  if (!packed || typeof packed !== "string") {
    return null;
  }

  const splitIndex = packed.lastIndexOf(".");
  if (splitIndex === -1) {
    return null;
  }

  const value = packed.slice(0, splitIndex);
  const signature = packed.slice(splitIndex + 1);
  const expected = signValue(value, secret);
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length) {
    return null;
  }

  if (!crypto.timingSafeEqual(actualBytes, expectedBytes)) {
    return null;
  }

  return value;
}

export function parseCookies(req) {
  const header = req.headers.cookie || "";
  const cookies = {};
  for (const part of header.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (!name) {
      continue;
    }
    cookies[name] = decodeURIComponent(valueParts.join("="));
  }
  return cookies;
}

export function makeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || "/"}`);
  parts.push(`SameSite=${options.sameSite || "Lax"}`);
  if (options.httpOnly !== false) {
    parts.push("HttpOnly");
  }
  if (options.secure) {
    parts.push("Secure");
  }
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }
  return parts.join("; ");
}

export function sendJson(res, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Resource-Policy": "same-origin",
    ...headers
  });
  res.end(body);
}

export function sendNoContent(res) {
  res.writeHead(204, {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Resource-Policy": "same-origin"
  });
  res.end();
}

export function redirect(res, location, headers = {}) {
  res.writeHead(302, {
    Location: location,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Resource-Policy": "same-origin",
    ...headers
  });
  res.end();
}

export async function readJson(req, limit = 1024 * 1024) {
  const buffer = await readRawBody(req, limit);
  if (buffer.length === 0) {
    return {};
  }
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

export async function readRawBody(req, limit) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) {
      throw new HttpError(413, "Request body is too large");
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

export function sanitizeFileName(name) {
  const cleaned = String(name || "untitled")
    .replace(/[/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 160) || "untitled";
}

export function sanitizeChannelName(username, userId) {
  const base = String(username || "user")
    .normalize("NFKD")
    .replace(/[^\w-]+/g, "-")
    .replace(/_+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 64);
  return `drive-${base || "user"}-${String(userId).slice(-6)}`.slice(0, 100);
}

export function contentDisposition(type, fileName) {
  const fallback = sanitizeFileName(fileName).replace(/[^\x20-\x7E]/g, "_");
  const encoded = encodeURIComponent(fileName).replace(/[()]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function parseRange(rangeHeader, size) {
  if (!rangeHeader) {
    return null;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) {
    return { unsatisfiable: true };
  }

  let start;
  let end;

  if (match[1] === "" && match[2] === "") {
    return { unsatisfiable: true };
  }

  if (match[1] === "") {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return { unsatisfiable: true };
    }
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
  }

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return { unsatisfiable: true };
  }

  return {
    start,
    end: Math.min(end, size - 1)
  };
}

export async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function safeJoin(root, requestedPath) {
  const normalized = requestedPath.replace(/^[/\\]+/, "");
  const fullPath = path.resolve(root, normalized);
  const relative = path.relative(root, fullPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new HttpError(403, "Forbidden");
  }
  return fullPath;
}

export function publicFileType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon"
  };
  return types[ext] || "application/octet-stream";
}
