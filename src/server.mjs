import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { config, requireConfig } from "./config.mjs";
import { DiscordApiError, DiscordClient } from "./discord.mjs";
import { JsonStore } from "./store.mjs";
import {
  HttpError,
  contentDisposition,
  fileExists,
  makeCookie,
  packSignedValue,
  parseCookies,
  parseRange,
  publicFileType,
  randomId,
  readJson,
  readRawBody,
  redirect,
  safeJoin,
  sanitizeFileName,
  sendJson,
  sendNoContent,
  sha256,
  unpackSignedValue
} from "./util.mjs";

const store = new JsonStore(path.join(config.dataDir, "store.json"));
const discord = new DiscordClient(config);

await store.init();
await ensureAccountAdmin();
cleanupExpiredSessions();

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => handleError(req, res, error));
});

server.listen(config.port, () => {
  console.log(`Discord Drive listening on ${config.publicBaseUrl}`);
});

async function handleRequest(req, res) {
  const url = new URL(req.url, config.publicBaseUrl);

  if (req.method === "GET" && url.pathname === "/auth/login") {
    return login(req, res);
  }

  if (req.method === "GET" && url.pathname === "/auth/callback") {
    return callback(req, res, url);
  }

  if (req.method === "POST" && url.pathname === "/auth/logout") {
    return logout(req, res);
  }

  if (url.pathname.startsWith("/api/")) {
    return api(req, res, url);
  }

  return staticFile(req, res, url);
}

async function login(_req, res) {
  requireConfig(["discordClientId"]);

  const state = crypto.randomBytes(24).toString("base64url");
  const authorize = new URL("https://discord.com/oauth2/authorize");
  authorize.searchParams.set("client_id", config.discordClientId);
  authorize.searchParams.set("redirect_uri", config.discordRedirectUri);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "identify");
  authorize.searchParams.set("state", state);

  redirect(res, authorize.toString(), {
    "Set-Cookie": makeCookie(
      config.oauthStateCookieName,
      packSignedValue(state, config.sessionSecret),
      {
        maxAge: 600,
        secure: config.discordRedirectUri.startsWith("https:")
      }
    )
  });
}

async function callback(req, res, url) {
  requireConfig(["discordClientId", "discordClientSecret"]);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const packedState = parseCookies(req)[config.oauthStateCookieName];
  const expectedState = unpackSignedValue(packedState, config.sessionSecret);

  if (!code || !state || !expectedState || expectedState !== state) {
    throw new HttpError(400, "OAuth state validation failed");
  }

  const token = await discord.exchangeCode(code);
  const discordUser = await discord.getOAuthUser(token.access_token);
  const sessionId = randomId("sess_");
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const expiresAt = now + config.sessionMaxAgeSeconds * 1000;

  await store.update((data) => {
    const existing = data.users[discordUser.id] || {};
    if (existing.disabled) {
      throw new HttpError(403, "Account is disabled");
    }

    const hasAdmin = Object.values(data.users).some(isAdminUser);
    const firstUser = Object.keys(data.users).length === 0;
    const role = existing.role === "admin" || firstUser || !hasAdmin ? "admin" : "user";

    data.users[discordUser.id] = {
      ...existing,
      id: discordUser.id,
      username: discordUser.username,
      globalName: discordUser.global_name || "",
      avatar: discordUser.avatar || "",
      role,
      disabled: false,
      createdAt: existing.createdAt || nowIso,
      updatedAt: nowIso,
      lastLoginAt: nowIso
    };
    data.sessions[sessionId] = {
      id: sessionId,
      userId: discordUser.id,
      createdAt: nowIso,
      expiresAt
    };
  });

  redirect(res, "/", {
    "Set-Cookie": [
      makeCookie(config.sessionCookieName, packSignedValue(sessionId, config.sessionSecret), {
        maxAge: config.sessionMaxAgeSeconds,
        secure: config.publicBaseUrl.startsWith("https:")
      }),
      makeCookie(config.oauthStateCookieName, "", { maxAge: 0 })
    ]
  });
}

async function logout(req, res) {
  const session = getSession(req);
  if (session) {
    await store.update((data) => {
      delete data.sessions[session.id];
    });
  }

  sendNoContentWithCookie(res, makeCookie(config.sessionCookieName, "", { maxAge: 0 }));
}

