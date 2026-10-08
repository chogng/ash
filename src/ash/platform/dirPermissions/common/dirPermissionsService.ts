import type { Event } from '../../../base/common/event.js';
import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";

export type DirPermission =
	| "readFiles" | "writeFiles" | "executeCommands"
	| "watchFiles" | "browseFiles" | "searchFiles"
	| "loadInstructions" | "loadConfig" | "discoverSkills"
	| "discoverMcp" | "useLanguageServices" | "discoverHooks"
	| "discoverPlugins" | "inspectRepository" | "mutateRepository";

/** Authorization selected by the host before entering a directory. */
export type DirGrant =
	| { readonly type: "config"; }
	| { readonly type: "host"; readonly permissions: readonly DirPermission[]; }
	| { readonly type: "user"; readonly commandId: string; readonly expectedRevision: number; readonly permissions: readonly DirPermission[]; };

export interface DirPermissionsEntry {
	readonly dir: string;
	readonly path: string | undefined;
	readonly permissions: readonly DirPermission[];
}

export interface DirPermissionsSnapshot {
	readonly revision: number;
	readonly entries: readonly DirPermissionsEntry[];
}

export interface DirPermissionsCommandResult {
	readonly revision: number;
	readonly generation: number;
	readonly disposition: "updated" | "replayed";
}

/** Frontend contract for explicit capability sets attached to directories. */
export interface IDirPermissionsService {
	readonly onDidChangePermissions: Event<void>;
	list(): Promise<DirPermissionsSnapshot>;
	read(path: string): Promise<readonly DirPermission[] | undefined>;
	/** Resolve host directory identity so aliases do not create competing permission drafts. */
	resolve(path: string): Promise<{ readonly dir: string; readonly permissions: readonly DirPermission[] | undefined; }>;
	set(path: string, permissions: readonly DirPermission[], expectedRevision: number): Promise<DirPermissionsCommandResult>;
	forget(dir: string, expectedRevision: number): Promise<DirPermissionsCommandResult>;
}

export const IDirPermissionsService = createServiceIdentifier<IDirPermissionsService>("dirPermissionsService");

/** Shared display fallbacks; identifiers and granted capabilities retain their backend semantics. */
export const dirPermissionNames: Readonly<Record<DirPermission, string>> = {
	readFiles: 'Read files',
	writeFiles: 'Write files',
	executeCommands: 'Execute commands',
	watchFiles: 'Watch files',
	browseFiles: 'Browse files',
	searchFiles: 'Search files',
	loadInstructions: 'Load instructions',
	loadConfig: 'Load configuration',
	discoverSkills: 'Discover skills',
	discoverMcp: 'Discover MCP',
	useLanguageServices: 'Use language services',
	discoverHooks: 'Discover hooks',
	discoverPlugins: 'Discover plugins',
	inspectRepository: 'Inspect repository',
	mutateRepository: 'Modify repository',
};
