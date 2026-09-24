import { type Event } from "../../../../base/common/event.js";
import { type IDisposable } from "../../../../base/common/lifecycle.js";
import { type URI } from "../../../../base/common/uri.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";

/**
 * Format-neutral persistence lifecycle exposed by an editor domain to the Workbench.
 *
 * The implementation owns its editor model and serialization policy. The Workbench
 * uses this contract for dirty state, save/revert commands, and resource coordination.
 */
export interface IWorkingCopy extends IDisposable {
	readonly resource: URI;
	readonly backupKind: "text" | "structuredDocument";
	readonly backupLanguageId?: string;
	readonly backupContentType?: string;
	readonly backupLabel?: string;
	readonly isDirty: boolean;
	readonly hasExternalChange: boolean;
	readonly onDidChangeDirty: Event<void>;
	readonly onDidChangeExternalChange: Event<void>;
	readonly onDidChangeContent: Event<void>;
	/** Current serialized editor-domain content used for crash recovery. */
	backup(): string;
	/** Replaces current content with a crash backup while retaining the persisted baseline. */
	restoreBackup(content: string): void;
	save(signal: AbortSignal): Promise<void>;
	saveAs(resource: URI, signal: AbortSignal): Promise<void>;
	revert(signal: AbortSignal): Promise<void>;
}

/**
 * Registry for active editor-domain working copies.
 *
 * Registration does not transfer ownership: the editor pane still disposes the
 * working copy, while the service only indexes it for Workbench coordination.
 */
export interface IWorkingCopyService extends IDisposable {
	readonly onDidRegister: Event<IWorkingCopy>;
	readonly onDidUnregister: Event<IWorkingCopy>;
	readonly onDidChangeDirty: Event<void>;
	readonly hasDirtyWorkingCopies: boolean;
	register(workingCopy: IWorkingCopy): IDisposable;
	get(resource: URI): readonly IWorkingCopy[];
	getAll(): readonly IWorkingCopy[];
}

export const IWorkingCopyService = createServiceIdentifier<IWorkingCopyService>("workingCopyService");