async function api(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/me") {
    const auth = requireAuth(req);
    return sendJson(res, 200, {
      user: publicUser(auth.user),
      config: {
        chunkSizeBytes: config.chunkSizeBytes,
        maxPreviewTextBytes: 128 * 1024
      }
    });
  }

  if (req.method === "GET" && url.pathname === "/api/users") {
    requireAdmin(req);
    return listUsers(res);
  }

  const userMatch = /^\/api\/users\/([^/]+)$/.exec(url.pathname);
  if (userMatch) {
    const auth = requireAdmin(req);
    if (req.method === "PATCH") {
      return updateUserAccount(req, res, auth, decodeURIComponent(userMatch[1]));
    }
  }

  if (req.method === "GET" && url.pathname === "/api/files") {
    const auth = requireAuth(req);
    const data = store.snapshot();
    const files = Object.values(data.files)
      .filter((file) => file.ownerId === auth.user.id && file.status !== "deleted")
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .map(publicFile);
    return sendJson(res, 200, { files });
  }

  if (req.method === "POST" && url.pathname === "/api/uploads/init") {
    const auth = requireAuth(req);
    return initUpload(req, res, auth);
  }

  const chunkMatch = /^\/api\/uploads\/([^/]+)\/chunks\/(\d+)$/.exec(url.pathname);
  if (req.method === "PUT" && chunkMatch) {
    const auth = requireAuth(req);
    return uploadChunk(req, res, auth, chunkMatch[1], Number(chunkMatch[2]));
  }

  const fileMatch = /^\/api\/files\/([^/]+)$/.exec(url.pathname);
  if (fileMatch) {
    const auth = requireAuth(req);
    if (req.method === "GET") {
      const file = getOwnedFile(auth.user.id, fileMatch[1]);
      return sendJson(res, 200, { file: publicFile(file) });
    }
    if (req.method === "PATCH") {
      return updateFile(req, res, auth, fileMatch[1]);
    }
    if (req.method === "DELETE") {
      return deleteFile(res, auth, fileMatch[1]);
    }
  }

  const textPreviewMatch = /^\/api\/files\/([^/]+)\/text-preview$/.exec(url.pathname);
  if (req.method === "GET" && textPreviewMatch) {
    const auth = requireAuth(req);
    return textPreview(res, auth, textPreviewMatch[1], url);
  }

  const rawMatch = /^\/api\/files\/([^/]+)\/(raw|download)$/.exec(url.pathname);
  if (req.method === "GET" && rawMatch) {
    const auth = requireAuth(req);
    return streamFile(req, res, auth, rawMatch[1], rawMatch[2] === "download");
  }

  throw new HttpError(404, "API route not found");
}

function listUsers(res) {
  const data = store.snapshot();
  const stats = userStats(data);
  const users = Object.values(data.users)
    .sort((a, b) => {
      const time = accountTimestamp(b) - accountTimestamp(a);
      return time || String(a.username).localeCompare(String(b.username));
    })
    .map((user) => publicAccount(user, stats.get(user.id)));

  sendJson(res, 200, { users });
}

async function updateUserAccount(req, res, auth, userId) {
  const body = await readJson(req);
  const updated = await store.update((data) => {
    const user = data.users[userId];
    if (!user) {
      throw new HttpError(404, "User not found");
    }

    const role = Object.hasOwn(body, "role") ? normalizeRole(body.role) : accountRole(user);
    const disabled = Object.hasOwn(body, "disabled") ? Boolean(body.disabled) : Boolean(user.disabled);

    if (user.id === auth.user.id && role !== "admin") {
      throw new HttpError(400, "You cannot remove your own admin role");
    }

    if (user.id === auth.user.id && disabled) {
      throw new HttpError(400, "You cannot disable your own account");
    }

    const users = Object.values(data.users).map((candidate) =>
      candidate.id === user.id ? { ...candidate, role, disabled } : candidate
    );
    const hasEnabledAdmin = users.some((candidate) => isAdminUser(candidate) && !candidate.disabled);
    if (!hasEnabledAdmin) {
      throw new HttpError(400, "At least one enabled admin is required");
    }

    user.role = role;
    user.disabled = disabled;
    user.updatedAt = new Date().toISOString();
    if (disabled) {
      for (const [sessionId, session] of Object.entries(data.sessions)) {
        if (session.userId === user.id) {
          delete data.sessions[sessionId];
        }
      }
    }
    return structuredClone(user);
  });

  const stats = userStats(store.snapshot()).get(updated.id);
  sendJson(res, 200, { user: publicAccount(updated, stats) });
}

