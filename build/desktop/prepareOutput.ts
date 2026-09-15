import { lstat, mkdir, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { desktopBuildPath } from "../lib/paths.ts";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const desktopNodeModules = join(repositoryRoot, "ash-ts", "node_modules");
const outputRoot = desktopBuildPath(repositoryRoot);
const outputNodeModules = join(outputRoot, "node_modules");

await mkdir(outputRoot, { recursive: true });
await writeFile(join(outputRoot, "package.json"), "{\n  \"private\": true,\n  \"type\": \"module\"\n}\n");
await ensureDirectoryLink(outputNodeModules, desktopNodeModules);

async function ensureDirectoryLink(link: string, target: string): Promise<void> {
  const expected = await realpath(target);
  try {
    const metadata = await lstat(link);
    if (!metadata.isSymbolicLink()) {
      throw new Error(`Desktop build dependency path is not the expected directory link: ${link}`);
    }
    try {
      if (await realpath(link) === expected) return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await unlink(link);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await symlink(expected, link, process.platform === "win32" ? "junction" : "dir");
}
