import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cargoArtifactExecutable, cargoRenderedDiagnostic, cargoTargetDirectory, parseCargoMessage } from "../lib/cargo.ts";
import { ashPackageBuildPath } from "../lib/paths.ts";
import { developmentHostTarget } from "./store.ts";
import { validateProductServices } from "./productServices.ts";
import { APP_SERVER_PROTOCOL_MAJOR, APP_SERVER_PROTOCOL_REVISION, APP_SERVER_SCHEMA_HASH } from "../../ash-ts/generated/app-server/protocol.ts";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const cargoWorkspace = repositoryRoot;
const sharedRustSource = join(repositoryRoot, "ash-rs");
const ripgrepLockPath = join(repositoryRoot, "third_party", "ripgrep", "runtime-lock.json");
const ripgrepCacheRoot = join(repositoryRoot, "third_party", ".cache", "ripgrep");
const nodeLockPath = join(repositoryRoot, "third_party", "node", "runtime-lock.json");
const nodeCacheRoot = join(repositoryRoot, "third_party", ".cache", "node");
const bubblewrapSourceDirectory = join(repositoryRoot, "ash-rs", "vendor", "bubblewrap");
const bubblewrapMetadataPath = join(bubblewrapSourceDirectory, "ash-source.json");
const v8LockPath = join(repositoryRoot, "third_party", "v8", "runtime-lock.json");
const v8CacheRoot = join(repositoryRoot, "third_party", ".cache", "v8");
const archiveBufferLimit = 256 * 1024 * 1024;
const javascriptRuntimeKinds = new Set<JavaScriptRuntimeKind>(["host-provided-node", "packaged-node"]);
const developmentBuildProfile = "dev-small";

type JavaScriptRuntimeKind = "host-provided-node" | "packaged-node";

interface RemoteRuntimeRelease {
  readonly sha256: string;
  readonly url: string;
}

interface PackageOptions {
  readonly javascriptRuntime: JavaScriptRuntimeKind;
  readonly remoteRuntimeBundle: string | undefined;
  readonly remoteRuntimeRelease: RemoteRuntimeRelease | undefined;
}

interface LockedRuntimeArtifact {
  readonly archive: string;
  readonly executable: string;
  readonly format: string;
  readonly license?: string;
  readonly sha256: string;
  readonly size: number;
  readonly url?: string;
}

interface RuntimeLock {
  readonly artifacts?: Readonly<Record<string, LockedRuntimeArtifact>>;
  readonly packageTargets?: Readonly<Record<string, string>>;
  readonly runtime: string;
  readonly schemaVersion: number;
  readonly source?: { readonly baseUrl?: string; readonly release?: string; readonly repository?: string };
  readonly version: string;
}

interface V8LockedFile {
  readonly name: string;
  readonly sha256: string;
}

interface V8RuntimeLock {
  readonly artifacts: Readonly<Record<string, { readonly archive: V8LockedFile; readonly binding: V8LockedFile }>>;
  readonly profile: string;
  readonly runtime: string;
  readonly schemaVersion: number;
  readonly source: { readonly release: string; readonly repository: string };
  readonly version: string;
}

interface ResolvedV8File extends V8LockedFile {
  readonly url: string;
}

interface ResolvedV8ArtifactPair {
  readonly archive: ResolvedV8File;
  readonly binding: ResolvedV8File;
  readonly version: string;
}

interface ResolvedArchiveArtifact extends LockedRuntimeArtifact {
  readonly key: string;
  readonly url: string;
  readonly version: string;
}

interface ResolvedNodeArchiveArtifact extends ResolvedArchiveArtifact {
  readonly license: string;
}

interface ResolvedRipgrep {
  readonly archive: string;
  readonly archiveSha256: string;
  readonly binarySha256: string;
  readonly executable: string;
  readonly source: "upstream-release";
  readonly version: string;
}

interface ResolvedNode extends ResolvedRipgrep {
  readonly license: string;
}

interface ResolvedBubblewrap {
  readonly archive: string;
  readonly archiveSha256: string;
  readonly binary: string;
  readonly license: string;
  readonly version: string;
}

interface FirstPartyExecutables {
  readonly appServerDaemon: string;
  readonly bubblewrap?: ResolvedBubblewrap;
  readonly packageStore: string;
  readonly appServer: string;
  readonly remote: string;
  readonly remoteServer: string;
  readonly execServer: string;
  readonly codeModeHost: string;
  readonly windowsSandbox?: string;
}

interface PackageIdentityMetadata {
  readonly buildProfile: string;
  readonly components: Record<string, unknown> & { node?: unknown };
  readonly entrypoint: string;
  readonly javascriptRuntime: { readonly kind: string };
  readonly layoutVersion: number;
  readonly pathDir: string;
  readonly protocol: { readonly major: number; readonly revision: number; readonly schemaHash: string };
  readonly remoteRuntimeCatalog?: { readonly path?: string; readonly sha256: string; readonly trustBinding: string; readonly url?: string };
  readonly resourcesDir: string;
  readonly target: string;
  readonly version: string;
}

interface PackageMetadata extends PackageIdentityMetadata {
  readonly buildId: string;
  readonly files: Readonly<Record<string, string>>;
}

export function parseJavaScriptRuntime(cliArguments: readonly string[]): JavaScriptRuntimeKind {
  return parsePackageOptions(cliArguments).javascriptRuntime;
}

