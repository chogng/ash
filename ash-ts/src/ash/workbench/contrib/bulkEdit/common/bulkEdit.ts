import { type URI } from "../../../../base/common/uri.js";
import { type LanguageWorkspaceEdit } from "../../../../editor/common/languages.js";

export type BulkEditPreviewEntryKind = "textDocument" | "create" | "rename" | "delete";

/** One selectable row in the Workbench bulk-edit preview. */
export interface BulkEditPreviewEntry {
	readonly index: number;
	readonly kind: BulkEditPreviewEntryKind;
	readonly resource: URI;
	readonly secondaryResource?: URI;
	readonly detail: string;
	readonly before?: string;
	readonly after?: string;
	readonly error?: string;
}

/** Materialized preview data; the original ordered edit remains the apply contract. */
export interface BulkEditPreviewModel {
	readonly edit: LanguageWorkspaceEdit;
	readonly entries: readonly BulkEditPreviewEntry[];
	readonly canApply: boolean;
}
