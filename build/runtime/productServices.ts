import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

const maximumFileBytes = 1024 * 1024;

/** Checks the complete packaged trust bundle; the Rust owner validates endpoints and signatures. */
export async function validateProductServices(directory: string): Promise<void> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Package product services must be a regular directory");
  }
  await requireRootFile(directory, "product-services.json");
  const document = JSON.parse(await readFile(join(directory, "product-services.json"), "utf8"));
  if (document === null || typeof document !== "object" || document.schemaVersion !== 2 || !Array.isArray(document.marketplaces)) {
    throw new Error("Package product services configuration is invalid");
  }
  const names = new Set<string>();
  for (const source of document.marketplaces) {
    if (source === null || typeof source !== "object" || typeof source.name !== "string" ||
        source.name.length === 0 || source.name.length > 128 || /[^A-Za-z0-9_-]/u.test(source.name) || names.has(source.name)) {
      throw new Error("Package Marketplace names must be valid and unique");
    }
    names.add(source.name);
    if (source.name === "ash" && source.trustedRoot !== "marketplace-root.json") {
      throw new Error("Package product services does not pin the Ash Marketplace root");
    }
    await requireRootFile(directory, source.trustedRoot);
  }
  if (!names.has("ash")) {
    throw new Error("Package product services does not pin the Ash Marketplace root");
  }
}

async function requireRootFile(directory: string, relative: unknown): Promise<void> {
  if (typeof relative !== "string" || /[\\:]/.test(relative)) {
    throw new Error("Package trust root must be a contained relative file");
  }
  const segments = relative.split("/");
  if (segments.some(segment => segment === "" || segment === "." || segment === "..")) {
    throw new Error("Package trust root must be a contained relative file");
  }
  let path = directory;
  for (let index = 0; index < segments.length; index++) {
    path = join(path, segments[index]);
    const metadata = await lstat(path);
    const last = index === segments.length - 1;
    if (metadata.isSymbolicLink() || (last
      ? !metadata.isFile() || metadata.size === 0 || metadata.size > maximumFileBytes
      : !metadata.isDirectory())) {
      throw new Error("Package trust root must be a bounded regular file inside product services");
    }
  }
}
