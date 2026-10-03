import { type URI } from "../../../../base/common/uri.js";
import { type LanguageWorkspaceEdit } from "../../../../editor/common/languages.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";
import type { ProgressHandle } from '../../../../platform/progress/common/progress.js';

export interface WorkspaceEditResult {
	/** Distinct resources changed by committed operations; ignored and unchanged edits are excluded. */
	readonly resources: readonly URI[];
	/** Reverts this application while its touched resources still match the applied state. */
	readonly undo: () => Promise<void>;
}

/** Applies one validated multi-resource language edit through shared text models. */
export interface IWorkspaceEditService {
	apply(edit: LanguageWorkspaceEdit, signal?: AbortSignal, progress?: Pick<ProgressHandle, 'report'>): Promise<WorkspaceEditResult>;
}

export const IWorkspaceEditService = createServiceIdentifier<IWorkspaceEditService>("workspaceEditService");

/** A captured document version or content no longer matches the shared model. */
export class WorkspaceEditConflictError extends Error {}
