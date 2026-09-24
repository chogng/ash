import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runtimeBuildPath } from "./paths.ts";

type DevelopmentJavaScriptRuntime = "host-provided-node" | "packaged-node";

export function developmentAshPackagePath(
  repositoryRoot: string,
  runtime: DevelopmentJavaScriptRuntime = "host-provided-node",
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): string {
  const developmentRoot = runtimeBuildPath(repositoryRoot, "dev", "store-v1", developmentHostTarget(platform, architecture), runtime, "dev-small");
  const manifestDirectory = join(developmentRoot, "manifests");
  const manifestName = readdirSync(manifestDirectory).filter(isPackageManifestName).sort().at(-1);
  if (!manifestName) throw new Error(`Ash development package has no published manifest: ${manifestDirectory}`);
  const manifestPath = join(manifestDirectory, manifestName);
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!isPackageManifest(manifest, Number(manifestName.slice(0, 20)))) throw new Error(`Invalid Ash development package manifest: ${manifestPath}`);
  return join(developmentRoot, ...manifest.directory.split("/"));
}

export function developmentHostTarget(platform: NodeJS.Platform = process.platform, architecture: string = process.arch): string {
  const targets: Readonly<Record<string, string>> = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-arm64": "aarch64-unknown-linux-gnu",
    "linux-x64": "x86_64-unknown-linux-gnu",
    "win32-arm64": "aarch64-pc-windows-msvc",
    "win32-x64": "x86_64-pc-windows-msvc",
  };
  const target = targets[`${platform}-${architecture}`];
  if (!target) throw new Error(`Unsupported Ash development host: ${platform}/${architecture}`);
  return target;
}

function isPackageManifestName(value: string): boolean {
  return /^\d{20}\.json$/u.test(value);
}

function isPackageManifest(value: unknown, sequence: number): value is { readonly formatVersion: 1; readonly sequence: number; readonly directory: string } {
  return typeof value === "object"
    && value !== null
    && "formatVersion" in value
    && value.formatVersion === 1
    && "sequence" in value
    && value.sequence === sequence
    && "directory" in value
    && typeof value.directory === "string"
    && /^packages\/[0-9A-Za-z][0-9A-Za-z.+-]*\/[a-f0-9]{64}$/u.test(value.directory);
}
