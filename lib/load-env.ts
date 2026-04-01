/**
 * Next loads `.env*` from `process.cwd()`; we also call `loadEnvConfig` from the repo root,
 * then re-read OPENROUTER_API_KEY from `.env` / `.env.local` on disk if still unset.
 *
 * We resolve the repo root by walking up from `process.cwd()` (no `import.meta.url` — it can
 * break in some Next server bundles).
 */
import fs from "fs";
import path from "path";
import { loadEnvConfig } from "@next/env";

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 12; i++) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { name?: string };
        if (pkg.name === "arbiter") return dir;
      } catch {
        // ignore invalid package.json
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const projectRoot = findRepoRoot();

loadEnvConfig(projectRoot, true, console, true);

const ENV_KEYS_FROM_DISK = [
  "OPENROUTER_API_KEY",
  "GOOGLE_CSE_API_KEY",
  "GOOGLE_CSE_CX",
  "EBAY_APP_ID",
] as const;

function extractEnvLine(raw: string, key: (typeof ENV_KEYS_FROM_DISK)[number]): string {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = raw.match(new RegExp(`^\\s*${esc}=(.*)$`, "m"));
  if (!m) return "";
  return m[1].trim().replace(/^["']|["']$/g, "");
}

try {
  for (const rel of [".env", ".env.local"] as const) {
    const envPath = path.join(projectRoot, rel);
    if (!fs.existsSync(envPath)) continue;
    const raw = fs.readFileSync(envPath, "utf8");
    for (const key of ENV_KEYS_FROM_DISK) {
      if (!process.env[key]) {
        const v = extractEnvLine(raw, key);
        if (v.length > 0) process.env[key] = v;
      }
    }
  }
} catch {
  // ignore
}
