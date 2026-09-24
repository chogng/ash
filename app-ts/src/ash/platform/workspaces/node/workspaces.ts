import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import { parseJsonc } from "../../../base/common/jsonc.js";
import { URI } from "../../../base/common/uri.js";
import {
	type IAnyWorkspaceIdentifier,
	type ISingleFolderWorkspaceIdentifier,
	type IWorkspace,
	type IWorkspaceFolder,
	type IWorkspaceIdentifier,
	UNKNOWN_EMPTY_WINDOW_WORKSPACE,
	workspaceFromIdentifier,
} from "../../workspace/common/workspace.js";
import {
	type IWorkspaceOpenTarget,
	WorkspaceOpenTargetKind,
} from "../common/workspaces.js";
import { createSshRemoteWorkspaceUri } from "../../remote/common/remote.js";

const WORKSPACE_EXTENSIONS = new Set([".ash-workspace", ".code-workspace"]);

/** Filesystem shape found for a requested workspace path. */
export const enum WorkspacePathKind {
	Directory,
	File,
	Other,
}

/** Canonical filesystem result used while resolving an open target. */
export interface IResolvedWorkspacePath {
	readonly kind: WorkspacePathKind;
	readonly path: string;
}

/** Host filesystem operations needed to canonicalize a workspace path. */
export interface IWorkspacePathService {
	resolvePath(path: string): Promise<IResolvedWorkspacePath>;
	readFile?(path: string): Promise<string>;
}

/** Native path service used by the Electron main process. */
export const nodeWorkspacePathService: IWorkspacePathService = {
	async resolvePath(path): Promise<IResolvedWorkspacePath> {
		const canonicalPath = await realpath(path);
		const metadata = await stat(canonicalPath);
		const kind = metadata.isDirectory()
			? WorkspacePathKind.Directory
			: metadata.isFile()
				? WorkspacePathKind.File
				: WorkspacePathKind.Other;
		return { kind, path: canonicalPath };
	},
	readFile: path => readFile(path, 'utf8'),
};

/**
 * Resolves one launch target into a stable folder or workspace identity.
 *
 * A loose file is not a workspace, so it resolves to an empty-window identity.
 */
export async function resolveWorkspaceOpenTarget(
	target: IWorkspaceOpenTarget,
	cwd: string,
	pathService: IWorkspacePathService = nodeWorkspacePathService,
): Promise<IAnyWorkspaceIdentifier> {
	if (target.kind === WorkspaceOpenTargetKind.RemoteFolder) {
		return getSingleFolderWorkspaceIdentifier(createSshRemoteWorkspaceUri(target.sshHost, target.path));
	}
	const requestedPath = resolve(cwd, target.path);
	const resolved = await pathService.resolvePath(requestedPath);
	if (
		target.kind === WorkspaceOpenTargetKind.Folder &&
		resolved.kind !== WorkspacePathKind.Directory
	) {
		throw new Error(`Workspace folder is not a directory: ${target.path}`);
	}
	if (
		target.kind === WorkspaceOpenTargetKind.Workspace &&
		resolved.kind !== WorkspacePathKind.File
	) {
		throw new Error(`Workspace configuration is not a file: ${target.path}`);
	}

	if (resolved.kind === WorkspacePathKind.Directory) {
		return getSingleFolderWorkspaceIdentifier(URI.file(resolved.path));
	}
	if (
		resolved.kind === WorkspacePathKind.File &&
		(
			target.kind === WorkspaceOpenTargetKind.Workspace ||
			WORKSPACE_EXTENSIONS.has(extname(resolved.path).toLowerCase())
		)
	) {
		return getWorkspaceIdentifier(URI.file(resolved.path));
	}
	return UNKNOWN_EMPTY_WINDOW_WORKSPACE;
}