export function parsePackageOptions(cliArguments: readonly string[]): PackageOptions {
  let javascriptRuntime: JavaScriptRuntimeKind = "host-provided-node";
  let javascriptRuntimeSpecified = false;
  let remoteRuntimeBundle;
  let remoteRuntimeCatalogUrl;
  let remoteRuntimeCatalogSha256;
  for (let index = 0; index < cliArguments.length; index += 2) {
    const name = cliArguments[index];
    const value = cliArguments[index + 1];
    if (value === undefined) throw packageUsage();
    if (name === "--javascript-runtime" && isJavaScriptRuntimeKind(value) && !javascriptRuntimeSpecified) {
      javascriptRuntime = value;
      javascriptRuntimeSpecified = true;
    } else if (name === "--remote-runtime-bundle" && value.length > 0 && remoteRuntimeBundle === undefined) {
      remoteRuntimeBundle = resolve(value);
    } else if (name === "--remote-runtime-catalog-url" && value.length > 0 && remoteRuntimeCatalogUrl === undefined) {
      remoteRuntimeCatalogUrl = value;
    } else if (name === "--remote-runtime-catalog-sha256" && /^[a-f0-9]{64}$/.test(value) && remoteRuntimeCatalogSha256 === undefined) {
      remoteRuntimeCatalogSha256 = value;
    } else {
      throw packageUsage();
    }
  }
  if ((remoteRuntimeCatalogUrl === undefined) !== (remoteRuntimeCatalogSha256 === undefined)) throw packageUsage();
  if (remoteRuntimeCatalogUrl !== undefined) validateRemoteRuntimeCatalogUrl(remoteRuntimeCatalogUrl);
  const remoteRuntimeRelease = remoteRuntimeCatalogUrl === undefined
    ? undefined
    : { url: remoteRuntimeCatalogUrl, sha256: remoteRuntimeCatalogSha256 as string };
  return { javascriptRuntime, remoteRuntimeBundle, remoteRuntimeRelease };
}

function packageUsage(): Error {
  return new Error("Usage: node build/ash-package/prepare.ts [--javascript-runtime host-provided-node|packaged-node] [--remote-runtime-bundle <bundle-directory>] [--remote-runtime-catalog-url <https-catalog.json> --remote-runtime-catalog-sha256 <digest>]");
}

function validateRemoteRuntimeCatalogUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error("Remote runtime catalog URL is invalid", { cause: error });
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash || !url.pathname.endsWith("/catalog.json")) {
    throw new Error("Remote runtime catalog URL must be a credential-free HTTPS catalog.json URL without query or fragment");
  }
}

export function hostTarget(platform: NodeJS.Platform = process.platform, architecture: string = process.arch): string {
  return developmentHostTarget(platform, architecture);
}

export function selectV8ArtifactPair(lock: V8RuntimeLock, target: string): ResolvedV8ArtifactPair {
  if (lock.schemaVersion !== 1 || lock.runtime !== "rusty-v8" || lock.profile !== "ptrcomp_sandbox_release") {
    throw new Error("Unsupported rusty_v8 runtime lock");
  }
  const release = lock.source?.release;
  const repository = lock.source?.repository;
  let parsedRepository: URL;
  try {
    parsedRepository = new URL(repository);
  } catch (error) {
    throw new Error("rusty_v8 repository URL is invalid", { cause: error });
  }
  if (parsedRepository.protocol !== "https:" || parsedRepository.username || parsedRepository.password || parsedRepository.search || parsedRepository.hash) {
    throw new Error("rusty_v8 repository must be a credential-free HTTPS URL");
  }
  if (release !== `rusty-v8-v${lock.version}`) {
    throw new Error("rusty_v8 release does not match its locked version");
  }
  const pair = lock.artifacts?.[target];
  if (!pair) throw new Error(`No locked rusty_v8 artifacts for ${target}`);
  const windows = target.includes("windows");
  const expectedArchive = windows
    ? `rusty_v8_${lock.profile}_${target}.lib.gz`
    : `librusty_v8_${lock.profile}_${target}.a.gz`;
  const expectedBinding = `src_binding_${lock.profile}_${target}.rs`;
  const baseUrl = `${repository.replace(/\/+$/u, "")}/releases/download/${release}`;
  const resolveFile = (file: V8LockedFile, expectedName: string): ResolvedV8File => {
    if (file.name !== expectedName || !/^[a-f0-9]{64}$/u.test(file.sha256)) {
      throw new Error(`Invalid locked rusty_v8 artifact for ${target}: ${file.name}`);
    }
    return { ...file, url: `${baseUrl}/${file.name}` };
  };
  return {
    archive: resolveFile(pair.archive, expectedArchive),
    binding: resolveFile(pair.binding, expectedBinding),
    version: lock.version,
  };
}

export function selectRipgrepArtifact(lock: RuntimeLock, target: string): ResolvedArchiveArtifact {
  if (lock.schemaVersion !== 1 || lock.runtime !== "ripgrep") {
    throw new Error("Unsupported ripgrep runtime lock");
  }
  const artifactKey = lock.packageTargets?.[target];
  const artifact = artifactKey ? lock.artifacts?.[artifactKey] : undefined;
  if (!artifactKey || !artifact) {
    throw new Error(`No locked ripgrep artifact for ${target}`);
  }
  for (const field of ["archive", "sha256", "format", "executable"] as const) {
    if (typeof artifact[field] !== "string" || artifact[field].length === 0) {
      throw new Error(`Invalid ripgrep artifact field ${field} for ${target}`);
    }
  }
  if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0) {
    throw new Error(`Invalid ripgrep artifact size for ${target}`);
  }
  const repository = lock.source?.repository;
  const release = lock.source?.release;
  if (typeof repository !== "string" || typeof release !== "string") {
    throw new Error("Ripgrep lock is missing its upstream release");
  }
  return {
    ...artifact,
    key: artifactKey,
    url: artifact.url ?? `${repository.replace(/\/+$/, "")}/releases/download/${release}/${artifact.archive}`,
    version: lock.version,
  };
}

