import { lstat, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
for (const directory of [".build", "target", "dist", "__pycache__", ".pytest_cache", ".ruff_cache", "test/integration/browser/dist"]) {
	await rm(join(repositoryRoot, directory), { force: true, recursive: true });
}
// Dependency directories can link to shared stores; only clean caches in a local directory.
const dependencies = join(repositoryRoot, "node_modules");
const dependencyMetadata = await lstat(dependencies).catch(error => {
	if (error?.code === "ENOENT") return undefined;
	throw error;
});
if (dependencyMetadata?.isDirectory() && !dependencyMetadata.isSymbolicLink()) {
	for (const directory of [".vite", ".vite-temp"]) {
		await rm(join(dependencies, directory), { force: true, recursive: true });
	}
}
for (const directory of ["build", "scripts"]) {
	await removePythonCaches(join(repositoryRoot, directory));
}
console.log("Removed local build outputs.");

async function removePythonCaches(directory: string): Promise<void> {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === "node_modules" || entry.name === ".venv") continue;
		const path = join(directory, entry.name);
		if (["__pycache__", ".pytest_cache", ".ruff_cache"].includes(entry.name)) await rm(path, { force: true, recursive: true });
		else await removePythonCaches(path);
	}
}
