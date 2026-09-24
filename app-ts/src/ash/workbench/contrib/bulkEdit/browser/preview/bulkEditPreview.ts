import { throwIfCancelled } from "../../../../../base/common/cancellation.js";
import { getErrorMessage, isCancellationError } from "../../../../../base/common/errors.js";
import { type URI } from "../../../../../base/common/uri.js";
import { FileKind, FileNotFoundError, type IFileService } from "../../../../../platform/files/common/files.js";
import { normalizeTextLineEndings } from "../../../../../editor/common/core/textChange.js";
import { TextModel } from "../../../../../editor/common/model/textModel.js";
import { type ITextModelResourceService } from "../../../../services/textmodelResolver/common/textModelResourceService.js";
import { normalizeLanguageWorkspaceEdit, type LanguageWorkspaceEdit, type LanguageWorkspaceEditEntry } from "../../../../../editor/common/languages.js";
import { type IWorkingCopyService } from "../../../../services/workingCopy/common/workingCopyService.js";
import { type BulkEditPreviewEntry, type BulkEditPreviewModel } from "../../common/bulkEdit.js";

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
		throwIfCancelled(signal, "Bulk edit preview was cancelled");
		entries.push(await previewEntry(edit.entries[index]!, index, dependencies, states, signal));
	}
	return Object.freeze({ edit, entries: Object.freeze(entries), canApply: entries.length > 0 && entries.every(entry => entry.error === undefined) });
}

async function previewEntry(entry: LanguageWorkspaceEditEntry, index: number, dependencies: BulkEditPreviewDependencies, states: Map<string, FileState>, signal: AbortSignal): Promise<BulkEditPreviewEntry> {
	try {
		switch (entry.kind) {
			case "textDocument":
				return await previewTextDocument(entry, index, dependencies.models, dependencies.files, states, signal);
			case "create":
				return await previewCreate(entry, index, dependencies, states);
			case "rename":
				return await previewRename(entry, index, dependencies, states);
			case "delete":
				return await previewDelete(entry, index, dependencies, states);
		}
	} catch (error) {
		if (isCancellationError(error)) throw error;
		throwIfCancelled(signal, "Bulk edit preview was cancelled");
		return { index, kind: entry.kind, resource: resourceFor(entry), ...(entry.kind === "rename" ? { secondaryResource: entry.target } : {}), detail: "Could not prepare this edit", error: getErrorMessage(error) };
	}
}

async function previewTextDocument(entry: Extract<LanguageWorkspaceEditEntry, { kind: "textDocument" }>, index: number, models: ITextModelResourceService, files: IFileService, states: Map<string, FileState>, signal: AbortSignal): Promise<BulkEditPreviewEntry> {
	const state = await getFileState(entry.resource, files, states);
	if (!state.exists || state.text === undefined) return { index, kind: entry.kind, resource: entry.resource, detail: `${entry.edits.length} text edits`, error: "The edit target does not exist or is not a UTF-8 file." };
	using reference = await models.acquire({ resource: entry.resource, ...(state.synthetic ? { initialText: state.text } : {}) }, signal);
	const before = state.synthetic ? state.text : reference.model.getText();
	if (entry.version !== undefined && reference.model.version !== entry.version) return { index, kind: entry.kind, resource: entry.resource, detail: `${entry.edits.length} text edits`, before, error: "The document changed; this edit is stale." };
	if (entry.expectedText !== undefined && normalizeTextLineEndings(entry.expectedText) !== before) return { index, kind: entry.kind, resource: entry.resource, detail: `${entry.edits.length} text edits`, before, error: "The document content changed; this edit is stale." };
	using snapshot = new TextModel(before);
	snapshot.applyEdits(entry.edits);
	const after = snapshot.getText();
	states.set(entry.resource.toString(), { exists: true, kind: FileKind.File, text: after, synthetic: true });
	return { index, kind: entry.kind, resource: entry.resource, detail: `${entry.edits.length} text ${entry.edits.length === 1 ? "edit" : "edits"} · ${textChangeSummary(before, after)}`, before, after };
}

