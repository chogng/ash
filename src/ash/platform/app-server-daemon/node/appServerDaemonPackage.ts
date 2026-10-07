import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_SERVER_PROTOCOL_MAJOR, APP_SERVER_SCHEMA_HASH } from "../../../../../crates/app-server-protocol/schema/typescript/index.js";
import { developmentArtifactsPath, developmentAshPackagePath } from "../../environment/node/developmentArtifacts.js";

export interface AppServerDaemonPackageLocation {
	readonly appPath: string;
	readonly expectedVersion?: string;
	readonly isPackaged: boolean;
	readonly platform: NodeJS.Platform;
	readonly resourcesPath: string;
}

interface AshPackageMetadata {
	readonly buildId?: unknown;
	readonly components?: {
		readonly appServerDaemon?: { readonly binarySha256?: unknown; };
		readonly appServer?: { readonly binarySha256?: unknown; };
	};
	readonly entrypoint?: unknown;
	readonly layoutVersion?: unknown;
	readonly protocol?: {
		readonly major?: unknown;
		readonly schemaHash?: unknown;
	};
	readonly version?: unknown;
}

/** Reads the digest bound to the signed product package; development generations are checked during initialization. */
export function packagedAppServerDaemonSha256(location: AppServerDaemonPackageLocation): string | undefined {
	return packagedComponentSha256(location, "appServerDaemon");
}

/** Reads the separately signed managed backend digest. */
export function packagedAppServerSha256(location: AppServerDaemonPackageLocation): string | undefined {
	return packagedComponentSha256(location, "appServer");
}

function packagedComponentSha256(location: AppServerDaemonPackageLocation, component: "appServer" | "appServerDaemon"): string | undefined {
	if (!location.isPackaged) return undefined;
	const packageRoot = appServerPackageRoot(location);
	const metadataPath = join(packageRoot, "ash-package.json");
	const metadataStat = lstatSync(metadataPath);
	if (!metadataStat.isFile() || metadataStat.isSymbolicLink() || metadataStat.size > 1024 * 1024) {
		throw new Error(`Invalid Ash package metadata file: ${metadataPath}`);
	}
	const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as AshPackageMetadata;
	const expectedEntrypoint = `bin/${location.platform === "win32" ? "ash-app-server.exe" : "ash-app-server"}`;
	const digest = metadata.components?.[component]?.binarySha256;
	const protocolMatchesDesktop = metadata.protocol?.major === APP_SERVER_PROTOCOL_MAJOR
		&& metadata.protocol.schemaHash === APP_SERVER_SCHEMA_HASH;
	if (metadata.layoutVersion !== 2 || metadata.entrypoint !== expectedEntrypoint || (location.expectedVersion !== undefined && metadata.version !== location.expectedVersion) || !protocolMatchesDesktop || typeof metadata.buildId !== "string" || !/^sha256:[a-f0-9]{64}$/.test(metadata.buildId) || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
		throw new Error(`Invalid Ash package metadata: ${metadataPath}`);
	}
	return digest;
}

/** Resolves the profile-scoped App Server daemon from the canonical Desktop package layout. */
export function appServerDaemonExecutablePath(location: AppServerDaemonPackageLocation): string {
	return join(appServerPackageRoot(location), "bin", location.platform === "win32" ? "ash-app-server-daemon.exe" : "ash-app-server-daemon");
}

function appServerPackageRoot(location: AppServerDaemonPackageLocation): string {
	const packageRoot = location.isPackaged
		? location.resourcesPath
		: developmentAshPackagePath(location.appPath);
	return packageRoot;
}

/** Resolves the development-only generation pointer published by the Rust watcher. */
export function developmentAppServerGenerationPath(appPath: string): string {
	return developmentArtifactsPath(appPath, "dev", "app-server", "current.json");
}

/** Resolves the managed App Server executable independently of its lifecycle command carrier. */
export function appServerExecutablePath(location: AppServerDaemonPackageLocation): string {
	return join(appServerPackageRoot(location), "bin", location.platform === "win32" ? "ash-app-server.exe" : "ash-app-server");
}
