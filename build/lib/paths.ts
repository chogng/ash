import { join, resolve } from "node:path";

export function buildPath(repositoryRoot: string, ...segments: readonly string[]): string {
  return join(resolve(repositoryRoot), ".build", ...segments);
}

export function desktopBuildPath(repositoryRoot: string, ...segments: readonly string[]): string {
  return buildPath(repositoryRoot, "desktop", ...segments);
}

export function ashPackageBuildPath(repositoryRoot: string, ...segments: readonly string[]): string {
  return buildPath(repositoryRoot, "ash-package", ...segments);
}