export function selectNodeArtifact(lock: RuntimeLock, target: string): ResolvedNodeArchiveArtifact {
  if (lock.schemaVersion !== 1 || lock.runtime !== "node") {
    throw new Error("Unsupported Node.js runtime lock");
  }
  const artifactKey = lock.packageTargets?.[target];
  const artifact = artifactKey ? lock.artifacts?.[artifactKey] : undefined;
  if (!artifactKey || !artifact) {
    throw new Error(`No locked Node.js artifact for ${target}`);
  }
  for (const field of ["archive", "sha256", "format", "executable", "license"] as const) {
    if (typeof artifact[field] !== "string" || artifact[field].length === 0) {
      throw new Error(`Invalid Node.js artifact field ${field} for ${target}`);
    }
  }
  if (!/^[0-9a-f]{64}$/.test(artifact.sha256)) {
    throw new Error(`Invalid Node.js artifact SHA-256 for ${target}`);
  }
  if (artifact.format !== "tar.xz" && artifact.format !== "zip") {
    throw new Error(`Unsupported Node.js archive format for ${target}: ${artifact.format}`);
  }
  if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0) {
    throw new Error(`Invalid Node.js artifact size for ${target}`);
  }
  const baseUrl = lock.source?.baseUrl;
  if (typeof baseUrl !== "string" || baseUrl.length === 0) {
    throw new Error("Node.js lock is missing its upstream release URL");
  }
  return {
    ...artifact,
    key: artifactKey,
    license: artifact.license as string,
    url: `${baseUrl.replace(/\/+$/, "")}/${artifact.archive}`,
    version: lock.version,
  };
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function verifyArchive(path: string, artifact: Pick<ResolvedArchiveArtifact, "sha256" | "size">): Promise<boolean> {
  try {
    const metadata = await stat(path);
    return metadata.isFile() && metadata.size === artifact.size && await sha256(path) === artifact.sha256;
  } catch {
    return false;
  }
}

