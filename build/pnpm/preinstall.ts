import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { parsePackageManagerSpec, validatePackageManager } from "./packageManager.ts";
import { requireNode25 } from "../lib/requireNode25.ts";

interface RootPackageManifest {
  packageManager?: string;
}

const repositoryRoot = resolve(import.meta.dirname, "../..");
requireNode25();
const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as RootPackageManifest;
if (!manifest.packageManager) {
  throw new Error("Root package.json must declare packageManager.");
}
validatePackageManager(process.env.npm_config_user_agent, parsePackageManagerSpec(manifest.packageManager));