async function initUpload(req, res, auth) {
  const body = await readJson(req);
  const name = sanitizeFileName(body.name);
  const size = Number(body.size);
  const type = String(body.type || "application/octet-stream").slice(0, 180);

  if (!Number.isSafeInteger(size) || size < 0) {
    throw new HttpError(400, "Invalid file size");
  }

  const userSpace = await ensureUserSpace(auth.user);
  const fileId = randomId("file_");
  const now = new Date().toISOString();
  const chunkCount = size === 0 ? 0 : Math.ceil(size / config.chunkSizeBytes);
  const status = chunkCount === 0 ? "complete" : "uploading";

  const file = {
    id: fileId,
    ownerId: auth.user.id,
    channelId: userSpace.channelId,
    name,
    size,
    type,
    chunkSize: config.chunkSizeBytes,
    chunkCount,
    webhookId: userSpace.webhookId,
    webhookToken: userSpace.webhookToken,
    chunks: {},
    status,
    createdAt: now,
    updatedAt: now,
    lastModified: body.lastModified || null
  };

  await store.update((data) => {
    data.files[fileId] = file;
  });

  sendJson(res, 201, { file: publicFile(file) });
}

async function uploadChunk(req, res, auth, fileId, index) {
  let file = getOwnedFile(auth.user.id, fileId);
  if (file.status === "complete" && file.chunks[String(index)]) {
    return sendJson(res, 200, { file: publicFile(file), chunk: file.chunks[String(index)] });
  }

  if (file.status !== "uploading") {
    throw new HttpError(409, "File is not accepting chunks");
  }

  if (!Number.isSafeInteger(index) || index < 0 || index >= file.chunkCount) {
    throw new HttpError(400, "Invalid chunk index");
  }

  if (file.chunks[String(index)]) {
    return sendJson(res, 200, { file: publicFile(file), chunk: file.chunks[String(index)] });
  }

  const expectedSize = Math.min(file.chunkSize, file.size - index * file.chunkSize);
  const buffer = await readRawBody(req, file.chunkSize);
  if (buffer.length !== expectedSize) {
    throw new HttpError(400, `Invalid chunk size. Expected ${expectedSize} bytes.`);
  }

  const userSpace = await ensureUserSpace(auth.user);
  const hash = sha256(buffer);
  const paddedIndex = String(index + 1).padStart(6, "0");
  const chunkFileName = `${file.id}.${paddedIndex}.chunk`;
  const message = await discord.uploadChunk(
    {
      id: userSpace.webhookId,
      token: userSpace.webhookToken
    },
    {
      buffer,
      fileName: chunkFileName,
      content: [
        `Discord Drive chunk`,
        `file=${file.id}`,
        `index=${index + 1}/${file.chunkCount}`,
        `sha256=${hash}`
      ].join("\n"),
      description: `${file.name} part ${index + 1} of ${file.chunkCount}`
    }
  );

  const attachment = message.attachments?.[0];
  if (!attachment) {
    throw new HttpError(502, "Discord did not return an attachment for the uploaded chunk");
  }

  const chunk = {
    index,
    size: buffer.length,
    sha256: hash,
    messageId: message.id,
    attachmentId: attachment.id,
    attachmentName: attachment.filename,
    webhookId: userSpace.webhookId,
    webhookToken: userSpace.webhookToken,
    createdAt: new Date().toISOString()
  };

  file = await store.update((data) => {
    const current = data.files[fileId];
    if (!current || current.ownerId !== auth.user.id) {
      throw new HttpError(404, "File not found");
    }
    current.chunks[String(index)] = chunk;
    current.updatedAt = new Date().toISOString();
    if (Object.keys(current.chunks).length === current.chunkCount) {
      current.status = "complete";
    }
    return structuredClone(current);
  });

  sendJson(res, 201, { file: publicFile(file), chunk });
}

async function deleteFile(res, auth, fileId) {
  const file = getOwnedFile(auth.user.id, fileId);
  const chunks = orderedChunks(file);

  for (const chunk of chunks) {
    try {
      await discord.deleteWebhookMessage(resolveChunkWebhook(file, chunk), chunk.messageId);
    } catch (error) {
      if (!(error instanceof DiscordApiError) || error.status !== 404) {
        throw error;
      }
    }
  }

  await store.update((data) => {
    if (data.files[fileId]?.ownerId === auth.user.id) {
      data.files[fileId].status = "deleted";
      data.files[fileId].updatedAt = new Date().toISOString();
    }
  });

  sendNoContent(res);
}