async function downloadArchive(artifact: ResolvedArchiveArtifact, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const partial = `${destination}.partial`;
  await rm(partial, { force: true });
  const response = await fetch(artifact.url, {
    headers: { "user-agent": "ash-development-package-builder" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`Could not download ${artifact.url}: HTTP ${response.status}`);
  }
  await writeFile(partial, Buffer.from(await response.arrayBuffer()), { flag: "wx" });
  if (!await verifyArchive(partial, artifact)) {
    await rm(partial, { force: true });
    throw new Error(`Downloaded archive failed locked size or SHA-256 validation: ${artifact.archive}`);
  }
  await rm(destination, { force: true });
  await rename(partial, destination);
}

async function materializeArchive(artifact: ResolvedArchiveArtifact, cacheDirectory: string): Promise<string> {
  const archive = join(cacheDirectory, artifact.archive);
  if (!await verifyArchive(archive, artifact)) {
    await rm(archive, { force: true });
    await downloadArchive(artifact, archive);
  }
  return archive;
}

function extractArchiveMember(archive: string, member: string): Buffer {
  const result = spawnSync("tar", ["-xOf", archive, member], {
    encoding: null,
    maxBuffer: archiveBufferLimit,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`Could not run the host tar utility: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Could not extract ${member}: ${result.stderr?.toString().trim()}`);
  }
  return result.stdout;
}

async function resolveRipgrep(target: string, isWindows: boolean): Promise<ResolvedRipgrep> {
  const lock = JSON.parse(await readFile(ripgrepLockPath, "utf8")) as RuntimeLock;
  const artifact = selectRipgrepArtifact(lock, target);
  const cacheDirectory = join(ripgrepCacheRoot, artifact.version, artifact.key);
  const archive = await materializeArchive(artifact, cacheDirectory);
  const executable = join(cacheDirectory, isWindows ? "rg.exe" : "rg");
  const partial = `${executable}.partial-${randomUUID()}`;
  try {
    await writeFile(partial, extractArchiveMember(archive, artifact.executable), { flag: "wx" });
    if (!isWindows) {
      await chmod(partial, 0o755);
    }
    await rm(executable, { force: true });
    await rename(partial, executable);
  } finally {
    await rm(partial, { force: true });
  }
  return {
    archive: artifact.archive,
    archiveSha256: artifact.sha256,
    binarySha256: await sha256(executable),
    executable,
    source: "upstream-release",
    version: artifact.version,
  };
}

async function resolveNode(target: string, isWindows: boolean): Promise<ResolvedNode> {
  const lock = JSON.parse(await readFile(nodeLockPath, "utf8")) as RuntimeLock;
  const artifact = selectNodeArtifact(lock, target);
  const cacheDirectory = join(nodeCacheRoot, artifact.version, artifact.key);
  const archive = await materializeArchive(artifact, cacheDirectory);
  const executable = join(cacheDirectory, isWindows ? "node.exe" : "node");
  const license = join(cacheDirectory, "LICENSE");
  const executablePartial = `${executable}.partial-${randomUUID()}`;
  const licensePartial = `${license}.partial-${randomUUID()}`;
  try {
    await writeFile(executablePartial, extractArchiveMember(archive, artifact.executable), { flag: "wx" });
    await writeFile(licensePartial, extractArchiveMember(archive, artifact.license), { flag: "wx" });
    if (!isWindows) {
      await chmod(executablePartial, 0o755);
    }
    await rm(executable, { force: true });
    await rename(executablePartial, executable);
    await rm(license, { force: true });
    await rename(licensePartial, license);
  } finally {
    await rm(executablePartial, { force: true });
    await rm(licensePartial, { force: true });
  }
  return {
    archive: artifact.archive,
    archiveSha256: artifact.sha256,
    binarySha256: await sha256(executable),
    executable,
    license,
    source: "upstream-release",
    version: artifact.version,
  };
}

async function materializeV8File(file: ResolvedV8File, cacheDirectory: string): Promise<string> {
  const destination = join(cacheDirectory, file.name);
  if (await pathExists(destination) && await sha256(destination) === file.sha256) return destination;
  await mkdir(cacheDirectory, { recursive: true });
  const partial = `${destination}.partial-${randomUUID()}`;
  try {
    const response = await fetch(file.url, {
      headers: { "user-agent": "ash-development-package-builder" },
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`Could not download ${file.url}: HTTP ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength > archiveBufferLimit) {
      throw new Error(`rusty_v8 artifact exceeds the download limit: ${file.name}`);
    }
    await writeFile(partial, body, { flag: "wx" });
    if (await sha256(partial) !== file.sha256) {
      throw new Error(`Downloaded rusty_v8 artifact failed SHA-256 validation: ${file.name}`);
    }
    await rm(destination, { force: true });
    await rename(partial, destination);
    return destination;
  } finally {
    await rm(partial, { force: true });
  }
}

async function v8CargoEnvironment(target: string, environment: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  if (/^(1|true|yes)$/iu.test(environment.V8_FROM_SOURCE ?? "")) return { ...environment };
  const archiveOverride = environment.RUSTY_V8_ARCHIVE;
  const bindingOverride = environment.RUSTY_V8_SRC_BINDING_PATH;
  if (archiveOverride && bindingOverride) return { ...environment };
  if (archiveOverride || bindingOverride) {
    throw new Error("RUSTY_V8_ARCHIVE and RUSTY_V8_SRC_BINDING_PATH must be set together");
  }
  const lock = JSON.parse(await readFile(v8LockPath, "utf8")) as V8RuntimeLock;
  const pair = selectV8ArtifactPair(lock, target);
  const cacheDirectory = join(v8CacheRoot, `v${pair.version}`);
  await Promise.all([
    materializeV8File(pair.archive, cacheDirectory),
    materializeV8File(pair.binding, cacheDirectory),
  ]);
  return {
    ...environment,
    RUSTY_V8_MIRROR: v8CacheRoot,
  };
}

function cargoBuild(binaryArgs: readonly string[], expectedTargets: readonly string[], environment: NodeJS.ProcessEnv = process.env): Map<string, string> {
  const result = spawnSync("cargo", [
    "build",
    "--workspace",
    "--manifest-path",
    join(cargoWorkspace, "Cargo.toml"),
    ...binaryArgs,
    "--profile",
    "dev-small",
    "--target-dir",
    cargoTargetDirectory(cargoWorkspace, environment),
    "--message-format",
    "json-render-diagnostics",
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: environment,
    maxBuffer: archiveBufferLimit,
    stdio: ["inherit", "pipe", "pipe"],
    windowsHide: true,
  });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  const executables = new Map<string, string>();
  for (const line of result.stdout?.split(/\r?\n/u) ?? []) {
    const message = parseCargoMessage(line);
    const diagnostic = cargoRenderedDiagnostic(message);
    if (diagnostic) process.stderr.write(diagnostic);
    for (const targetName of expectedTargets) {
      const executable = cargoArtifactExecutable(message, targetName);
      if (executable) executables.set(targetName, executable);
    }
  }
  if (result.status !== 0) throw new Error(`cargo exited with status ${result.status}`);
  for (const targetName of expectedTargets) {
    if (!executables.has(targetName)) throw new Error(`Cargo did not report the ${targetName} executable`);
  }
  return executables;
}

async function buildFirstPartyExecutables(platform: NodeJS.Platform): Promise<FirstPartyExecutables> {
  const cargoEnvironment = await v8CargoEnvironment(hostTarget(platform));
  const binaryArgs = [
    "--bin", "ash-package-store",
    "--bin", "ash-app-server",
    "--bin", "ash-remote",
    "--bin", "ash-remote-server",
    "--bin", "ash-exec-server",
    "--bin", "ash-app-server-daemon",
    "--bin", "ash-code-mode-host",
  ];
  const expectedTargets = ["ash-package-store", "ash-app-server", "ash-remote", "ash-remote-server", "ash-exec-server", "ash-app-server-daemon", "ash-code-mode-host"];
  if (platform === "win32") {
    binaryArgs.push("--bin", "ash-windows-sandbox");
    expectedTargets.push("ash-windows-sandbox");
  }
  if (platform === "linux") {
    binaryArgs.push("--bin", "bwrap");
    expectedTargets.push("bwrap");
  }
  const artifacts = cargoBuild(binaryArgs, expectedTargets, cargoEnvironment);
  const executables: {
    appServerDaemon: string;
    bubblewrap?: ResolvedBubblewrap;
    packageStore: string;
    appServer: string;
    remote: string;
    remoteServer: string;
    execServer: string;
    codeModeHost: string;
    windowsSandbox?: string;
  } = {
    appServerDaemon: requiredExecutable(artifacts, "ash-app-server-daemon"),
    codeModeHost: requiredExecutable(artifacts, "ash-code-mode-host"),
    packageStore: requiredExecutable(artifacts, "ash-package-store"),
    appServer: requiredExecutable(artifacts, "ash-app-server"),
    remote: requiredExecutable(artifacts, "ash-remote"),
    remoteServer: requiredExecutable(artifacts, "ash-remote-server"),
    execServer: requiredExecutable(artifacts, "ash-exec-server"),
  };
  if (platform === "win32") {
    executables.windowsSandbox = requiredExecutable(artifacts, "ash-windows-sandbox");
  }
  if (platform === "linux") {
    const bubblewrap = await resolveVendoredBubblewrapSource();
    executables.bubblewrap = {
      ...bubblewrap,
      binary: requiredExecutable(artifacts, "bwrap"),
    };
  }
  for (const path of Object.values(executables).filter((value) => typeof value === "string")) {
    const metadata = await stat(path);
    if (!metadata.isFile()) {
      throw new Error(`Cargo did not produce an expected executable: ${path}`);
    }
  }
  return executables;
}

function isJavaScriptRuntimeKind(value: string): value is JavaScriptRuntimeKind {
  return javascriptRuntimeKinds.has(value as JavaScriptRuntimeKind);
}

function requiredExecutable(executables: ReadonlyMap<string, string>, name: string): string {
  const executable = executables.get(name);
  if (!executable) throw new Error(`Cargo did not report the ${name} executable`);
  return executable;
}

async function resolveVendoredBubblewrapSource(): Promise<Omit<ResolvedBubblewrap, "binary">> {
  const metadata = JSON.parse(await readFile(bubblewrapMetadataPath, "utf8")) as {
    readonly archive: { readonly name: string; readonly sha256: string };
    readonly name: string;
    readonly schemaVersion: number;
    readonly version: string;
  };
  if (metadata.schemaVersion !== 1 || metadata.name !== "bubblewrap") {
    throw new Error("Unsupported vendored Bubblewrap metadata");
  }
  if (!/^[a-f0-9]{64}$/u.test(metadata.archive.sha256)) {
    throw new Error("Invalid vendored Bubblewrap archive SHA-256");
  }
  for (const name of ["COPYING", "bind-mount.c", "bind-mount.h", "bubblewrap.c", "network.c", "network.h", "utils.c", "utils.h"]) {
    const sourceMetadata = await stat(join(bubblewrapSourceDirectory, name));
    if (!sourceMetadata.isFile()) {
      throw new Error(`Vendored Bubblewrap source is not a file: ${name}`);
    }
  }
  return {
    archive: metadata.archive.name,
    archiveSha256: metadata.archive.sha256,
    license: join(bubblewrapSourceDirectory, "COPYING"),
    version: metadata.version,
  };
}

async function copyExecutable(source: string, destination: string, isWindows: boolean): Promise<void> {
  await copyFile(source, destination, constants.COPYFILE_FICLONE);
  if (!isWindows) {
    await chmod(destination, 0o755);
  }
}

async function copyRegularTree(source: string, destination: string, kind: string): Promise<void> {
  const sourceMetadata = await lstat(source);
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
    throw new Error(`Built-in ${kind} source is not a real directory: ${source}`);
  }
  await mkdir(destination);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    const metadata = await lstat(sourcePath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Built-in ${kind} asset is a symbolic link: ${sourcePath}`);
    }
    if (metadata.isDirectory()) {
      await copyRegularTree(sourcePath, destinationPath, kind);
    } else if (metadata.isFile() && metadata.nlink === 1) {
      await copyFile(sourcePath, destinationPath);
    } else {
      throw new Error(`Built-in ${kind} asset is not a regular unlinked file: ${sourcePath}`);
    }
  }
}

async function copyBuiltinSkills(destination: string): Promise<void> {
  const source = join(sharedRustSource, "skills", "assets");
  const entries = (await readdir(source, { withFileTypes: true })).filter((entry) => entry.name !== "BUILD.bazel");
  if (entries.length === 0) {
    throw new Error("Built-in Skill source is empty");
  }
  await mkdir(destination, { recursive: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)) {
      throw new Error(`Invalid built-in Skill directory: ${entry.name}`);
    }
    await stat(join(source, entry.name, "SKILL.md"));
    await copyRegularTree(join(source, entry.name), join(destination, entry.name), "Skill");
  }
}

