import { lstat, readdir, rm, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
await removeOutputRoot(join(repositoryRoot, ".build"));
for (const directory of ["build", "scripts"]) {
  await removePythonCaches(join(repositoryRoot, directory));
}
console.log("Removed local build outputs.");

async function removePythonCaches(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === "node_modules" || entry.name === ".venv") continue;
    const path = join(directory, entry.name);
    if (entry.name === "__pycache__") await removeOutputRoot(path);
    else await removePythonCaches(path);
  }
}

async function removeOutputRoot(root: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(root);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    await unlink(root);
    return;
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) await unlink(join(root, entry.name));
  }
  await rm(root, { force: true, recursive: true });
}