/** Resolves a workspace file into its canonical ordered folder projection. */
export async function resolveWorkspace(
	identifier: IAnyWorkspaceIdentifier,
	pathService: IWorkspacePathService = nodeWorkspacePathService,
): Promise<IWorkspace> {
	if (!('configPath' in identifier)) return workspaceFromIdentifier(identifier);
	if (!pathService.readFile) throw new Error('Workspace configuration reading is unavailable');
	const configPath = identifier.configPath.fsPath;
	const source = await pathService.readFile(configPath);
	const document = workspaceConfiguration(parseJsonc(source, configPath), configPath);
	const folders: IWorkspaceFolder[] = [];
	const identities = new Set<string>();
	for (const configured of document.folders) {
		const requestedPath = configured.path ?? URI.parse(configured.uri!).fsPath;
		const absolutePath = isAbsolute(requestedPath) ? requestedPath : resolve(dirname(configPath), requestedPath);
		const resolved = await pathService.resolvePath(absolutePath);
		if (resolved.kind !== WorkspacePathKind.Directory) throw new Error(`Workspace folder is not a directory: ${requestedPath}`);
		const uri = URI.file(resolved.path);
		const identity = process.platform === 'linux' ? uri.toString() : uri.toString().toLowerCase();
		if (identities.has(identity)) continue;
		identities.add(identity);
		folders.push(Object.freeze({
			id: stableWorkspaceId(uri),
			uri,
			name: configured.name ?? basename(resolved.path),
			index: folders.length,
		}));
	}
	return Object.freeze({
		id: identifier.id,
		folders: Object.freeze(folders),
		configuration: identifier.configPath,
		name: workspaceFileName(identifier.configPath),
	});
}

/** Creates the stable identity of one multi-root workspace file. */
export function getWorkspaceIdentifier(
	configPath: URI,
): IWorkspaceIdentifier {
	return Object.freeze({
		id: stableWorkspaceId(configPath),
		configPath,
	});
}

/** Creates the stable identity of one single-folder workspace. */
export function getSingleFolderWorkspaceIdentifier(
	uri: URI,
): ISingleFolderWorkspaceIdentifier {
	return Object.freeze({
		id: stableWorkspaceId(uri),
		uri,
	});
}

function stableWorkspaceId(uri: URI): string {
	const identity = uri.scheme !== "file" || process.platform === "linux" ? uri.toString() : uri.toString().toLowerCase();
	return createHash("sha256").update(identity).digest("hex");
}

interface StoredWorkspaceFolder {
	readonly path?: string;
	readonly uri?: string;
	readonly name?: string;
}

function workspaceConfiguration(value: unknown, owner: string): { readonly folders: readonly StoredWorkspaceFolder[] } {
	const document = record(value, owner);
	if (!Array.isArray(document.folders)) throw new Error(`${owner} must define a folders array`);
	if (document.folders.length > 256) throw new Error(`${owner} must contain at most 256 folders`);
	return {
		folders: document.folders.map((value, index) => storedWorkspaceFolder(value, `${owner} folder ${index + 1}`)),
	};
}

function storedWorkspaceFolder(value: unknown, owner: string): StoredWorkspaceFolder {
	const folder = record(value, owner);
	const path = optionalNonEmptyString(folder.path, `${owner} path`);
	const uri = optionalNonEmptyString(folder.uri, `${owner} URI`);
	if ((path === undefined) === (uri === undefined)) throw new Error(`${owner} must define exactly one of path or uri`);
	if (uri !== undefined) {
		const parsed = URI.parse(uri);
		if (parsed.scheme !== 'file') throw new Error(`${owner} URI must use the file scheme`);
		if (parsed.query || parsed.fragment) throw new Error(`${owner} URI must not contain a query or fragment`);
	}
	const name = optionalNonEmptyString(folder.name, `${owner} name`);
	return { ...(path ? { path } : {}), ...(uri ? { uri } : {}), ...(name ? { name } : {}) };
}

function record(value: unknown, owner: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${owner} must be an object`);
	return value as Record<string, unknown>;
}

function optionalNonEmptyString(value: unknown, owner: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${owner} must be a non-empty string`);
	return value;
}

function workspaceFileName(configPath: URI): string {
	const name = basename(configPath.fsPath);
	for (const extension of WORKSPACE_EXTENSIONS) {
		if (name.toLowerCase().endsWith(extension)) return name.slice(0, -extension.length) || name;
	}
	return name;
}
