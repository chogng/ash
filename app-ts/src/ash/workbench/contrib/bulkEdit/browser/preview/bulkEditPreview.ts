import { throwIfCancelled } from "../../../../../base/common/cancellation.js";
import { getErrorMessage, isCancellationError } from "../../../../../base/common/errors.js";
import { type URI } from "../../../../../base/common/uri.js";
import { FileKind, FileNotFoundError, type IFileService } from "../../../../../platform/files/common/files.js";
import { normalizeTextLineEndings } from "../../../../../editor/common/core/textChange.js";
import { TextModel } from "../../../../../editor/common/model/textModel.js";
import { type ITextModelResourceService } from "../../../../services/textmodelResolver/common/textModelResourceService.js";
import { normalizeLanguageWorkspaceEdit, type LanguageWorkspaceEdit, type LanguageWorkspaceEditEntry } from "../../../../../editor/common/languages.js";
import { type IWorkingCopyService } from "../../../../services/workingCopy/common/workingCopyService.js";
import { localize } from '../../../../../nls.js';
import type { ConflictDetector } from '../conflicts.js';


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
	readonly conflicts?: ConflictDetector;
}
export interface BulkEditPreviewDependencies {
	readonly files: IFileService;
	readonly models: ITextModelResourceService;
	readonly workingCopies: IWorkingCopyService;
}

interface FileState {
	readonly exists: boolean;
	readonly kind?: FileKind;
	readonly text?: string;
	readonly synthetic?: boolean;
}

/** Materializes a safe, selectable summary without mutating any editor or file. */
export async function createBulkEditPreview(value: LanguageWorkspaceEdit, dependencies: BulkEditPreviewDependencies, signal: AbortSignal): Promise<BulkEditPreviewModel> {
	const edit = normalizeLanguageWorkspaceEdit(value);
	const states = new Map<string, FileState>();
	const entries: BulkEditPreviewEntry[] = [];
	for (let index = 0; index < edit.entries.length; index++) {
		throwIfCancelled(signal, localize('bulkEdit.previewCancelled', "Bulk edit preview was cancelled"));
		entries.push(await previewEntry(edit.entries[index]!, index, dependencies, states, signal));
	}
	return Object.freeze({ edit, entries: Object.freeze(entries), canApply: entries.length > 0 && entries.every(entry => entry.error === undefined) });
}

async function previewEntry(entry: LanguageWorkspaceEditEntry, index: number, dependencies: BulkEditPreviewDependencies, states: Map<string, FileState>, signal: AbortSignal): Promise<BulkEditPreviewEntry> {
	try {
		switch (entry.kind) {
			case "textDocument":
				return await previewTextDocument(entry, index, dependencies, states, signal);
			case "create":
				return await previewCreate(entry, index, dependencies, states);
			case "rename":
				return await previewRename(entry, index, dependencies, states);
			case "delete":
				return await previewDelete(entry, index, dependencies, states);
		}
	} catch (error) {
		if (isCancellationError(error)) throw error;
		throwIfCancelled(signal, localize('bulkEdit.previewCancelled', "Bulk edit preview was cancelled"));
		return { index, kind: entry.kind, resource: resourceFor(entry), ...(entry.kind === "rename" ? { secondaryResource: entry.target } : {}), detail: localize('bulkEdit.prepareFailed', "Could not prepare this edit"), error: getErrorMessage(error) };
	}
}

