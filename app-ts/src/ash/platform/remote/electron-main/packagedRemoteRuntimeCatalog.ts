import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readFileSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isRecord } from "../../../base/common/types.js";
import { developmentAshPackagePath } from "../../environment/node/developmentArtifacts.js";
import { validLocalCommand } from "./remoteCommand.js";
import { type TrustedRemoteRuntimeArtifact, validateTrustedRemoteRuntimeArtifact } from "./remoteRuntimeInstaller.js";

const CATALOG_FORMAT_VERSION = 1;
const MAX_CATALOG_BYTES = 1024 * 1024;
const CATALOG_KEYS = new Set(["formatVersion", "artifacts"]);
const ARTIFACT_KEYS = new Set(["version", "target", "archive", "archiveSize", "unpackedSize", "sha256"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PACKAGE_METADATA_MAX_BYTES = 1024 * 1024;

export interface RemoteRuntimePackageLocation {
	readonly appPath: string;
	readonly isPackaged: boolean;
	readonly resourcesPath: string;
}

export type RemoteRuntimeCatalogSource =
	| { readonly kind: "packaged"; readonly bundleRoot: string; readonly expectedSha256: string }
	| { readonly kind: "network"; readonly catalogUrl: string; readonly expectedSha256: string; readonly cacheRoot: string };

/** Reads the signed product package's exact Remote catalog binding in Electron Main. */
export function packagedRemoteRuntimeCatalogSource(location: RemoteRuntimePackageLocation, cacheRoot: string): RemoteRuntimeCatalogSource {
	if (!isAbsolute(cacheRoot) || !validLocalCommand(cacheRoot)) throw new Error("Remote runtime download cache must be an absolute local path");
	const packageRoot = remoteRuntimePackageRoot(location);
	const metadataPath = join(packageRoot, "ash-package.json");
	const metadata = lstatSync(metadataPath);
	if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size <= 0 || metadata.size > PACKAGE_METADATA_MAX_BYTES) throw new Error("Ash package metadata is not a bounded regular file");
	const document = parsePackageMetadata(readFileSync(metadataPath, "utf8"));
	const binding = document.remoteRuntimeCatalog;
	if (!isRecord(binding) || binding.trustBinding !== "signedProductPackage" || typeof binding.sha256 !== "string" || !SHA256_PATTERN.test(binding.sha256)) throw new Error("Ash package has no valid signed Remote runtime catalog binding");
	if (typeof binding.url === "string" && binding.path === undefined) {
		validateNetworkCatalogUrl(binding.url);
		return Object.freeze({ kind: "network", catalogUrl: binding.url, expectedSha256: binding.sha256, cacheRoot });
	}
	if (binding.url === undefined && binding.path === "ash-remote-runtimes/catalog.json") {
		return Object.freeze({ kind: "packaged", bundleRoot: join(packageRoot, "ash-remote-runtimes"), expectedSha256: binding.sha256 });
	}
	throw new Error("Ash package Remote runtime catalog binding selects an invalid or ambiguous source");
}

/** Resolves the updater-delivered Remote runtime bundle inside the canonical product package. */
export function packagedRemoteRuntimeBundleRoot(location: RemoteRuntimePackageLocation): string {
	const packageRoot = remoteRuntimePackageRoot(location);
	return join(packageRoot, "ash-remote-runtimes");
}

function remoteRuntimePackageRoot(location: RemoteRuntimePackageLocation): string {
	return location.isPackaged ? location.resourcesPath : developmentAshPackagePath(location.appPath);
}

/** A strictly validated catalog authenticated by the signed Desktop package containing it. */
export class PackagedRemoteRuntimeCatalog {
	private constructor(private readonly artifacts: ReadonlyMap<string, TrustedRemoteRuntimeArtifact>) {}

	static async load(bundleRoot: string, expectedSha256?: string): Promise<PackagedRemoteRuntimeCatalog> {
		if (!isAbsolute(bundleRoot) || !validLocalCommand(bundleRoot)) throw new Error("Packaged Remote runtime bundle root must be an absolute local path");
		await requireRealDirectory(bundleRoot, "Remote runtime bundle");
		const catalogPath = join(bundleRoot, "catalog.json");
		const catalogMetadata = await requireRealFile(catalogPath, "Remote runtime catalog");
		if (catalogMetadata.size <= 0 || catalogMetadata.size > MAX_CATALOG_BYTES) throw new Error(`Remote runtime catalog must contain between 1 and ${MAX_CATALOG_BYTES} bytes`);
		const catalogBytes = await readFile(catalogPath);
		if (expectedSha256 !== undefined && (!SHA256_PATTERN.test(expectedSha256) || createHash("sha256").update(catalogBytes).digest("hex") !== expectedSha256)) throw new Error("Packaged Remote runtime catalog SHA-256 does not match its signed product binding");
		const document = parseCatalogDocument(catalogBytes.toString("utf8"));
		const artifacts = new Map<string, TrustedRemoteRuntimeArtifact>();
		for (const record of document.artifacts) {
			const relativeArchive = parseRelativeArchivePath(record.archive);
			const archivePath = join(bundleRoot, ...relativeArchive.split("/"));
			await requireUnlinkedPath(bundleRoot, relativeArchive);
			const archiveMetadata = await requireRealFile(archivePath, `Remote runtime archive for ${record.target}`);
			const artifact = Object.freeze({
				archivePath,
				version: record.version,
				target: record.target,
				archiveSize: record.archiveSize,
				unpackedSize: record.unpackedSize,
				sha256: record.sha256,
			});
			validateTrustedRemoteRuntimeArtifact(artifact);
			if (artifacts.has(artifact.target)) throw new Error(`Remote runtime catalog repeats target ${artifact.target}`);
			if (archiveMetadata.size !== artifact.archiveSize) throw new Error(`Remote runtime archive size mismatch for ${artifact.target}`);
			const observedDigest = await sha256(archivePath);
			if (observedDigest !== artifact.sha256) throw new Error(`Remote runtime archive SHA-256 mismatch for ${artifact.target}`);
			artifacts.set(artifact.target, artifact);
		}
		if (artifacts.size === 0) throw new Error("Remote runtime catalog has no artifacts");
		return new PackagedRemoteRuntimeCatalog(artifacts);
	}

	artifactFor(target: string): TrustedRemoteRuntimeArtifact | undefined {
		return this.artifacts.get(target);
	}
}

function parsePackageMetadata(text: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error("Ash package metadata is invalid JSON", { cause: error });
	}
	if (!isRecord(value)) throw new Error("Ash package metadata must be an object");
	return value;
}

