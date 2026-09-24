import { type IDisposable } from "../../../../base/common/lifecycle.js";
import { type URI } from "../../../../base/common/uri.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";

export interface WorkingCopyBackup {
	readonly resource: URI;
	readonly kind: "text" | "structuredDocument";
	readonly content: string;
	readonly updatedAt: number;
	readonly languageId?: string;
	readonly contentType?: string;
	readonly label?: string;
}

/** Durable, workspace-scoped crash backups for dirty working copies. */
export interface IWorkingCopyBackupService extends IDisposable {
	list(): Promise<readonly WorkingCopyBackup[]>;
	store(backup: WorkingCopyBackup): Promise<void>;
	delete(resource: URI): Promise<void>;
	switchWorkspace(workspaceId: string): void;
}

export const IWorkingCopyBackupService = createServiceIdentifier<IWorkingCopyBackupService>("workingCopyBackupService");
