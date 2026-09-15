import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

interface RootPackageManifest {
  packageManager?: string;
}

const repositoryRoot = resolve(import.meta.dirname, "../..");
const requiredVersion = (await readFile(join(repositoryRoot, ".nvmrc"), "utf8")).trim();
if (process.versions.node.split(".")[0] !== requiredVersion.split(".")[0]) {
  throw new Error(`Ash requires the Node major version specified in .nvmrc (${requiredVersion}); found ${process.version}.`);
}
const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as RootPackageManifest;
if (!manifest.packageManager) {
  throw new Error("Root package.json must declare packageManager.");
}
const separator = manifest.packageManager.lastIndexOf("@");
if (separator <= 0 || separator === manifest.packageManager.length - 1) {
  throw new Error(`Invalid packageManager value: ${manifest.packageManager}`);
}
const name = manifest.packageManager.slice(0, separator);
const version = manifest.packageManager.slice(separator + 1);
const actual = process.env.npm_config_user_agent?.split(" ", 1)[0];
if (actual !== `${name}/${version}`) {
  throw new Error(`Use ${name}@${version}; received ${actual ?? "no package manager"}. Install it with npm install -g ${name}@${version}.`);
}
