import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function loadDotEnv(filePath = path.join(ROOT, ".env")) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equalIndex = trimmed.indexOf("=");
    if (equalIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, equalIndex).trim();
    let value = trimmed.slice(equalIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!Object.prototype.hasOwnProperty.call(process.env, key)) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  root: ROOT,
  port: numberFromEnv("PORT", 8787),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "http://localhost:8787",
  discordApiBase: process.env.DISCORD_API_BASE || "https://discord.com/api/v10",
  discordClientId: process.env.DISCORD_CLIENT_ID || "",
  discordClientSecret: process.env.DISCORD_CLIENT_SECRET || "",
  discordRedirectUri:
    process.env.DISCORD_REDIRECT_URI || "http://localhost:8787/auth/callback",
  discordBotToken: process.env.DISCORD_BOT_TOKEN || "",
  discordGuildId: process.env.DISCORD_GUILD_ID || "",
  discordCategoryId: process.env.DISCORD_CATEGORY_ID || "",
  sessionSecret: process.env.SESSION_SECRET || "dev-only-change-me",
  sessionCookieName: "dd_session",
  oauthStateCookieName: "dd_oauth_state",
  sessionMaxAgeSeconds: numberFromEnv("SESSION_MAX_AGE_SECONDS", 60 * 60 * 24 * 14),
  chunkSizeBytes: numberFromEnv("CHUNK_SIZE_BYTES", 8 * 1024 * 1024),
  dataDir: path.resolve(ROOT, process.env.DATA_DIR || "./data"),
  publicDir: path.resolve(ROOT, "public")
};

export function requireConfig(keys) {
  const missing = keys.filter((key) => !config[key]);
  if (missing.length > 0) {
    const names = missing.map((key) => key.replace(/[A-Z]/g, (m) => `_${m}`).toUpperCase());
    throw new Error(`Missing required environment variables: ${names.join(", ")}`);
  }
}