async function updateFile(req, res, auth, fileId) {
  const body = await readJson(req);
  const file = await store.update((data) => {
    const current = data.files[fileId];
    if (!current || current.ownerId !== auth.user.id || current.status === "deleted") {
      throw new HttpError(404, "File not found");
    }

    let changed = false;
    if (Object.hasOwn(body, "name")) {
      const name = sanitizeFileName(body.name);
      if (name !== current.name) {
        current.name = name;
        changed = true;
      }
    }

    if (Object.hasOwn(body, "favorite")) {
      const favorite = Boolean(body.favorite);
      if (favorite !== Boolean(current.favorite)) {
        current.favorite = favorite;
        changed = true;
      }
    }

    if (changed) {
      current.updatedAt = new Date().toISOString();
    }

    return structuredClone(current);
  });

  sendJson(res, 200, { file: publicFile(file) });
}

async function textPreview(res, auth, fileId, url) {
  const file = getOwnedFile(auth.user.id, fileId);
  assertComplete(file);
  const max = Math.min(Number(url.searchParams.get("max")) || 128 * 1024, 256 * 1024);
  const bytes = await collectFileBytes(file, 0, Math.max(0, Math.min(file.size, max) - 1));
  sendJson(res, 200, {
    text: bytes.toString("utf8"),
    truncated: file.size > max
  });
}

async function streamFile(req, res, auth, fileId, asDownload) {
  const file = getOwnedFile(auth.user.id, fileId);
  assertComplete(file);

  if (file.size === 0) {
    res.writeHead(200, {
      "Content-Type": file.type || "application/octet-stream",
      "Content-Length": 0,
      "Content-Disposition": contentDisposition(asDownload ? "attachment" : "inline", file.name)
    });
    return res.end();
  }

  const parsedRange = parseRange(req.headers.range, file.size);
  if (parsedRange?.unsatisfiable) {
    res.writeHead(416, {
      "Content-Range": `bytes */${file.size}`
    });
    return res.end();
  }

  const start = parsedRange?.start ?? 0;
  const end = parsedRange?.end ?? file.size - 1;
  const length = end - start + 1;
  const status = parsedRange ? 206 : 200;
  const ranges = chunkRanges(file, start, end);
  if (ranges.length === 0) {
    throw new HttpError(502, "No stored chunks matched the requested file range");
  }

  const firstRange = ranges.shift();
  const firstBytes = await fetchChunkBytes(
    file,
    firstRange.chunk,
    firstRange.from,
    firstRange.to
  );

  res.writeHead(status, {
    "Content-Type": file.type || "application/octet-stream",
    "Content-Length": length,
    "Accept-Ranges": "bytes",
    "Content-Disposition": contentDisposition(asDownload ? "attachment" : "inline", file.name),
    ...(parsedRange ? { "Content-Range": `bytes ${start}-${end}/${file.size}` } : {})
  });

  res.write(firstBytes);
  await writeRemainingRanges(res, file, ranges);
}

async function writeRemainingRanges(res, file, ranges) {
  for (const range of ranges) {
    const bytes = await fetchChunkBytes(file, range.chunk, range.from, range.to);
    if (res.destroyed) {
      return;
    }
    res.write(bytes);
  }

  res.end();
}

function chunkRanges(file, start, end) {
  const chunks = orderedChunks(file);
  const ranges = [];
  let chunkOffset = 0;

  for (const chunk of chunks) {
    const chunkStart = chunkOffset;
    const chunkEnd = chunkOffset + chunk.size - 1;
    chunkOffset += chunk.size;

    if (chunkEnd < start || chunkStart > end) {
      continue;
    }

    const from = Math.max(start, chunkStart) - chunkStart;
    const to = Math.min(end, chunkEnd) - chunkStart;
    ranges.push({ chunk, from, to });
  }

  return ranges;
}

async function collectFileBytes(file, start, end) {
  if (file.size === 0 || end < start) {
    return Buffer.alloc(0);
  }

  const chunks = orderedChunks(file);
  const buffers = [];
  let chunkOffset = 0;

  for (const chunk of chunks) {
    const chunkStart = chunkOffset;
    const chunkEnd = chunkOffset + chunk.size - 1;
    chunkOffset += chunk.size;

    if (chunkEnd < start || chunkStart > end) {
      continue;
    }

    const from = Math.max(start, chunkStart) - chunkStart;
    const to = Math.min(end, chunkEnd) - chunkStart;
    buffers.push(await fetchChunkBytes(file, chunk, from, to));
  }

  return Buffer.concat(buffers);
}

