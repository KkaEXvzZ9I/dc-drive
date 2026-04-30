import { Blob } from "node:buffer";
import { sanitizeChannelName, sleep } from "./util.mjs";

const PERMISSIONS = {
  MANAGE_CHANNELS: 1n << 4n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MANAGE_WEBHOOKS: 1n << 29n
};

export class DiscordApiError extends Error {
  constructor(status, message, details = "") {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export class DiscordClient {
  constructor(config) {
    this.config = config;
    this.webhookQueues = new Map();
    this.botUser = null;
  }

  async exchangeCode(code) {
    const body = new URLSearchParams({
      client_id: this.config.discordClientId,
      client_secret: this.config.discordClientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: this.config.discordRedirectUri
    });

    return this.request("/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body,
      auth: "none"
    });
  }

  async getOAuthUser(accessToken) {
    return this.request("/users/@me", {
      auth: "bearer",
      bearerToken: accessToken
    });
  }

  async getCurrentBotUser() {
    if (!this.botUser) {
      this.botUser = await this.request("/users/@me", { auth: "bot" });
    }
    return this.botUser;
  }

  async createUserChannel(user) {
    const botUser = await this.getCurrentBotUser();
    const allowBot =
      PERMISSIONS.VIEW_CHANNEL |
      PERMISSIONS.SEND_MESSAGES |
      PERMISSIONS.ATTACH_FILES |
      PERMISSIONS.READ_MESSAGE_HISTORY |
      PERMISSIONS.MANAGE_WEBHOOKS |
      PERMISSIONS.MANAGE_CHANNELS;

    const payload = {
      name: sanitizeChannelName(user.global_name || user.username, user.id),
      type: 0,
      topic: `Discord Drive storage for ${user.id}`,
      permission_overwrites: [
        {
          id: this.config.discordGuildId,
          type: 0,
          deny: PERMISSIONS.VIEW_CHANNEL.toString()
        },
        {
          id: botUser.id,
          type: 1,
          allow: allowBot.toString()
        }
      ]
    };

    if (this.config.discordCategoryId) {
      payload.parent_id = this.config.discordCategoryId;
    }

    return this.request(`/guilds/${this.config.discordGuildId}/channels`, {
      method: "POST",
      body: JSON.stringify(payload),
      auditReason: `Discord Drive storage channel for ${user.id}`
    });
  }

  async createWebhook(channelId) {
    return this.request(`/channels/${channelId}/webhooks`, {
      method: "POST",
      body: JSON.stringify({
        name: "Drive Uploader"
      }),
      auditReason: "Discord Drive chunk uploader"
    });
  }

  async uploadChunk(webhook, payload) {
    const queueKey = `${webhook.id}:${webhook.token}`;
    const previous = this.webhookQueues.get(queueKey) || Promise.resolve();
    const next = previous.then(() => this.uploadChunkNow(webhook, payload));
    this.webhookQueues.set(
      queueKey,
      next.finally(() => {
        if (this.webhookQueues.get(queueKey) === next) {
          this.webhookQueues.delete(queueKey);
        }
      })
    );
    return next;
  }

  async uploadChunkNow(webhook, { buffer, fileName, content, description }) {
    return this.request(`/webhooks/${webhook.id}/${webhook.token}?wait=true`, {
      method: "POST",
      bodyFactory: () => {
        const form = new FormData();
        form.append(
          "payload_json",
          JSON.stringify({
            content,
            allowed_mentions: { parse: [] },
            attachments: [
              {
                id: 0,
                filename: fileName,
                description
              }
            ]
          })
        );
        form.append("files[0]", new Blob([buffer]), fileName);
        return form;
      },
      auth: "none"
    });
  }

  async getMessage(channelId, messageId) {
    return this.request(`/channels/${channelId}/messages/${messageId}`, {
      auth: "bot"
    });
  }

  async getWebhookMessage(webhook, messageId) {
    return this.request(`/webhooks/${webhook.id}/${webhook.token}/messages/${messageId}`, {
      auth: "none"
    });
  }

  async deleteWebhookMessage(webhook, messageId) {
    return this.request(`/webhooks/${webhook.id}/${webhook.token}/messages/${messageId}`, {
      method: "DELETE",
      auth: "none",
      emptyOk: true
    });
  }

  async request(path, options = {}) {
    const {
      method = "GET",
      body,
      bodyFactory,
      headers = {},
      auth = "bot",
      bearerToken,
      auditReason,
      emptyOk = false
    } = options;
    const url = path.startsWith("http") ? path : `${this.config.discordApiBase}${path}`;
    const requestHeaders = { ...headers };

    if (auth === "bot") {
      requestHeaders.Authorization = `Bot ${this.config.discordBotToken}`;
      requestHeaders["Content-Type"] = requestHeaders["Content-Type"] || "application/json";
    } else if (auth === "bearer") {
      requestHeaders.Authorization = `Bearer ${bearerToken}`;
    }

    if (auditReason) {
      requestHeaders["X-Audit-Log-Reason"] = encodeURIComponent(auditReason);
    }

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await fetch(url, {
        method,
        headers: requestHeaders,
        body: bodyFactory ? bodyFactory() : body
      });

      if (response.status === 429) {
        const retryMs = await retryAfterMs(response);
        await sleep(retryMs);
        continue;
      }

      const remaining = Number(response.headers.get("x-ratelimit-remaining"));
      const resetAfter = Number(response.headers.get("x-ratelimit-reset-after"));
      if (Number.isFinite(remaining) && remaining <= 0 && Number.isFinite(resetAfter) && resetAfter > 0) {
        await sleep(Math.ceil(resetAfter * 1000));
      }

      if (response.status === 204 && emptyOk) {
        return null;
      }

      const text = await response.text();
      if (!response.ok) {
        throw new DiscordApiError(
          response.status,
          `Discord API ${method} ${path} failed with ${response.status}`,
          text
        );
      }

      if (!text) {
        return null;
      }

      return JSON.parse(text);
    }

    throw new DiscordApiError(429, `Discord API ${method} ${path} kept rate limiting`);
  }
}

async function retryAfterMs(response) {
  const retryHeader = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryHeader)) {
    return Math.ceil(retryHeader * 1000);
  }

  try {
    const json = await response.json();
    if (Number.isFinite(json.retry_after)) {
      return Math.ceil(json.retry_after * 1000);
    }
  } catch {
    // Keep the fallback below.
  }

  return 1500;
}
