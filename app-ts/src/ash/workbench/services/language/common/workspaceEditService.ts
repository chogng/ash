import { type URI } from "../../../../base/common/uri.js";
import { type LanguageWorkspaceEdit } from "../../../../editor/common/languages.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";

export interface WorkspaceEditResult {
	readonly resources: readonly URI[];
	/** Reverts this application while its touched resources still match the applied state. */
	readonly undo: () => Promise<void>;
}

/** Applies one validated multi-resource language edit through shared text models. */
export interface IWorkspaceEditService {
	apply(edit: LanguageWorkspaceEdit, signal?: AbortSignal): Promise<WorkspaceEditResult>;
}

export const IWorkspaceEditService = createServiceIdentifier<IWorkspaceEditService>("workspaceEditService");