export async function copyBuiltinExtensions(destination: string, source = join(repositoryRoot, "extensions")): Promise<void> {
  const sourceMetadata = await lstat(source);
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
    throw new Error(`Built-in extension source is not a real directory: ${source}`);
  }
  const entries = (await readdir(source, { withFileTypes: true })).filter(
    (entry) => entry.name !== "README.md" && entry.name !== "BUILD.bazel",
  );
  if (entries.length === 0) {
    throw new Error("Built-in extension source is empty");
  }
  await mkdir(destination, { recursive: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      throw new Error(`Invalid built-in extension package: ${entry.name}`);
    }
    const manifest = join(source, entry.name, "package.json");
    let manifestMetadata;
    try {
      manifestMetadata = await lstat(manifest);
    } catch (error: unknown) {
      if (isErrorCode(error, "ENOENT")) throw new Error(`Built-in extension is missing package.json: ${entry.name}`, { cause: error });
      throw error;
    }
    if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()) {
      throw new Error(`Built-in extension package.json is not a regular file: ${entry.name}`);
    }
    await copyRegularTree(join(source, entry.name), join(destination, entry.name), "extension package");
  }
}

async function workspaceVersion(): Promise<string> {
  const manifest = await readFile(join(repositoryRoot, "Cargo.toml"), "utf8");
  const workspacePackage = manifest.match(/\[workspace\.package\]([\s\S]*?)(?:\n\[|$)/)?.[1];
  const version = workspacePackage?.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];
  if (!version) {
    throw new Error("Could not read workspace.package.version");
  }
  return version;
}

