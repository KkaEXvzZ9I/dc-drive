import fs from "node:fs/promises";
import path from "node:path";

function freshData() {
  return {
    version: 1,
    users: {},
    sessions: {},
    files: {}
  };
}

export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = freshData();
    this.queue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.data = {
        ...freshData(),
        ...parsed,
        users: parsed.users || {},
        sessions: parsed.sessions || {},
        files: parsed.files || {}
      };
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      await this.save();
    }
  }

  snapshot() {
    return structuredClone(this.data);
  }

  async update(mutator) {
    const next = this.queue.then(async () => {
      const result = await mutator(this.data);
      await this.save();
      return result;
    });

    this.queue = next.catch(() => {});
    return next;
  }

  async save() {
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
    try {
      await fs.rename(tmpPath, this.filePath);
    } catch (error) {
      if (error.code !== "EPERM" && error.code !== "EACCES") {
        throw error;
      }

      await fs.copyFile(tmpPath, this.filePath);
      await fs.unlink(tmpPath).catch(() => {});
    }
  }
}