async function previewCreate(entry: Extract<LanguageWorkspaceEditEntry, { kind: "create" }>, index: number, dependencies: BulkEditPreviewDependencies, states: Map<string, FileState>): Promise<BulkEditPreviewEntry> {
	const error = openResourceError(entry.resource, "create", dependencies.workingCopies);
	if (error) return { index, kind: entry.kind, resource: entry.resource, detail: "Create file", error };
	const state = await getFileState(entry.resource, dependencies.files, states);
	if (state.exists && entry.existing === "error") return { index, kind: entry.kind, resource: entry.resource, detail: "Create file", error: "The target already exists." };
	if (state.exists && state.kind !== FileKind.File) return { index, kind: entry.kind, resource: entry.resource, detail: "Create file", error: "The target is not a regular file." };
	if (!state.exists || entry.existing === "overwrite") states.set(entry.resource.toString(), { exists: true, kind: FileKind.File, text: "", synthetic: true });
	return { index, kind: entry.kind, resource: entry.resource, detail: state.exists ? `Create file · ${entry.existing}` : "Create file" };
}

async function previewRename(entry: Extract<LanguageWorkspaceEditEntry, { kind: "rename" }>, index: number, dependencies: BulkEditPreviewDependencies, states: Map<string, FileState>): Promise<BulkEditPreviewEntry> {
	const sourceError = openResourceError(entry.source, "rename", dependencies.workingCopies) ?? openResourceError(entry.target, "rename", dependencies.workingCopies);
	if (sourceError) return { index, kind: entry.kind, resource: entry.source, secondaryResource: entry.target, detail: "Rename", error: sourceError };
	const source = await getFileState(entry.source, dependencies.files, states);
	const target = await getFileState(entry.target, dependencies.files, states);
	if (!source.exists) return { index, kind: entry.kind, resource: entry.source, secondaryResource: entry.target, detail: "Rename", error: "The source does not exist." };
	if (source.kind !== FileKind.File) return { index, kind: entry.kind, resource: entry.source, secondaryResource: entry.target, detail: "Rename", error: "The source is not a regular file." };
	if (target.exists && entry.existing === "error") return { index, kind: entry.kind, resource: entry.source, secondaryResource: entry.target, detail: "Rename", error: "The target already exists." };
	if (!target.exists || entry.existing === "overwrite") {
		states.set(entry.source.toString(), { exists: false, synthetic: true });
		states.set(entry.target.toString(), { exists: true, kind: FileKind.File, text: source.text, synthetic: true });
	}
	return { index, kind: entry.kind, resource: entry.source, secondaryResource: entry.target, detail: target.exists ? `Rename · ${entry.existing}` : "Rename" };
}

async function previewDelete(entry: Extract<LanguageWorkspaceEditEntry, { kind: "delete" }>, index: number, dependencies: BulkEditPreviewDependencies, states: Map<string, FileState>): Promise<BulkEditPreviewEntry> {
	const error = openResourceError(entry.resource, "delete", dependencies.workingCopies);
	if (error) return { index, kind: entry.kind, resource: entry.resource, detail: "Delete", error };
	const state = await getFileState(entry.resource, dependencies.files, states);
	if (!state.exists && entry.missing === "error") return { index, kind: entry.kind, resource: entry.resource, detail: "Delete", error: "The resource does not exist." };
	if (!state.exists) {
		states.set(entry.resource.toString(), { exists: false, synthetic: true });
		return { index, kind: entry.kind, resource: entry.resource, detail: "Delete · ignored because it is missing" };
	}
	states.set(entry.resource.toString(), { exists: false, synthetic: true });
	return { index, kind: entry.kind, resource: entry.resource, detail: state.kind === FileKind.Directory && entry.mode === "recursive" ? "Delete directory recursively" : "Delete" };
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

function openResourceError(resource: URI, operation: string, workingCopies: IWorkingCopyService): string | undefined {
	if (workingCopies.get(resource).length > 0) return `Cannot ${operation} an open editor resource.`;
	return undefined;
}

function resourceFor(entry: LanguageWorkspaceEditEntry): URI {
	return entry.kind === "rename" ? entry.source : entry.resource;
}

function textChangeSummary(before: string, after: string): string {
	if (before === after) return "no textual change";
	const beforeLines = before.split("\n").length;
	const afterLines = after.split("\n").length;
	return `${beforeLines} → ${afterLines} lines`;
}
