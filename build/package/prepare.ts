import { resolveLivekit } from './livekit.ts';
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { extractLockedMember, materialize } from "../download/artifacts.ts";
import { cargoArtifactExecutable, cargoRenderedDiagnostic, cargoTargetDirectory, parseCargoMessage } from "../lib/cargo.ts";
import { ashPackageBuildPath } from "../lib/paths.ts";
import { packageInputDigest, recordPackageInputs, reusablePackage } from "./inputs.ts";
import { developmentAshPackagePath, developmentHostTarget } from "./store.ts";
import { assemblePackage, type RemoteRuntimeRelease, type ResolvedExecutable, type ResolvedNode, type ResolvedBubblewrap, type FirstPartyExecutables } from "./layout.ts";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const cargoWorkspace = repositoryRoot;
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
  return new Error("Usage: node build/package/prepare.ts [--javascript-runtime host-provided-node|packaged-node] [--remote-runtime-bundle <bundle-directory>] [--remote-runtime-catalog-url <https-catalog.json> --remote-runtime-catalog-sha256 <digest>]");
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
  return selectExecutableArtifact(lock, target, "ripgrep");
}

export function selectTgrepArtifact(lock: RuntimeLock, target: string): ResolvedArchiveArtifact {
  return selectExecutableArtifact(lock, target, "tgrep");
}

function selectExecutableArtifact(lock: RuntimeLock, target: string, runtime: "ripgrep" | "tgrep"): ResolvedArchiveArtifact {
  if (lock.schemaVersion !== 1 || lock.runtime !== runtime) {
    throw new Error(`Unsupported ${runtime} runtime lock`);
  }
  const artifactKey = lock.packageTargets?.[target];
  const artifact = artifactKey ? lock.artifacts?.[artifactKey] : undefined;
  if (!artifactKey || !artifact) {
    throw new Error(`No locked ${runtime} artifact for ${target}`);
  }
  for (const field of ["archive", "sha256", "format", "executable"] as const) {
    if (typeof artifact[field] !== "string" || artifact[field].length === 0) {
      throw new Error(`Invalid ${runtime} artifact field ${field} for ${target}`);
    }
  }
  if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0) {
    throw new Error(`Invalid ${runtime} artifact size for ${target}`);
  }
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error(`Invalid ${runtime} SHA-256`);
  if (!["tar.gz", "zip"].includes(artifact.format)) throw new Error(`Invalid ${runtime} archive format`);
  const repository = lock.source?.repository;
  const release = lock.source?.release;
  if (typeof repository !== "string" || typeof release !== "string") {
    throw new Error(`${runtime} lock is missing its upstream release`);
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

async function materializeArchive(artifact: ResolvedArchiveArtifact, cacheDirectory: string): Promise<string> {
  return materialize(artifact, join(cacheDirectory, artifact.archive), artifact.size);
}

async function resolveExecutable(runtime: "ripgrep" | "tgrep", target: string, isWindows: boolean): Promise<ResolvedExecutable> {
  const lock = JSON.parse(await readFile(join(repositoryRoot, "third_party", runtime, "runtime-lock.json"), "utf8")) as RuntimeLock;
  const artifact = selectExecutableArtifact(lock, target, runtime);
  const cacheDirectory = join(repositoryRoot, "third_party", ".cache", runtime, artifact.version, artifact.key);
  const archive = await materializeArchive(artifact, cacheDirectory);
  const executable = join(cacheDirectory, (runtime === "ripgrep" ? "rg" : "tgrep") + (isWindows ? ".exe" : ""));
  const binarySha256 = await extractLockedMember(archive, artifact.sha256, artifact.executable, executable, archiveBufferLimit);
  if (!isWindows) await chmod(executable, 0o755);
  return {
    archive: artifact.archive,
    archiveSha256: artifact.sha256,
    binarySha256,
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
  const binarySha256 = await extractLockedMember(archive, artifact.sha256, artifact.executable, executable, archiveBufferLimit);
  await extractLockedMember(archive, artifact.sha256, artifact.license, license, archiveBufferLimit);
  if (!isWindows) await chmod(executable, 0o755);
  return {
    archive: artifact.archive,
    archiveSha256: artifact.sha256,
    binarySha256,
    executable,
    license,
    source: "upstream-release",
    version: artifact.version,
  };
}

async function materializeV8File(file: ResolvedV8File, cacheDirectory: string): Promise<string> {
  return materialize(file, join(cacheDirectory, file.name), archiveBufferLimit);
}

async function v8CargoEnvironment(target: string, environment: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  if (/^(1|true|yes)$/iu.test(environment.V8_FROM_SOURCE ?? "")) return { ...environment };
  const archiveOverride = environment.RUSTY_V8_ARCHIVE;
  const bindingOverride = environment.RUSTY_V8_SRC_BINDING_PATH;
  if (archiveOverride && bindingOverride) return { ...environment };
  if (archiveOverride || bindingOverride) {
    throw new Error("RUSTY_V8_ARCHIVE and RUSTY_V8_SRC_BINDING_PATH must be set together");
  }
  if (environment.RUSTY_V8_MIRROR) return { ...environment };
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

async function cargoBuild(binaryArgs: readonly string[], expectedTargets: readonly string[], environment: NodeJS.ProcessEnv = process.env): Promise<Map<string, string>> {
  const child = spawn("cargo", [
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
    env: environment,
    stdio: ["inherit", "pipe", "inherit"],
    windowsHide: true,
  });
  const executables = new Map<string, string>();
  const messages = createInterface({ input: child.stdout, crlfDelay: Infinity });
  messages.on("line", (line) => {
    const message = parseCargoMessage(line);
    const diagnostic = cargoRenderedDiagnostic(message);
    if (diagnostic) process.stderr.write(diagnostic);
    for (const targetName of expectedTargets) {
      const executable = cargoArtifactExecutable(message, targetName);
      if (executable) executables.set(targetName, executable);
    }
  });
  try {
    await new Promise<void>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (code === 0) resolvePromise();
        else reject(new Error(signal ? `cargo stopped by ${signal}` : `cargo exited with status ${code}`));
      });
    });
  } finally {
    messages.close();
  }
  for (const targetName of expectedTargets) {
    if (!executables.has(targetName)) throw new Error(`Cargo did not report the ${targetName} executable`);
  }
  return executables;
}

