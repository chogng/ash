import { localize2 } from '../../../nls.js';
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

/** English NLS originals; each consumer resolves them through its window's localization service. */
export const dirPermissionNames: Readonly<Record<DirPermission, string>> = {
	readFiles: localize2({ bundle: 'ash.settings', key: 'capabilities.permission.readFiles' }, 'Read files').original,
	writeFiles: localize2({ bundle: 'ash.settings', key: 'capabilities.permission.writeFiles' }, 'Write files').original,
	executeCommands: localize2({ bundle: 'ash.settings', key: 'capabilities.permission.executeCommands' }, 'Execute commands').original,
	watchFiles: localize2({ bundle: 'ash.settings', key: 'capabilities.permission.watchFiles' }, 'Watch files').original,
	browseFiles: localize2({ bundle: 'ash.settings', key: 'capabilities.permission.browseFiles' }, 'Browse files').original,
	searchFiles: localize2({ bundle: 'ash.settings', key: 'capabilities.permission.searchFiles' }, 'Search files').original,
	loadInstructions: localize2({ bundle: 'ash.settings', key: 'capabilities.permission.loadInstructions' }, 'Load instructions').original,
	loadConfig: localize2({ bundle: 'ash.settings', key: 'capabilities.permission.loadConfig' }, 'Load configuration').original,
	discoverSkills: localize2({ bundle: 'ash.settings', key: 'capabilities.permission.discoverSkills' }, 'Discover skills').original,
	discoverMcp: localize2({ bundle: 'ash.settings', key: 'capabilities.permission.discoverMcp' }, 'Discover MCP').original,
	useLanguageServices: localize2({ bundle: 'ash.settings', key: 'capabilities.permission.useLanguageServices' }, 'Use language services').original,
	discoverHooks: localize2({ bundle: 'ash.settings', key: 'capabilities.permission.discoverHooks' }, 'Discover hooks').original,
	discoverPlugins: localize2({ bundle: 'ash.settings', key: 'capabilities.permission.discoverPlugins' }, 'Discover plugins').original,
	inspectRepository: localize2({ bundle: 'ash.settings', key: 'capabilities.permission.inspectRepository' }, 'Inspect repository').original,
	mutateRepository: localize2({ bundle: 'ash.settings', key: 'capabilities.permission.mutateRepository' }, 'Modify repository').original,
};