async function previewTextDocument(entry: Extract<LanguageWorkspaceEditEntry, { kind: "textDocument" }>, index: number, dependencies: BulkEditPreviewDependencies, states: Map<string, FileState>, signal: AbortSignal): Promise<BulkEditPreviewEntry> {
	const state: FileState = states.get(entry.resource.toString()) ?? (dependencies.workingCopies.get(entry.resource).length > 0
		? { exists: true, kind: FileKind.File }
		: await getFileState(entry.resource, dependencies.files, states));
	if (!state.exists || state.kind !== FileKind.File) return { index, kind: entry.kind, resource: entry.resource, detail: localize('bulkEdit.textEdits', '{0} text edits', entry.edits.length), error: localize('bulkEdit.missingTextTarget', 'The edit target does not exist or is not a UTF-8 file.') };
	using reference = await dependencies.models.acquire({ resource: entry.resource, ...(state.synthetic ? { initialText: state.text } : {}) }, signal);
	const before = state.synthetic ? state.text! : reference.model.getText();
	if (entry.version !== undefined && reference.model.version !== entry.version) return { index, kind: entry.kind, resource: entry.resource, detail: localize('bulkEdit.textEdits', '{0} text edits', entry.edits.length), before, error: localize('bulkEdit.staleVersion', "The document changed; this edit is stale.") };
	if (entry.expectedText !== undefined && normalizeTextLineEndings(entry.expectedText) !== normalizeTextLineEndings(before)) return { index, kind: entry.kind, resource: entry.resource, detail: localize('bulkEdit.textEdits', '{0} text edits', entry.edits.length), before, error: localize('bulkEdit.staleContent', "The document content changed; this edit is stale.") };
	using snapshot = new TextModel(before);
	for (const edit of entry.edits) {
		if (!snapshot.isValidRange(edit.range)) throw new RangeError(localize('bulkEdit.invalidRange', 'The edit range is outside the document.'));
	}
	snapshot.applyEdits(entry.edits);
	const after = snapshot.getText();
	states.set(entry.resource.toString(), { exists: true, kind: FileKind.File, text: after, synthetic: true });
	return { index, kind: entry.kind, resource: entry.resource, detail: localize('bulkEdit.textEditSummary', '{0} text edits · {1}', entry.edits.length, textChangeSummary(before, after)), before, after };
}

async function previewCreate(entry: Extract<LanguageWorkspaceEditEntry, { kind: "create" }>, index: number, dependencies: BulkEditPreviewDependencies, states: Map<string, FileState>): Promise<BulkEditPreviewEntry> {
	const error = openResourceError(entry.resource, "create", dependencies.workingCopies);
	if (error) return { index, kind: entry.kind, resource: entry.resource, detail: localize('bulkEdit.create', "Create file"), error };
	const state = await getFileState(entry.resource, dependencies.files, states);
	if (state.exists && entry.existing === "error") return { index, kind: entry.kind, resource: entry.resource, detail: localize('bulkEdit.create', "Create file"), error: localize('bulkEdit.targetExists', "The target already exists.") };
	if (state.exists && state.kind !== FileKind.File) return { index, kind: entry.kind, resource: entry.resource, detail: localize('bulkEdit.create', "Create file"), error: localize('bulkEdit.targetNotFile', "The target is not a regular file.") };
	if (!state.exists || entry.existing === "overwrite") states.set(entry.resource.toString(), { exists: true, kind: FileKind.File, text: entry.contents ?? "", synthetic: true });
	return { index, kind: entry.kind, resource: entry.resource, detail: state.exists ? localize('bulkEdit.createExisting', 'Create file · {0}', existingLabel(entry.existing)) : localize('bulkEdit.create', "Create file") };
}

async function previewRename(entry: Extract<LanguageWorkspaceEditEntry, { kind: "rename" }>, index: number, dependencies: BulkEditPreviewDependencies, states: Map<string, FileState>): Promise<BulkEditPreviewEntry> {
	const sourceError = openResourceError(entry.source, "rename", dependencies.workingCopies) ?? openResourceError(entry.target, "rename", dependencies.workingCopies);
	if (sourceError) return { index, kind: entry.kind, resource: entry.source, secondaryResource: entry.target, detail: localize('bulkEdit.rename', "Rename"), error: sourceError };
	const source = await getFileState(entry.source, dependencies.files, states);
	const target = await getFileState(entry.target, dependencies.files, states);
	if (!source.exists) return { index, kind: entry.kind, resource: entry.source, secondaryResource: entry.target, detail: localize('bulkEdit.rename', "Rename"), error: localize('bulkEdit.sourceMissing', "The source does not exist.") };
	if (source.kind !== FileKind.File) return { index, kind: entry.kind, resource: entry.source, secondaryResource: entry.target, detail: localize('bulkEdit.rename', "Rename"), error: localize('bulkEdit.sourceNotFile', "The source is not a regular file.") };
	if (target.exists && entry.existing === "error") return { index, kind: entry.kind, resource: entry.source, secondaryResource: entry.target, detail: localize('bulkEdit.rename', "Rename"), error: localize('bulkEdit.targetExists', "The target already exists.") };
	if (!target.exists || entry.existing === "overwrite") {
		states.set(entry.source.toString(), { exists: false, synthetic: true });
		states.set(entry.target.toString(), { exists: true, kind: FileKind.File, text: source.text, synthetic: true });
	}
	return { index, kind: entry.kind, resource: entry.source, secondaryResource: entry.target, detail: target.exists ? localize('bulkEdit.renameExisting', 'Rename · {0}', existingLabel(entry.existing)) : localize('bulkEdit.rename', "Rename") };
}