async function buildFirstPartyExecutables(platform: NodeJS.Platform): Promise<FirstPartyExecutables> {
  const cargoEnvironment = await v8CargoEnvironment(developmentHostTarget(platform));
  const binaryArgs = [
    "--bin", "ash-package-store",
    "--bin", "ash-app-server",
    "--bin", "ash-remote",
    "--bin", "ash-remote-server",
    "--bin", "ash-exec-server",
    "--bin", "ash-app-server-daemon",
    "--bin", "ash-code-mode-host",
    "--bin", "ash-voice-host",
    "--bin", "ash-collaboration-server",
    "--features", "ash-voice-host/host",
  ];
  const expectedTargets = ["ash-package-store", "ash-app-server", "ash-remote", "ash-remote-server", "ash-exec-server", "ash-app-server-daemon", "ash-code-mode-host", "ash-voice-host", "ash-collaboration-server"];
  if (platform === "win32") {
    binaryArgs.push("--bin", "ash-windows-sandbox");
    expectedTargets.push("ash-windows-sandbox");
  }
  if (platform === "linux") {
    binaryArgs.push("--bin", "bwrap");
    expectedTargets.push("bwrap");
  }
  const artifacts = await cargoBuild(binaryArgs, expectedTargets, cargoEnvironment);
  const livekit = await resolveLivekit(developmentHostTarget(platform));
  const executables: {
    appServerDaemon: string;
    bubblewrap?: ResolvedBubblewrap;
    packageStore: string;
    appServer: string;
    remote: string;
    remoteServer: string;
    execServer: string;
    codeModeHost: string;
    voiceHost: string;
    collaborationServer: string;
    livekit: string;
    windowsSandbox?: string;
  } = {
    appServerDaemon: requiredExecutable(artifacts, "ash-app-server-daemon"),
    codeModeHost: requiredExecutable(artifacts, "ash-code-mode-host"),
    voiceHost: requiredExecutable(artifacts, "ash-voice-host"),
    collaborationServer: requiredExecutable(artifacts, "ash-collaboration-server"),
    livekit: livekit.executable,
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

function isPublishedPackage(value: unknown): value is { readonly packageRoot: string; readonly sequence: number } {
  return typeof value === "object" && value !== null
    && "packageRoot" in value && typeof value.packageRoot === "string"
    && "sequence" in value && typeof value.sequence === "number" && Number.isSafeInteger(value.sequence) && value.sequence > 0;
}

export async function prepareDevelopmentPackage(
  javascriptRuntime: JavaScriptRuntimeKind = "host-provided-node",
  remoteRuntimeBundle?: string,
  remoteRuntimeRelease?: RemoteRuntimeRelease,
): Promise<void> {
  if (!javascriptRuntimeKinds.has(javascriptRuntime)) {
    throw new Error(`Unsupported JavaScript runtime package mode: ${javascriptRuntime}`);
  }
  const protocol = JSON.parse(await readFile(join(repositoryRoot, "ash-rs/app-server-protocol/schema/metadata.json"), "utf8"));
  if (!protocol || !Number.isSafeInteger(protocol.major) || protocol.major < 0
    || !Number.isSafeInteger(protocol.revision) || protocol.revision < 0
    || typeof protocol.schemaHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(protocol.schemaHash)) {
    throw new Error("Generated App Server protocol metadata is invalid");
  }
  const target = developmentHostTarget();
  const isWindows = process.platform === "win32";
  const outputDirectory = ashPackageBuildPath(repositoryRoot, "dev", "store-v1", target, javascriptRuntime, developmentBuildProfile);
  const executables = await buildFirstPartyExecutables(process.platform);
  const ripgrep = await resolveExecutable("ripgrep", target, isWindows);
  const tgrep = await resolveExecutable("tgrep", target, isWindows);
  const node = javascriptRuntime === "packaged-node" ? await resolveNode(target, isWindows) : undefined;
  const layout = JSON.parse(await readFile(join(repositoryRoot, "build/package/layout.json"), "utf8")) as {
    readonly licenses: readonly { readonly source: string }[];
  };
  const packageSources = (await readdir(join(repositoryRoot, "build/package")))
    .filter(name => name === "layout.json" || name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map(name => join(repositoryRoot, "build/package", name));
  const inputPaths = [
    ...packageSources,
    join(repositoryRoot, "build/download/artifacts.ts"),
    join(repositoryRoot, "build/lib/cargo.ts"),
    join(repositoryRoot, "build/lib/paths.ts"),
    join(repositoryRoot, "Cargo.toml"),
    join(repositoryRoot, "ash-rs/app-server-protocol/schema/metadata.json"),
    join(repositoryRoot, "ash-rs/skills/assets"),
    join(repositoryRoot, "extensions"),
    join(repositoryRoot, "resources/product-services"),
    ...layout.licenses.map(license => join(repositoryRoot, license.source)),
    ...Object.values(executables).filter((value): value is string => typeof value === "string"),
    ripgrep.executable,
    tgrep.executable,
    ...(node ? [node.executable, node.license] : []),
    ...(isWindows ? [join(repositoryRoot, "ash-rs/windows-sandbox/LICENSE-APACHE"), join(repositoryRoot, "ash-rs/windows-sandbox/NOTICE")] : []),
    ...(process.platform === "linux" ? [join(repositoryRoot, "ash-rs/vendor/bubblewrap"), executables.bubblewrap!.binary] : []),
    ...(remoteRuntimeBundle ? [remoteRuntimeBundle] : []),
  ];
  const digest = await packageInputDigest(inputPaths, { javascriptRuntime, target, protocol, ripgrep, tgrep, node, remoteRuntimeRelease });
  const cachePath = join(outputDirectory, "prepare-inputs.json");
  const existing = await reusablePackage(cachePath, digest, () => developmentAshPackagePath(repositoryRoot, javascriptRuntime));
  if (existing) {
    console.log(`Reused Ash development package (${javascriptRuntime}) at ${existing}`);
    return;
  }
  const packageRoot = await publishDevelopmentPackage(outputDirectory, executables.packageStore, (staging) => assemblePackage(
    staging,
    target,
    process.platform,
    protocol,
    executables,
    ripgrep,
    tgrep,
    node,
    remoteRuntimeBundle,
    remoteRuntimeRelease,
  ));
  await recordPackageInputs(cachePath, digest, packageRoot);
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
