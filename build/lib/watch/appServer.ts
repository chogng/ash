import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream, type FSWatcher, watch } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { cargoArtifactExecutable, cargoRenderedDiagnostic, cargoTargetDirectory, parseCargoMessage } from "../cargo.ts";
import { desktopBuildPath } from "../paths.ts";

const desktopRoot = resolve(import.meta.dirname, "../../../ash-ts");
const repositoryRoot = resolve(desktopRoot, "..");
const sharedRustSource = join(repositoryRoot, "ash-rs");
const cargoWorkspace = join(repositoryRoot, "Cargo.toml");
const targetDirectory = cargoTargetDirectory(repositoryRoot);
const watchedTargetDirectory = relativeWatchedDirectory(sharedRustSource, targetDirectory);
const generationDirectory = desktopBuildPath(repositoryRoot, "dev", "app-server");
const generationFile = join(generationDirectory, "current.json");
const skipInitial = process.argv.includes("--skip-initial");
const debounceMs = 250;
const retainedPreviousGenerations = 1;

let activeBuild: ChildProcess | undefined;
let buildRequested = !skipInitial;
let debounce: NodeJS.Timeout | undefined;
let stopped = false;

const watchers: FSWatcher[] = [];

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void start().catch(error => {
    console.error(`[app-server] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

export function shouldRebuildAppServer(file: string | null, ignoredDirectory?: string): boolean {
  if (typeof file !== "string") return false;
  const normalized = file.replaceAll("\\", "/");
  if (/(?:^|\/)target(?:\/|$)/u.test(normalized)) return false;
  const ignored = ignoredDirectory?.replaceAll("\\", "/").replace(/\/+$/u, "");
  if (ignored !== undefined && (ignored === "" || normalized === ignored || normalized.startsWith(`${ignored}/`))) return false;
  const name = basename(file);
  return file.endsWith(".rs") || name === "Cargo.toml" || name === "Cargo.lock" || name === "build.rs";
}

export function relativeWatchedDirectory(watchRoot: string, directory: string): string | undefined {
  const candidate = relative(resolve(watchRoot), resolve(directory));
  if (isAbsolute(candidate) || candidate === ".." || candidate.startsWith(`..${sep}`)) return undefined;
  return candidate.replaceAll("\\", "/");
}

export function shouldRebuildWorkspaceManifest(file: string | null): boolean {
  return file === "Cargo.toml" || file === "Cargo.lock";
}

async function start(): Promise<void> {
  await prunePublishedGenerations();
  watchers.push(
    watch(sharedRustSource, { recursive: true }, (_event, file) => requestBuild(file, fileName => shouldRebuildAppServer(fileName, watchedTargetDirectory))),
    watch(repositoryRoot, (_event, file) => requestBuild(file, shouldRebuildWorkspaceManifest)),
  );
  console.log("[app-server] Watching Rust App Server sources");
  if (buildRequested) void drainBuilds();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

function requestBuild(file: string | null, shouldRebuild: (file: string | null) => boolean): void {
  if (stopped || !shouldRebuild(file)) return;
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    buildRequested = true;
    void drainBuilds();
  }, debounceMs);
}

async function drainBuilds(): Promise<void> {
  if (activeBuild || stopped) return;
  while (buildRequested && !stopped) {
    buildRequested = false;
    try {
      await buildAndPublish();
    } catch (error) {
      console.error(`[app-server] ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function buildAndPublish(): Promise<void> {
  console.log("[app-server] Building ash-app-server");
  const source = await runCargo();
  const published = await publishAppServerGeneration(source, generationDirectory, generationFile, process.platform);
  console.log(published.changed ? `[app-server] Published ${published.generation}` : `[app-server] Unchanged ${published.generation}`);
}

function runCargo(): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    let executable: string | undefined;
    let settled = false;
    const child = spawn("cargo", [
      "build",
      "--manifest-path", cargoWorkspace,
      "--package", "ash-app-server",
      "--bin", "ash-app-server",
      "--profile", "dev-small",
      "--target-dir", targetDirectory,
      "--message-format", "json-render-diagnostics",
    ], { cwd: repositoryRoot, env: process.env, stdio: ["inherit", "pipe", "inherit"], windowsHide: true });
    activeBuild = child;
    const messages = createInterface({ input: child.stdout });
    messages.on("line", line => {
      const message = parseCargoMessage(line);
      const diagnostic = cargoRenderedDiagnostic(message);
      if (diagnostic) process.stderr.write(diagnostic);
      executable = cargoArtifactExecutable(message, "ash-app-server") ?? executable;
    });
    child.once("error", error => {
      if (settled) return;
      settled = true;
      activeBuild = undefined;
      reject(error);
    });
    child.once("close", (code, signal) => {
      activeBuild = undefined;
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error(signal ? `cargo build stopped by ${signal}` : `cargo build exited with status ${code ?? "unknown"}`));
      } else if (!executable) {
        reject(new Error("cargo build did not report the ash-app-server executable"));
      } else {
        resolvePromise(executable);
      }
    });
  });
}

