import { URI } from '../../../base/common/uri.js';

/** One folder entry stored in a workspace configuration file. */
export interface IStoredWorkspaceFolder {
	readonly path?: string;
	readonly uri?: string;
	readonly name?: string;
}

/** Validates the folder list at the workspace-file boundary. */
export function parseStoredWorkspaceFolders(value: unknown, owner: string): readonly IStoredWorkspaceFolder[] {
	const document = record(value, owner);
	if (!Array.isArray(document.folders)) {
		throw new Error(`${owner} must define a folders array`);
	}
	if (document.folders.length > 256) {
		throw new Error(`${owner} must contain at most 256 folders`);
	}
	return document.folders.map((folder, index) => parseStoredWorkspaceFolder(folder, `${owner} folder ${index + 1}`));
}

function parseStoredWorkspaceFolder(value: unknown, owner: string): IStoredWorkspaceFolder {
	const folder = record(value, owner);
	const path = optionalNonEmptyString(folder.path, `${owner} path`);
	const uri = optionalNonEmptyString(folder.uri, `${owner} URI`);
	if ((path === undefined) === (uri === undefined)) {
		throw new Error(`${owner} must define exactly one of path or uri`);
	}
	if (uri !== undefined) {
		const parsed = URI.parse(uri);
		if (parsed.scheme !== 'file') {
			throw new Error(`${owner} URI must use the file scheme`);
		}
		if (parsed.query || parsed.fragment) {
			throw new Error(`${owner} URI must not contain a query or fragment`);
		}
	}
	const name = optionalNonEmptyString(folder.name, `${owner} name`);
	return { ...(path ? { path } : {}), ...(uri ? { uri } : {}), ...(name ? { name } : {}) };
}

function record(value: unknown, owner: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error(`${owner} must be an object`);
	}
	return value as Record<string, unknown>;
}

function optionalNonEmptyString(value: unknown, owner: string): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new Error(`${owner} must be a non-empty string`);
	}
	return value;
}
