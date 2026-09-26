import { createHash } from "node:crypto";
import { readFile, realpath, stat } from 'node:fs/promises';
import { URI } from "../../../base/common/uri.js";
import type { ISingleFolderWorkspaceIdentifier, IWorkspaceIdentifier } from "../../workspace/common/workspace.js";

/** Creates the stable identity of one multi-root workspace file. */
export function getWorkspaceIdentifier(configPath: URI): IWorkspaceIdentifier {
	return Object.freeze({ id: stableWorkspaceId(configPath), configPath });
}

/** Creates the stable identity of one single-folder workspace. */
export function getSingleFolderWorkspaceIdentifier(uri: URI): ISingleFolderWorkspaceIdentifier {
	return Object.freeze({ id: stableWorkspaceId(uri), uri });
}

export function stableWorkspaceId(uri: URI): string {
	const identity = uri.scheme !== "file" || process.platform === "linux" ? uri.toString() : uri.toString().toLowerCase();
	return createHash("sha256").update(identity).digest("hex");
}

export const enum WorkspacePathKind {
	Directory,
	File,
	Other,
}

export interface IResolvedWorkspacePath {
	readonly kind: WorkspacePathKind;
	readonly path: string;
}

/** Filesystem operations shared by window target and workspace-file resolution. */
export interface IWorkspacePathService {
	resolvePath(path: string): Promise<IResolvedWorkspacePath>;
	readFile?(path: string): Promise<string>;
}

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