export async function assemblePackage(
  staging: string,
  target: string,
  platform: NodeJS.Platform,
  executables: FirstPartyExecutables,
  ripgrep: ResolvedRipgrep,
  node?: ResolvedNode,
  remoteRuntimeBundle?: string,
  remoteRuntimeRelease?: RemoteRuntimeRelease,
): Promise<void> {
  const isWindows = platform === "win32";
  const appServerDaemonName = isWindows ? "ash-app-server-daemon.exe" : "ash-app-server-daemon";
  const codeModeHostName = isWindows ? "ash-code-mode-host.exe" : "ash-code-mode-host";
  const appServerName = isWindows ? "ash-app-server.exe" : "ash-app-server";
  const rgName = isWindows ? "rg.exe" : "rg";
  const binDirectory = join(staging, "bin");
  const pathDirectory = join(staging, "ash-path");
  const resourcesDirectory = join(staging, "ash-resources");
  const ripgrepLicenseDirectory = join(resourcesDirectory, "licenses", "ripgrep");
  const vscodeLicenseDirectory = join(resourcesDirectory, "licenses", "vscode");
  await mkdir(binDirectory, { recursive: true });
  await mkdir(pathDirectory, { recursive: true });
  await mkdir(ripgrepLicenseDirectory, { recursive: true });
  await mkdir(vscodeLicenseDirectory, { recursive: true });
  await copyBuiltinSkills(join(resourcesDirectory, "skills"));
  await copyBuiltinExtensions(join(resourcesDirectory, "extensions"));
  await copyRegularTree(join(repositoryRoot, "resources", "product-services"), join(resourcesDirectory, "product-services"), "product services");
  if (remoteRuntimeBundle) {
    await copyRegularTree(remoteRuntimeBundle, join(staging, "ash-remote-runtimes"), "Remote runtime bundle");
  }
  await copyExecutable(executables.appServer, join(binDirectory, appServerName), isWindows);
  await copyExecutable(executables.remote, join(binDirectory, isWindows ? "ash-remote.exe" : "ash-remote"), isWindows);
  await copyExecutable(executables.remoteServer, join(binDirectory, isWindows ? "ash-remote-server.exe" : "ash-remote-server"), isWindows);
  await copyExecutable(executables.execServer, join(binDirectory, isWindows ? "ash-exec-server.exe" : "ash-exec-server"), isWindows);
  await copyExecutable(executables.appServerDaemon, join(binDirectory, appServerDaemonName), isWindows);
  await copyExecutable(executables.codeModeHost, join(binDirectory, codeModeHostName), isWindows);
  if (isWindows) {
    await copyExecutable(requiredPath(executables.windowsSandbox, "Windows sandbox executable"), join(binDirectory, "ash-windows-sandbox.exe"), true);
    const licenses = join(resourcesDirectory, "licenses", "windows-sandbox");
    await mkdir(licenses, { recursive: true });
    for (const name of ["LICENSE-APACHE", "NOTICE"]) {
      await copyFile(join(sharedRustSource, "windows-sandbox", name), join(licenses, name));
    }
  }
  await copyExecutable(ripgrep.executable, join(pathDirectory, rgName), isWindows);
  if (node) {
    const nodeDirectory = join(resourcesDirectory, "node", "bin");
    const nodeLicenseDirectory = join(resourcesDirectory, "licenses", "node");
    await mkdir(nodeDirectory, { recursive: true });
    await mkdir(nodeLicenseDirectory, { recursive: true });
    await copyExecutable(node.executable, join(nodeDirectory, isWindows ? "node.exe" : "node"), isWindows);
    await copyFile(node.license, join(nodeLicenseDirectory, "LICENSE"));
  }
  for (const name of ["LICENSE-MIT", "UNLICENSE"]) {
    await copyFile(join(repositoryRoot, "third_party", "ripgrep", name), join(ripgrepLicenseDirectory, name));
  }
  await copyFile(join(repositoryRoot, "third_party", "vscode", "LICENSE.txt"), join(vscodeLicenseDirectory, "LICENSE.txt"));
  const mxcLicenseDirectory = join(resourcesDirectory, "licenses", "mxc");
  await mkdir(mxcLicenseDirectory, { recursive: true });
  await copyFile(join(sharedRustSource, "vendor", "mxc", "LICENSE.md"), join(mxcLicenseDirectory, "LICENSE.md"));

  const components: Record<string, unknown> & { node?: unknown } = {
    appServerDaemon: {
      binarySha256: await sha256(join(binDirectory, appServerDaemonName)),
      source: "cargo-build",
    },
    codeModeHost: {
      binarySha256: await sha256(join(binDirectory, codeModeHostName)),
      source: "cargo-build",
    },
    ripgrep: {
      archive: ripgrep.archive,
      archiveSha256: ripgrep.archiveSha256,
      binarySha256: ripgrep.binarySha256,
      source: ripgrep.source,
      version: ripgrep.version,
    },
    remote: { binarySha256: await sha256(join(binDirectory, isWindows ? "ash-remote.exe" : "ash-remote")), source: "cargo-build" },
    remoteServer: { binarySha256: await sha256(join(binDirectory, isWindows ? "ash-remote-server.exe" : "ash-remote-server")), source: "cargo-build" },
    execServer: { binarySha256: await sha256(join(binDirectory, isWindows ? "ash-exec-server.exe" : "ash-exec-server")), source: "cargo-build" },
    appServer: {
      binarySha256: await sha256(join(binDirectory, appServerName)),
      source: "cargo-build",
    },
  };
  if (isWindows) {
    components.windowsSandbox = { source: "cargo-build", binarySha256: await sha256(join(binDirectory, "ash-windows-sandbox.exe")) };
  }
  if (node) {
    components.node = {
      archive: node.archive,
      archiveSha256: node.archiveSha256,
      binarySha256: node.binarySha256,
      source: node.source,
      version: node.version,
    };
  }
  if (platform === "linux") {
    const bubblewrap = executables.bubblewrap;
    if (!bubblewrap) throw new Error("Linux package is missing the Bubblewrap build");
    await copyExecutable(bubblewrap.binary, join(resourcesDirectory, "bwrap"), false);
    const licenseDirectory = join(resourcesDirectory, "licenses", "bubblewrap");
    await mkdir(licenseDirectory, { recursive: true });
    await copyFile(bubblewrap.license, join(licenseDirectory, "COPYING"));
    components.bubblewrap = {
      binarySha256: await sha256(bubblewrap.binary),
      source: "vendored-source-build",
      sourceArchive: bubblewrap.archive,
      sourceArchiveSha256: bubblewrap.archiveSha256,
      version: bubblewrap.version,
    };
  }
  const version = await workspaceVersion();
  const protocol = {
    major: APP_SERVER_PROTOCOL_MAJOR,
    revision: APP_SERVER_PROTOCOL_REVISION,
    schemaHash: APP_SERVER_SCHEMA_HASH,
  };
  const runtimeKind = node ? "packagedNode" : "hostProvidedNode";
  let remoteRuntimeCatalog: PackageIdentityMetadata["remoteRuntimeCatalog"];
  if (remoteRuntimeBundle || remoteRuntimeRelease) {
    const packagedCatalogSha256 = remoteRuntimeBundle ? await sha256(join(staging, "ash-remote-runtimes", "catalog.json")) : undefined;
    if (remoteRuntimeRelease && packagedCatalogSha256 && remoteRuntimeRelease.sha256 !== packagedCatalogSha256) throw new Error("Network Remote runtime catalog SHA-256 does not match the packaged catalog");
    remoteRuntimeCatalog = remoteRuntimeRelease
      ? { url: remoteRuntimeRelease.url, sha256: remoteRuntimeRelease.sha256, trustBinding: "signedProductPackage" }
      : { path: "ash-remote-runtimes/catalog.json", sha256: packagedCatalogSha256 as string, trustBinding: "signedProductPackage" };
  }
  const identity: PackageIdentityMetadata = {
    buildProfile: developmentBuildProfile,
    components,
    entrypoint: `bin/${appServerName}`,
    javascriptRuntime: { kind: runtimeKind },
    layoutVersion: 2,
    pathDir: "ash-path",
    protocol,
    ...(remoteRuntimeCatalog ? { remoteRuntimeCatalog } : {}),
    resourcesDir: "ash-resources",
    target,
    version,
  };
  const files = await packageFiles(staging);
  const metadata: PackageMetadata = { ...identity, buildId: packageBuildId(identity, files), files };
  await writeFile(join(staging, "ash-package.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  await validatePackage(staging, platform);
}

function requiredPath(path: string | undefined, description: string): string {
  if (!path) throw new Error(`${description} is missing`);
  return path;
}

async function requireFile(path: string): Promise<void> {
  const metadata = await stat(path);
  if (!metadata.isFile()) {
    throw new Error(`Missing package file: ${path}`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function validatePackage(packageRoot: string, platform: NodeJS.Platform): Promise<void> {
  const isWindows = platform === "win32";
  const metadataPath = join(packageRoot, "ash-package.json");
  await requireFile(metadataPath);
  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as PackageMetadata;
  if (metadata.layoutVersion !== 2 || typeof metadata.components !== "object" || metadata.components === null) {
    throw new Error("Invalid package metadata");
  }
  await requireFile(join(packageRoot, "bin", isWindows ? "ash-app-server.exe" : "ash-app-server"));
  await requireComponentDigest(metadata, "remote", join(packageRoot, "bin", isWindows ? "ash-remote.exe" : "ash-remote"));
  await requireComponentDigest(metadata, "remoteServer", join(packageRoot, "bin", isWindows ? "ash-remote-server.exe" : "ash-remote-server"));
  await requireComponentDigest(metadata, "execServer", join(packageRoot, "bin", isWindows ? "ash-exec-server.exe" : "ash-exec-server"));
  await requireFile(join(packageRoot, "bin", isWindows ? "ash-app-server-daemon.exe" : "ash-app-server-daemon"));
  await requireFile(join(packageRoot, "bin", isWindows ? "ash-code-mode-host.exe" : "ash-code-mode-host"));
  await requireComponentDigest(metadata, "appServer", join(packageRoot, "bin", isWindows ? "ash-app-server.exe" : "ash-app-server"));
  await requireComponentDigest(metadata, "appServerDaemon", join(packageRoot, "bin", isWindows ? "ash-app-server-daemon.exe" : "ash-app-server-daemon"));
  await requireComponentDigest(metadata, "codeModeHost", join(packageRoot, "bin", isWindows ? "ash-code-mode-host.exe" : "ash-code-mode-host"));
  if (isWindows) {
    await requireComponentDigest(metadata, "windowsSandbox", join(packageRoot, "bin", "ash-windows-sandbox.exe"));
    for (const name of ["LICENSE-APACHE", "NOTICE"]) {
      await requireFile(join(packageRoot, "ash-resources", "licenses", "windows-sandbox", name));
    }
  }
  const files = await packageFiles(packageRoot);
  if (JSON.stringify(metadata.files) !== JSON.stringify(files)) {
    throw new Error("Package file manifest does not match its contents");
  }
  const { buildId: _buildId, files: _files, ...identity } = metadata;
  if (metadata.buildId !== packageBuildId(identity, files)) {
    throw new Error("Package build identity does not match its complete file manifest");
  }
  await requireFile(join(packageRoot, "ash-path", isWindows ? "rg.exe" : "rg"));
  if (metadata.javascriptRuntime?.kind === "packagedNode") {
    if (typeof metadata.components.node !== "object" || metadata.components.node === null) {
      throw new Error("Packaged Node runtime metadata is missing");
    }
    await requireFile(join(packageRoot, "ash-resources", "node", "bin", isWindows ? "node.exe" : "node"));
    await requireFile(join(packageRoot, "ash-resources", "licenses", "node", "LICENSE"));
  } else if (metadata.javascriptRuntime?.kind === "hostProvidedNode") {
    if (metadata.components.node !== undefined) {
      throw new Error("Host-provided runtime package contains Node metadata");
    }
    if (await pathExists(join(packageRoot, "ash-resources", "node")) || await pathExists(join(packageRoot, "ash-resources", "licenses", "node"))) {
      throw new Error("Host-provided runtime package contains a standalone Node payload");
    }
  } else {
    throw new Error("Invalid package JavaScript runtime declaration");
  }
  await requireFile(join(packageRoot, "ash-resources", "licenses", "ripgrep", "LICENSE-MIT"));
  await requireFile(join(packageRoot, "ash-resources", "licenses", "ripgrep", "UNLICENSE"));
  await requireFile(join(packageRoot, "ash-resources", "licenses", "vscode", "LICENSE.txt"));
  await requireFile(join(packageRoot, "ash-resources", "licenses", "mxc", "LICENSE.md"));
  await validateProductServices(join(packageRoot, "ash-resources", "product-services"));
  if (platform === "linux") {
    await requireFile(join(packageRoot, "ash-resources", "bwrap"));
    await requireFile(join(packageRoot, "ash-resources", "licenses", "bubblewrap", "COPYING"));
  }
  const extensionEntries = await readdir(join(packageRoot, "ash-resources", "extensions"), { withFileTypes: true });
  if (extensionEntries.length === 0) {
    throw new Error("Package contains no built-in extensions");
  }
  for (const extensionEntry of extensionEntries) {
    if (!extensionEntry.isDirectory()) {
      throw new Error(`Package contains an invalid built-in extension entry: ${extensionEntry.name}`);
    }
    await requireFile(join(packageRoot, "ash-resources", "extensions", extensionEntry.name, "package.json"));
  }
  const skillNames = await readdir(join(packageRoot, "ash-resources", "skills"));
  if (skillNames.length === 0) {
    throw new Error("Package contains no built-in Skills");
  }
  for (const skillName of skillNames) {
    await requireFile(join(packageRoot, "ash-resources", "skills", skillName, "SKILL.md"));
  }
  if (metadata.remoteRuntimeCatalog !== undefined) {
    if (metadata.remoteRuntimeCatalog.trustBinding !== "signedProductPackage" || !/^[a-f0-9]{64}$/.test(metadata.remoteRuntimeCatalog.sha256)) {
      throw new Error("Invalid Remote runtime catalog package binding");
    }
    if (metadata.remoteRuntimeCatalog.path === "ash-remote-runtimes/catalog.json" && metadata.remoteRuntimeCatalog.url === undefined) {
      const catalog = JSON.parse(await readFile(join(packageRoot, "ash-remote-runtimes", "catalog.json"), "utf8"));
      if (catalog.formatVersion !== 1 || !Array.isArray(catalog.artifacts) || catalog.artifacts.length === 0) throw new Error("Invalid packaged Remote runtime catalog");
    } else if (metadata.remoteRuntimeCatalog.path === undefined && typeof metadata.remoteRuntimeCatalog.url === "string") {
      validateRemoteRuntimeCatalogUrl(metadata.remoteRuntimeCatalog.url);
    } else {
      throw new Error("Invalid Remote runtime catalog package source");
    }
  }
}

async function publishDevelopmentPackage(output: string, publisher: string, build: (staging: string) => Promise<void>): Promise<string> {
  await mkdir(output, { recursive: true });
  const staging = join(output, `.next-${randomUUID()}`);
  await rm(staging, { force: true, recursive: true });
  try {
    await build(staging);
    const result = spawnSync(publisher, ["publish", "--root", output, "--staging", staging], {
      cwd: repositoryRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`ash-package-store exited with status ${result.status}`);
    const published: unknown = JSON.parse(result.stdout);
    if (!isPublishedPackage(published)) throw new Error("ash-package-store returned an invalid publication result");
    return resolve(published.packageRoot);
  } finally {
    await rm(staging, { force: true, recursive: true }).catch(() => {});
  }
}

async function regularFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Development package contains a symbolic path: ${path}`);
    if (entry.isDirectory()) files.push(...await regularFiles(path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Development package contains an unsupported file type: ${path}`);
  }
  return files.sort();
}

async function packageFiles(packageRoot: string): Promise<Readonly<Record<string, string>>> {
  const files: Record<string, string> = {};
  for (const path of await regularFiles(packageRoot)) {
    const relative = path.slice(packageRoot.length + 1).replaceAll("\\", "/");
    if (relative !== "ash-package.json" && relative !== ".lease") files[relative] = await sha256(path);
  }
  return files;
}

function isPublishedPackage(value: unknown): value is { readonly packageRoot: string; readonly sequence: number } {
  return typeof value === "object" && value !== null
    && "packageRoot" in value && typeof value.packageRoot === "string"
    && "sequence" in value && Number.isSafeInteger(value.sequence) && value.sequence > 0;
}

export async function prepareDevelopmentPackage(
  javascriptRuntime: JavaScriptRuntimeKind = "host-provided-node",
  remoteRuntimeBundle?: string,
  remoteRuntimeRelease?: RemoteRuntimeRelease,
): Promise<void> {
  if (!javascriptRuntimeKinds.has(javascriptRuntime)) {
    throw new Error(`Unsupported JavaScript runtime package mode: ${javascriptRuntime}`);
  }
  const target = hostTarget();
  const isWindows = process.platform === "win32";
  const outputDirectory = ashPackageBuildPath(repositoryRoot, "dev", "store-v1", target, javascriptRuntime, developmentBuildProfile);
  const executables = await buildFirstPartyExecutables(process.platform);
  const ripgrep = await resolveRipgrep(target, isWindows);
  const node = javascriptRuntime === "packaged-node" ? await resolveNode(target, isWindows) : undefined;
  const packageRoot = await publishDevelopmentPackage(outputDirectory, executables.packageStore, (staging) => assemblePackage(
    staging,
    target,
    process.platform,
    executables,
    ripgrep,
    node,
    remoteRuntimeBundle,
    remoteRuntimeRelease,
  ));
  console.log(`Prepared Ash development package (${javascriptRuntime}) at ${packageRoot}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const options = parsePackageOptions(process.argv.slice(2));
  prepareDevelopmentPackage(options.javascriptRuntime, options.remoteRuntimeBundle, options.remoteRuntimeRelease).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

async function requireComponentDigest(metadata: PackageMetadata, name: string, path: string): Promise<void> {
  const component = metadata.components[name];
  if (typeof component !== "object" || component === null || !("binarySha256" in component)) {
    throw new Error(`Package component metadata is missing: ${name}`);
  }
  const expected = (component as { readonly binarySha256?: unknown }).binarySha256;
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected) || await sha256(path) !== expected) {
    throw new Error(`Package component digest does not match: ${name}`);
  }
}

function packageBuildId(identity: PackageIdentityMetadata, files: Readonly<Record<string, string>>): string {
  const digest = createHash("sha256");
  digest.update("ash-package-build-v2\0");
  digest.update(canonicalJson(identity));
  digest.update("\0");
  for (const [path, fileDigest] of Object.entries(files).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    digest.update(path);
    digest.update("\0");
    digest.update(fileDigest);
    digest.update("\0");
  }
  return `sha256:${digest.digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new Error("Package identity metadata contains a non-JSON value");
  return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
