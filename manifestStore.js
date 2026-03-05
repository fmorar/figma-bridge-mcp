import fs from "fs";
import path from "path";

export function createManifestStore({ dir = ".data/manifests" } = {}) {
  const baseDir = path.resolve(process.cwd(), dir);

  function ensureDir() {
    fs.mkdirSync(baseDir, { recursive: true });
  }

  function keyPath(fileKey) {
    return path.join(baseDir, `${fileKey}.json`);
  }

  function write({ fileKey, manifest }) {
    ensureDir();
    fs.writeFileSync(keyPath(fileKey), JSON.stringify(manifest, null, 2), "utf-8");
    return { ok: true, fileKey, path: keyPath(fileKey) };
  }

  function read({ fileKey }) {
    ensureDir();
    const p = keyPath(fileKey);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  }

  return { write, read };
}