export async function publishAppServerGeneration(source: string, directory: string, pointer: string, platform: NodeJS.Platform = process.platform): Promise<Readonly<{ changed: boolean; generation: string }>> {
  const digest = await sha256(source);
  const generation = platform === "win32" ? `ash-app-server.${digest}.exe` : `ash-app-server.${digest}`;
  const executable = join(directory, generation);
  await mkdir(directory, { recursive: true });
  const current = await readCurrentGeneration(pointer);
  if (current === generation && await pathExists(executable)) {
    await pruneGenerations(directory, generation);
    return { changed: false, generation };
  }
  if (!await pathExists(executable)) {
    const staging = join(directory, `.${generation}.${process.pid}.tmp`);
    try {
      await copyFile(source, staging, constants.COPYFILE_FICLONE);
      await rename(staging, executable);
    } finally {
      await unlink(staging).catch(() => {});
    }
  }
  const nextGeneration = `${pointer}.${process.pid}.tmp`;
  try {
    await writeFile(nextGeneration, `${JSON.stringify({ version: 1, executable: generation })}\n`, "utf8");
    await replaceGenerationFile(nextGeneration, pointer);
  } finally {
    await unlink(nextGeneration).catch(() => {});
  }
  await pruneGenerations(directory, generation);
  return { changed: true, generation };
}

async function prunePublishedGenerations(): Promise<void> {
  const current = await readCurrentGeneration(generationFile);
  if (!current) return;
  await pruneGenerations(generationDirectory, current);
}

async function pruneGenerations(directory: string, current: string): Promise<void> {
  if (!await pathExists(join(directory, current))) return;
  const entries = await readdir(directory, { withFileTypes: true });
  const generations = await Promise.all(entries
    .filter(entry => entry.isFile() && entry.name.startsWith("ash-app-server.") && entry.name !== current)
    .map(async entry => ({ name: entry.name, modified: (await stat(join(directory, entry.name))).mtimeMs })));
  generations.sort((left, right) => right.modified - left.modified || right.name.localeCompare(left.name));
  const retainedDigests = new Set([await generationDigest(directory, current)]);
  let retained = 0;
  for (const generation of generations) {
    const digest = await generationDigest(directory, generation.name);
    if (retainedDigests.has(digest) || retained >= retainedPreviousGenerations) {
      await unlink(join(directory, generation.name)).catch(() => {});
      continue;
    }
    retainedDigests.add(digest);
    retained += 1;
  }
}

async function generationDigest(directory: string, generation: string): Promise<string> {
  const addressed = generation.match(/^ash-app-server\.([a-f0-9]{64})(?:\.exe)?$/u)?.[1];
  return addressed ?? sha256(join(directory, generation));
}

async function readCurrentGeneration(pointer: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(pointer, "utf8"));
    const value = parsed && typeof parsed === "object" ? parsed as Readonly<Record<string, unknown>> : undefined;
    return value?.version === 1 && typeof value.executable === "string" && value.executable === basename(value.executable)
      ? value.executable
      : undefined;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    return undefined;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function sha256(path: string): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", chunk => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolvePromise(hash.digest("hex")));
  });
}

async function replaceGenerationFile(staging: string, destination: string): Promise<void> {
  try {
    await rename(staging, destination);
  } catch (error) {
    if (process.platform !== "win32" || !isReplaceError(error)) throw error;
    await unlink(destination).catch(unlinkError => {
      if (!isMissingFileError(unlinkError)) throw unlinkError;
    });
    await rename(staging, destination);
  }
}

function isReplaceError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "EEXIST" || error.code === "EPERM");
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function stop(): void {
  if (stopped) return;
  stopped = true;
  clearTimeout(debounce);
  for (const watcher of watchers) watcher.close();
  activeBuild?.kill("SIGTERM");
}
