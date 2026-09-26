import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";

export type DirPermission =
	| "readFiles" | "writeFiles" | "executeCommands"
	| "watchFiles" | "browseFiles" | "searchFiles"
	| "loadInstructions" | "loadConfig" | "discoverSkills"
	| "discoverMcp" | "useLanguageServices" | "discoverHooks"
	| "discoverPlugins" | "inspectRepository" | "mutateRepository";

/** Choice made by the user before a new folder receives directory permissions. */
export type DirPermissionChoice = 'development' | 'readOnly' | 'cancel';

/** Authorization selected by the host before entering a directory. */
export type DirGrant =
	| { readonly type: "config" }
	| { readonly type: "host"; readonly permissions: readonly DirPermission[] }
	| { readonly type: "user"; readonly commandId: string; readonly expectedRevision: number; readonly permissions: readonly DirPermission[] };

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
	list(): Promise<DirPermissionsSnapshot>;
	read(path: string): Promise<readonly DirPermission[] | undefined>;
	set(path: string, permissions: readonly DirPermission[], expectedRevision: number): Promise<DirPermissionsCommandResult>;
	forget(dir: string, expectedRevision: number): Promise<DirPermissionsCommandResult>;
}

export const IDirPermissionsService = createServiceIdentifier<IDirPermissionsService>("dirPermissionsService");