function validateNetworkCatalogUrl(value: string): void {
	let url: URL;
	try {
		url = new URL(value);
	} catch (error) {
		throw new Error("Remote runtime catalog URL is invalid", { cause: error });
	}
	if (url.protocol !== "https:" || url.hostname.length === 0 || url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0 || !url.pathname.endsWith("/catalog.json")) throw new Error("Remote runtime catalog URL must be a credential-free HTTPS catalog.json URL without query or fragment");
}

interface CatalogDocument {
	readonly artifacts: readonly CatalogArtifactRecord[];
}

interface CatalogArtifactRecord {
	readonly version: string;
	readonly target: string;
	readonly archive: string;
	readonly archiveSize: number;
	readonly unpackedSize: number;
	readonly sha256: string;
}

function parseCatalogDocument(text: string): CatalogDocument {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error("Remote runtime catalog is invalid JSON", { cause: error });
	}
	if (!isRecord(value) || !hasExactKeys(value, CATALOG_KEYS) || value.formatVersion !== CATALOG_FORMAT_VERSION || !Array.isArray(value.artifacts)) throw new Error("Remote runtime catalog has an invalid document shape or format version");
	const artifacts = value.artifacts.map((record, index) => parseArtifactRecord(record, index));
	return { artifacts };
}

function parseArtifactRecord(value: unknown, index: number): CatalogArtifactRecord {
	if (!isRecord(value) || !hasExactKeys(value, ARTIFACT_KEYS)) throw new Error(`Remote runtime catalog artifact ${index} has an invalid shape`);
	if (typeof value.version !== "string" || typeof value.target !== "string" || typeof value.archive !== "string" || typeof value.archiveSize !== "number" || typeof value.unpackedSize !== "number" || typeof value.sha256 !== "string") throw new Error(`Remote runtime catalog artifact ${index} has invalid field types`);
	return {
		version: value.version,
		target: value.target,
		archive: value.archive,
		archiveSize: value.archiveSize,
		unpackedSize: value.unpackedSize,
		sha256: value.sha256,
	};
}

function parseRelativeArchivePath(value: string): string {
	const segments = value.split("/");
	if (value.length === 0 || value.startsWith("/") || value.endsWith("/") || value.includes("\\") || value.includes("\0") || value.includes("\n") || value.includes("\r") || value.includes(":") || segments.some(segment => segment.length === 0 || segment === "." || segment === "..")) throw new Error(`Remote runtime archive path is not canonical: ${value}`);
	return value;
}

async function requireUnlinkedPath(root: string, relativePath: string): Promise<void> {
	let current = root;
	for (const segment of relativePath.split("/")) {
		current = join(current, segment);
		const metadata = await lstat(current);
		if (metadata.isSymbolicLink()) throw new Error(`Remote runtime bundle contains a symbolic path: ${current}`);
	}
}

async function requireRealDirectory(path: string, name: string): Promise<void> {
	const metadata = await lstat(path);
	if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`${name} is not a real directory: ${path}`);
}

async function requireRealFile(path: string, name: string) {
	const metadata = await lstat(path);
	if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`${name} is not a regular file: ${path}`);
	return metadata;
}

function sha256(path: string): Promise<string> {
	return new Promise((resolveDigest, reject) => {
		const hash = createHash("sha256");
		const input = createReadStream(path);
		input.on("data", chunk => hash.update(chunk));
		input.once("error", reject);
		input.once("end", () => resolveDigest(hash.digest("hex")));
	});
}

function hasExactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
	const keys = Object.keys(value);
	return keys.length === expected.size && keys.every(key => expected.has(key));
}
