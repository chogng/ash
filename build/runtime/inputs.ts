import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, readlink, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function packageInputDigest(paths: readonly string[], settings: unknown): Promise<string> {
  const entries: unknown[] = [];
  for (const path of [...new Set(paths)].sort()) await collect(path);
  return createHash("sha256").update(JSON.stringify({ settings, entries })).digest("hex");

  async function collect(path: string): Promise<void> {
    const metadata = await lstat(path, { bigint: true });
    entries.push([path, metadata.mode.toString(), metadata.size.toString(), metadata.mtimeNs.toString()]);
    if (metadata.isSymbolicLink()) {
      entries.push(await readlink(path));
    } else if (metadata.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await collect(join(path, name));
    }
  }
}

export async function reusablePackage(cachePath: string, digest: string, currentPackage: () => string): Promise<string | undefined> {
  let cached: unknown;
  try {
    cached = JSON.parse(await readFile(cachePath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  if (!cached || typeof cached !== "object" || !("digest" in cached) || cached.digest !== digest
    || !("packageRoot" in cached) || typeof cached.packageRoot !== "string") return undefined;
  try {
    if (currentPackage() !== cached.packageRoot || !(await stat(join(cached.packageRoot, "ash-package.json"))).isFile()) return undefined;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    if (error instanceof Error && error.message.includes("Ash development package has no published manifest:")) return undefined;
    throw error;
  }
  return cached.packageRoot;
}

export async function recordPackageInputs(cachePath: string, digest: string, packageRoot: string): Promise<void> {
  const partial = `${cachePath}.partial-${randomUUID()}`;
  try {
    await writeFile(partial, JSON.stringify({ digest, packageRoot }));
    await rename(partial, cachePath);
  } finally {
    await rm(partial, { force: true });
  }
}