async function previewDelete(entry: Extract<LanguageWorkspaceEditEntry, { kind: "delete" }>, index: number, dependencies: BulkEditPreviewDependencies, states: Map<string, FileState>): Promise<BulkEditPreviewEntry> {
	const error = openResourceError(entry.resource, "delete", dependencies.workingCopies);
	if (error) return { index, kind: entry.kind, resource: entry.resource, detail: localize('bulkEdit.delete', "Delete"), error };
	const state = await getFileState(entry.resource, dependencies.files, states);
	if (!state.exists && entry.missing === "error") return { index, kind: entry.kind, resource: entry.resource, detail: localize('bulkEdit.delete', "Delete"), error: localize('bulkEdit.resourceMissing', "The resource does not exist.") };
	if (!state.exists) {
		states.set(entry.resource.toString(), { exists: false, synthetic: true });
		return { index, kind: entry.kind, resource: entry.resource, detail: localize('bulkEdit.deleteIgnored', "Delete · ignored because it is missing") };
	}
	if (state.kind !== FileKind.File) return { index, kind: entry.kind, resource: entry.resource, detail: localize('bulkEdit.delete', 'Delete'), error: localize('bulkEdit.deleteRegularFile', 'Only regular UTF-8 files can be deleted by this workspace edit.') };
	states.set(entry.resource.toString(), { exists: false, synthetic: true });
	return { index, kind: entry.kind, resource: entry.resource, detail: localize('bulkEdit.delete', "Delete") };
}

async function getFileState(resource: URI, files: IFileService, states: Map<string, FileState>): Promise<FileState> {
	const cached = states.get(resource.toString());
	if (cached) return cached;
	const state = await fileState(resource, files);
	states.set(resource.toString(), state);
	return state;
}

async function fileState(resource: URI, files: IFileService): Promise<FileState> {
	try {
		const stat = await files.stat(resource);
		if (stat.kind !== FileKind.File) return { exists: true, kind: stat.kind, synthetic: false };
		const content = await files.readFile(resource);
		return { exists: true, kind: stat.kind, text: content.content, synthetic: false };
	} catch (error) {
		if (error instanceof FileNotFoundError) return { exists: false, synthetic: false };
		throw error;
	}
}

function openResourceError(resource: URI, operation: 'create' | 'rename' | 'delete', workingCopies: IWorkingCopyService): string | undefined {
	if (workingCopies.get(resource).length === 0) return undefined;
	const labels = {
		create: localize('bulkEdit.operationCreate', 'create'),
		rename: localize('bulkEdit.operationRename', 'rename'),
		delete: localize('bulkEdit.operationDelete', 'delete'),
	};
	return localize('bulkEdit.openResource', 'Cannot {0} an open editor resource.', labels[operation]);
}

function resourceFor(entry: LanguageWorkspaceEditEntry): URI {
	return entry.kind === "rename" ? entry.source : entry.resource;
}

function textChangeSummary(before: string, after: string): string {
	if (before === after) return localize('bulkEdit.noChange', "no textual change");
	const beforeLines = before.split("\n").length;
	const afterLines = after.split("\n").length;
	return localize('bulkEdit.lineChanges', '{0} → {1} lines', beforeLines, afterLines);
}

function existingLabel(value: 'error' | 'overwrite' | 'ignore'): string {
	switch (value) {
		case 'error': return localize('bulkEdit.existingError', 'fail if it exists');
		case 'overwrite': return localize('bulkEdit.existingOverwrite', 'overwrite');
		case 'ignore': return localize('bulkEdit.existingIgnore', 'ignore if it exists');
	}
}