async function fetchChunkBytes(file, chunk, from, to) {
  const message = await discord.getWebhookMessage(resolveChunkWebhook(file, chunk), chunk.messageId);
  const attachment =
    message.attachments?.find((item) => item.id === chunk.attachmentId) ||
    message.attachments?.[0];

  if (!attachment?.url) {
    throw new HttpError(502, "Discord attachment URL is missing");
  }

  const response = await fetch(attachment.url, {
    headers: {
      Range: `bytes=${from}-${to}`
    }
  });

  if (!response.ok && response.status !== 206) {
    throw new HttpError(502, `Discord CDN returned ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (response.status === 206) {
    return buffer;
  }

  return buffer.subarray(from, to + 1);
}

function resolveChunkWebhook(file, chunk) {
  const data = store.snapshot();
  const user = data.users[file.ownerId];
  const webhook = {
    id: chunk.webhookId || file.webhookId || user?.webhookId,
    token: chunk.webhookToken || file.webhookToken || user?.webhookToken
  };

  if (!webhook.id || !webhook.token) {
    throw new HttpError(502, "Stored chunk webhook credentials are missing");
  }

  return webhook;
}

async function ensureUserSpace(user) {
  requireConfig(["discordBotToken", "discordGuildId"]);
  const data = store.snapshot();
  const stored = data.users[user.id];
  if (stored?.channelId && stored?.webhookId && stored?.webhookToken) {
    return stored;
  }

  let channel = stored?.channelId ? { id: stored.channelId } : null;
  if (!channel) {
    channel = await discord.createUserChannel({
      id: user.id,
      username: user.username,
      global_name: user.globalName
    });

    await store.update((current) => {
      const existing = current.users[user.id] || user;
      current.users[user.id] = {
        ...existing,
        channelId: channel.id,
        storageChannelCreatedAt: new Date().toISOString()
      };
    });
  }

  const webhook = await discord.createWebhook(channel.id);

  return store.update((current) => {
    const existing = current.users[user.id] || user;
    current.users[user.id] = {
      ...existing,
      channelId: channel.id,
      webhookId: webhook.id,
      webhookToken: webhook.token,
      storageReadyAt: new Date().toISOString()
    };
    return structuredClone(current.users[user.id]);
  });
}

function getSession(req) {
  const packed = parseCookies(req)[config.sessionCookieName];
  const sessionId = unpackSignedValue(packed, config.sessionSecret);
  if (!sessionId) {
    return null;
  }

  const session = store.snapshot().sessions[sessionId];
  if (!session || session.expiresAt < Date.now()) {
    return null;
  }

  return session;
}

function requireAuth(req) {
  const session = getSession(req);
  if (!session) {
    throw new HttpError(401, "Authentication required");
  }

  const user = store.snapshot().users[session.userId];
  if (!user) {
    throw new HttpError(401, "User session is invalid");
  }
  if (user.disabled) {
    throw new HttpError(403, "Account is disabled");
  }

  return { session, user };
}

function requireAdmin(req) {
  const auth = requireAuth(req);
  if (!isAdminUser(auth.user)) {
    throw new HttpError(403, "Admin access required");
  }
  return auth;
}

function getOwnedFile(userId, fileId) {
  const file = store.snapshot().files[fileId];
  if (!file || file.ownerId !== userId || file.status === "deleted") {
    throw new HttpError(404, "File not found");
  }
  return file;
}

function assertComplete(file) {
  if (file.status !== "complete") {
    throw new HttpError(409, "File upload is not complete");
  }
}

function orderedChunks(file) {
  return Object.values(file.chunks || {}).sort((a, b) => a.index - b.index);
}

function publicUser(user) {
  const role = accountRole(user);
  return {
    id: user.id,
    username: user.username,
    globalName: user.globalName || "",
    avatar: user.avatar || "",
    role,
    isAdmin: role === "admin",
    disabled: Boolean(user.disabled)
  };
}

function publicAccount(user, stats = {}) {
  return {
    ...publicUser(user),
    createdAt: user.createdAt || "",
    updatedAt: user.updatedAt || "",
    lastLoginAt: user.lastLoginAt || "",
    fileCount: stats.fileCount || 0,
    storageBytes: stats.storageBytes || 0,
    activeSessions: stats.activeSessions || 0
  };
}

function userStats(data) {
  const stats = new Map();
  for (const userId of Object.keys(data.users || {})) {
    stats.set(userId, { fileCount: 0, storageBytes: 0, activeSessions: 0 });
  }

  for (const file of Object.values(data.files || {})) {
    if (!file.ownerId || file.status === "deleted") {
      continue;
    }
    const stat = stats.get(file.ownerId) || { fileCount: 0, storageBytes: 0, activeSessions: 0 };
    stat.fileCount += 1;
    stat.storageBytes += Number(file.size) || 0;
    stats.set(file.ownerId, stat);
  }

  const now = Date.now();
  for (const session of Object.values(data.sessions || {})) {
    if (!session.userId || session.expiresAt < now) {
      continue;
    }
    const stat = stats.get(session.userId) || { fileCount: 0, storageBytes: 0, activeSessions: 0 };
    stat.activeSessions += 1;
    stats.set(session.userId, stat);
  }

  return stats;
}

function normalizeRole(role) {
  if (role === "admin" || role === "user") {
    return role;
  }
  throw new HttpError(400, "Invalid role");
}

function accountRole(user) {
  return user?.role === "admin" ? "admin" : "user";
}

function isAdminUser(user) {
  return accountRole(user) === "admin";
}

function accountTimestamp(user) {
  return Date.parse(user?.createdAt || user?.lastLoginAt || user?.updatedAt || "") || 0;
}

function publicFile(file) {
  const uploadedChunks = Object.keys(file.chunks || {}).length;
  return {
    id: file.id,
    name: file.name,
    size: file.size,
    type: file.type,
    chunkSize: file.chunkSize,
    chunkCount: file.chunkCount,
    uploadedChunks,
    progress: file.chunkCount === 0 ? 1 : uploadedChunks / file.chunkCount,
    status: file.status,
    favorite: Boolean(file.favorite),
    createdAt: file.createdAt,
    updatedAt: file.updatedAt
  };
}

async function staticFile(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    throw new HttpError(405, "Method not allowed");
  }

  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = safeJoin(config.publicDir, decodeURIComponent(requested));
  const exists = await fileExists(filePath);
  const finalPath = exists ? filePath : path.join(config.publicDir, "index.html");
  const body = await fs.readFile(finalPath);

  res.writeHead(200, {
    "Content-Type": publicFileType(finalPath),
    "Content-Length": body.length,
    "Cache-Control": finalPath.endsWith("index.html") ? "no-store" : "public, max-age=3600"
  });
  if (req.method === "HEAD") {
    res.end();
  } else {
    res.end(body);
  }
}

function sendNoContentWithCookie(res, cookie) {
  res.writeHead(204, {
    "Set-Cookie": cookie
  });
  res.end();
}

async function ensureAccountAdmin() {
  const users = Object.values(store.snapshot().users || {});
  if (users.length === 0) {
    return;
  }

  const needsRole = users.some((user) => !user.role);
  const hasAdmin = users.some(isAdminUser);
  if (!needsRole && hasAdmin) {
    return;
  }

  await store.update((data) => {
    const accounts = Object.values(data.users || {});
    for (const user of accounts) {
      if (!user.role) {
        user.role = "user";
      }
    }

    if (!accounts.some(isAdminUser)) {
      accounts.sort((a, b) => accountTimestamp(a) - accountTimestamp(b));
      accounts[0].role = "admin";
    }
  });
}

function cleanupExpiredSessions() {
  store
    .update((data) => {
      const now = Date.now();
      for (const [id, session] of Object.entries(data.sessions)) {
        if (session.expiresAt < now) {
          delete data.sessions[id];
        }
      }
    })
    .catch((error) => {
      console.error("Failed to clean sessions", error);
    });
}

function handleError(_req, res, error) {
  if (res.headersSent) {
    res.destroy(error);
    return;
  }

  if (error instanceof HttpError) {
    return sendJson(res, error.status, { error: error.message });
  }

  if (error instanceof DiscordApiError) {
    console.error(error.message, error.details);
    return sendJson(res, 502, {
      error: "Discord API request failed",
      details: error.details ? safeDiscordDetails(error.details) : undefined
    });
  }

  console.error(error);
  sendJson(res, 500, { error: "Internal server error" });
}

function safeDiscordDetails(details) {
  return String(details).slice(0, 800);
}
