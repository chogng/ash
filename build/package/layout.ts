import { createHash } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../download/artifacts.ts";
import { validateProductServices } from "./productServices.ts";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const layout = JSON.parse(readFileSync(new URL("./layout.json", import.meta.url), "utf8")) as {
  readonly layoutVersion: number;
  readonly entrypoint: string;
  readonly pathDir: string;
  readonly resourcesDir: string;
  readonly binaries: Readonly<Record<"appServer" | "remote" | "remoteServer" | "execServer" | "appServerDaemon" | "codeModeHost", string>>;
  readonly licenses: readonly { readonly source: string; readonly destination: string }[];
};
function binaryPath(relative: string, isWindows: boolean): string {
  return relative.replace("{exe}", isWindows ? ".exe" : "");
}

export interface RemoteRuntimeRelease {
  readonly sha256: string;
  readonly url: string;
}

export interface ResolvedRipgrep {
  readonly archive?: string;
  readonly archiveSha256?: string;
  readonly binarySha256: string;
  readonly executable: string;
  readonly source: "upstream-release" | "local-override";
  readonly version: string;
}

export interface ResolvedNode extends ResolvedRipgrep {
  readonly license: string;
}

export interface ResolvedBubblewrap {
  readonly source?: string;
  readonly licenses?: readonly string[];
  readonly archive: string;
  readonly archiveSha256: string;
  readonly binary: string;
  readonly license: string;
  readonly version: string;
}

export interface FirstPartyExecutables {
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

async function copyBuiltinSkills(destination: string, sourceRoot = repositoryRoot): Promise<void> {
  const source = join(sourceRoot, "ash-rs", "skills", "assets");
  const metadata = await lstat(source);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Built-in Skill source is not a real directory: ${source}`);
  }
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

async function copyBuiltinExtensions(destination: string, source = join(repositoryRoot, "extensions")): Promise<void> {
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

async function workspaceVersion(sourceRoot = repositoryRoot): Promise<string> {
  const manifest = await readFile(join(sourceRoot, "Cargo.toml"), "utf8");
  const workspacePackage = manifest.match(/\[workspace\.package\]([\s\S]*?)(?:\n\[|$)/)?.[1];
  const version = workspacePackage?.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];
  if (!version) {
    throw new Error("Could not read workspace.package.version");
  }
  return version;
}

interface AssemblyOptions {
  readonly sourceRoot?: string;
  readonly version?: string;
  readonly buildProfile?: string;
  readonly cliBinary?: string;
  readonly updatePublicKey?: string;
}

export async function assemblePackage(
  staging: string,
  target: string,
  platform: NodeJS.Platform,
  protocol: PackageIdentityMetadata["protocol"],
  executables: Omit<FirstPartyExecutables, "packageStore">,
  ripgrep: ResolvedRipgrep,
  node?: ResolvedNode,
  remoteRuntimeBundle?: string,
  remoteRuntimeRelease?: RemoteRuntimeRelease,
  options: AssemblyOptions = {},
): Promise<void> {
  const sourceRoot = options.sourceRoot ?? repositoryRoot;
  const sharedRustSource = join(sourceRoot, "ash-rs");
  const isWindows = platform === "win32";
  const rgName = isWindows ? "rg.exe" : "rg";
  const binDirectory = join(staging, "bin");
  const pathDirectory = join(staging, layout.pathDir);
  const resourcesDirectory = join(staging, layout.resourcesDir);
  await mkdir(binDirectory, { recursive: true });
  await mkdir(pathDirectory, { recursive: true });
  await copyBuiltinSkills(join(resourcesDirectory, "skills"), sourceRoot);
  await copyBuiltinExtensions(join(resourcesDirectory, "extensions"), join(sourceRoot, "extensions"));
  await copyRegularTree(join(sourceRoot, "resources", "product-services"), join(resourcesDirectory, "product-services"), "product services");
  if (remoteRuntimeBundle) {
    await copyRegularTree(remoteRuntimeBundle, join(staging, "ash-remote-runtimes"), "Remote runtime bundle");
  }
  for (const [component, relative] of Object.entries(layout.binaries)) {
    await copyExecutable(executables[component as keyof typeof layout.binaries], join(staging, binaryPath(relative, isWindows)), isWindows);
  }
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
  for (const license of layout.licenses) {
    const destination = join(staging, license.destination);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(sourceRoot, license.source), destination);
  }

  const components: Record<string, unknown> & { node?: unknown } = {
    ripgrep: {
      ...(ripgrep.archive !== undefined ? { archive: ripgrep.archive } : {}),
      ...(ripgrep.archiveSha256 !== undefined ? { archiveSha256: ripgrep.archiveSha256 } : {}),
      binarySha256: ripgrep.binarySha256,
      source: ripgrep.source,
      version: ripgrep.version,
    },
  };
  for (const [component, relative] of Object.entries(layout.binaries)) {
    components[component] = { source: "cargo-build", binarySha256: await sha256(join(staging, binaryPath(relative, isWindows))) };
  }
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
    if (bubblewrap.licenses) {
      for (const license of bubblewrap.licenses) await copyFile(license, join(licenseDirectory, license.split(/[\\/]/).at(-1)!));
    } else {
      await copyFile(bubblewrap.license, join(licenseDirectory, "COPYING"));
    }
    components.bubblewrap = {
      binarySha256: await sha256(bubblewrap.binary),
      source: bubblewrap.source ?? "vendored-source-build",
      sourceArchive: bubblewrap.archive,
      sourceArchiveSha256: bubblewrap.archiveSha256,
      version: bubblewrap.version,
    };
  }
  if (options.cliBinary) {
    if (!options.updatePublicKey || !/^[a-f0-9]{64}$/.test(options.updatePublicKey)) {
      throw new Error("Ash Code packages require a 32-byte hexadecimal update public key");
    }
    const binary = join(binDirectory, isWindows ? "ash.exe" : "ash");
    await copyExecutable(options.cliBinary, binary, isWindows);
    components.cli = { source: "cargo-build", binarySha256: await sha256(binary), updatePublicKey: options.updatePublicKey };
  } else if (options.updatePublicKey) {
    throw new Error("--update-public-key requires --cli-bin");
  }
  const version = options.version ?? await workspaceVersion(sourceRoot);
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
    buildProfile: options.buildProfile ?? "dev-small",
    components,
    entrypoint: binaryPath(layout.entrypoint, isWindows),
    javascriptRuntime: { kind: runtimeKind },
    layoutVersion: layout.layoutVersion,
    pathDir: layout.pathDir,
    protocol,
    ...(remoteRuntimeCatalog ? { remoteRuntimeCatalog } : {}),
    resourcesDir: layout.resourcesDir,
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
  if (metadata.layoutVersion !== layout.layoutVersion || typeof metadata.components !== "object" || metadata.components === null) {
    throw new Error("Invalid package metadata");
  }
  for (const [component, relative] of Object.entries(layout.binaries)) {
    await requireComponentDigest(metadata, component, join(packageRoot, binaryPath(relative, isWindows)));
  }
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
  for (const license of layout.licenses) await requireFile(join(packageRoot, license.destination));
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input = "";
  for await (const block of process.stdin) input += block;
  const args = JSON.parse(input);
  await assemblePackage(args.staging, args.target, args.platform, args.options.protocol, args.executables, args.ripgrep,
    args.node ?? undefined, undefined, undefined, args.options);
}
