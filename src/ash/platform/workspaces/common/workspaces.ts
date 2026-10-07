import { URI } from '../../../base/common/uri.js';
import { extUriBiasedIgnorePathCase } from '../../../base/common/resources.js';
import { Schemas } from '../../../base/common/network.js';
import type { Event } from '../../../base/common/event.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import { hasWorkspaceFileExtension, type IWorkspaceIdentifier } from '../../workspace/common/workspace.js';

export interface IRecentFolder {
	readonly folderUri: URI;
	readonly label?: string;
}

export interface IRecentWorkspace {
	readonly workspace: IWorkspaceIdentifier;
	readonly label?: string;
}

export type IRecent = IRecentFolder | IRecentWorkspace;

export interface IRecentlyOpened {
	readonly workspaces: readonly IRecent[];
}

export interface IWorkspacesService {
	readonly onDidChangeRecentlyOpened: Event<void>;
	getRecentlyOpened(): Promise<IRecentlyOpened>;
	addRecentlyOpened(recents: readonly IRecent[]): Promise<void>;
	removeRecentlyOpened(paths: readonly URI[]): Promise<void>;
	clearRecentlyOpened(): Promise<void>;
}

export const IWorkspacesService = createServiceIdentifier<IWorkspacesService>('workspacesService');
export const MAX_RECENT_WORKSPACES = 12;
export const RECENTLY_OPENED_STORAGE_KEY = 'history.recentlyOpenedPathsList';
export const LEGACY_RECENT_WORKSPACES_STORAGE_KEY = 'workbench.recentWorkspaces';
export const RECENTLY_OPENED_CHANGED_CHANNEL = 'ash:workspaces:recent:changed';

export function recentWorkspaceUri(recent: IRecent): URI {
	return 'workspace' in recent ? recent.workspace.configPath : recent.folderUri;
}

/** Preserves URI identity across storage and process boundaries. */
export function toStoreData(recents: IRecentlyOpened): object {
	return {
		workspaces: recents.workspaces.map(recent => 'workspace' in recent
			? { workspace: { id: recent.workspace.id, configPath: recent.workspace.configPath.toString() }, label: recent.label }
			: { folderUri: recent.folderUri.toString(), label: recent.label }),
	};
}

/** Also reads the former Welcome-page records so each runtime can migrate them once. */
export function restoreRecentlyOpened(data: unknown): IRecentlyOpened {
	if (data === undefined) {
		return { workspaces: [] };
	}
	if (Array.isArray(data)) {
		const legacy = data.map(value => {
			const entry = record(value, 'Recent project');
			const root = optionalNonEmptyString(entry.root, 'Recent project path');
			if (!root) {
				throw new TypeError('Recent project path is required');
			}
			const uri = URI.file(root);
			const label = optionalNonEmptyString(entry.name, 'Recent project label');
			return hasWorkspaceFileExtension(root) ? { workspace: { id: uri.toString(), configPath: uri }, label } : { folderUri: uri, label };
		});
		return { workspaces: legacy.slice(0, MAX_RECENT_WORKSPACES) };
	}
	const value = record(data, 'Recently opened projects');
	if (!Array.isArray(value.workspaces)) {
		throw new TypeError('Recently opened projects must contain workspaces');
	}
	const workspaces: IRecent[] = value.workspaces.map(item => {
		const recent = record(item, 'Recent project');
		const label = optionalNonEmptyString(recent.label, 'Recent project label');
		if (recent.workspace !== undefined) {
			const workspace = record(recent.workspace, 'Recent workspace');
			const id = optionalNonEmptyString(workspace.id, 'Recent workspace ID');
			if (!id) {
				throw new TypeError('Recent workspace ID is required');
			}
			return { workspace: { id, configPath: parseRecentUri(workspace.configPath) }, label };
		}
		return { folderUri: parseRecentUri(recent.folderUri), label };
	});
	return { workspaces };
}

function parseRecentUri(value: unknown): URI {
	if (typeof value !== 'string' || value.length === 0) {
		throw new TypeError('Recent project URI is required');
	}
	const uri = URI.parse(value);
	if (uri.scheme !== Schemas.file || !uri.path || uri.query || uri.fragment) {
		throw new TypeError('Recent project must have a local file URI');
	}
	return uri;
}

export function mergeRecentlyOpened(current: IRecentlyOpened, added: readonly IRecent[]): IRecentlyOpened {
	const workspaces: IRecent[] = [];
	for (const recent of [...added, ...current.workspaces]) {
		if (!workspaces.some(existing => extUriBiasedIgnorePathCase.isEqual(recentWorkspaceUri(existing), recentWorkspaceUri(recent)))) {
			workspaces.push(recent);
		}
	}
	return { workspaces: workspaces.slice(0, MAX_RECENT_WORKSPACES) };
}

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
