
import fs from "fs";
import path from "path";

export function createTokenStore({ filePath }) {
  const fullPath = path.resolve(filePath);

  function ensureDir() {
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  function load() {
    try {
      if (!fs.existsSync(fullPath)) return null;
      return JSON.parse(fs.readFileSync(fullPath, "utf-8"));
    } catch {
      return null;
    }
  }

  function save(data) {
    ensureDir();
    fs.writeFileSync(fullPath, JSON.stringify(data, null, 2));
  }

  function clear() {
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  }

  return { load, save, clear, fullPath };
}
