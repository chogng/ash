import { join, resolve } from "node:path";

export function buildPath(repositoryRoot: string, ...segments: readonly string[]): string {
  return join(resolve(repositoryRoot), ".build", ...segments);
}

export function appTsBuildPath(repositoryRoot: string, ...segments: readonly string[]): string {
  return buildPath(repositoryRoot, "app-ts", ...segments);
}

export function runtimeBuildPath(repositoryRoot: string, ...segments: readonly string[]): string {
  return buildPath(repositoryRoot, "runtime", ...segments);
}
