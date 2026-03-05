// tokenStore.js
import fs from "fs";
import path from "path";

/**
 * Supports:
 * - createTokenStore({ file: ".data/figma-token.json" })
 * - createTokenStore({ dir: ".data", filename: "figma-token.json" })
 */
export function createTokenStore(opts = {}) {
  const dir = opts.dir || ".data";
  const filename = opts.filename || "figma-token.json";

  const filePathRaw =
    typeof opts.file === "string" && opts.file.trim().length > 0
      ? opts.file.trim()
      : path.join(dir, filename);

  const filepath = path.resolve(filePathRaw);
  const parentDir = path.dirname(filepath);

  function ensureDir() {
    if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
  }

  return {
    load() {
      try {
        if (!fs.existsSync(filepath)) return null;
        const raw = fs.readFileSync(filepath, "utf8");
        if (!raw) return null;
        return JSON.parse(raw);
      } catch (e) {
        console.error("[tokenStore.load] failed:", e);
        return null;
      }
    },

    save(token) {
      try {
        ensureDir();
        fs.writeFileSync(filepath, JSON.stringify(token, null, 2), "utf8");
        return { ok: true, filepath };
      } catch (e) {
        console.error("[tokenStore.save] failed:", e);
        return { ok: false, error: e?.message || String(e) };
      }
    },
  };
}