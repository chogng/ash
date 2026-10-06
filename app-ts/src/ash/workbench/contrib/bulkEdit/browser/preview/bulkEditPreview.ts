import { throwIfCancelled } from "../../../../../base/common/cancellation.js";
import { getErrorMessage, isCancellationError } from "../../../../../base/common/errors.js";
import { type URI } from "../../../../../base/common/uri.js";
import { FileKind, FileNotFoundError, IFileService } from "../../../../../platform/files/common/files.js";
import { normalizeTextLineEndings } from "../../../../../editor/common/core/textChange.js";
import { TextModel } from "../../../../../editor/common/model/textModel.js";
import { ITextModelResourceService } from "../../../../services/textmodelResolver/common/textModelResourceService.js";
import { normalizeLanguageWorkspaceEdit, type LanguageWorkspaceEdit, type LanguageWorkspaceEditEntry, type TextEdit } from "../../../../../editor/common/languages.js";
import { IWorkingCopyService } from "../../../../services/workingCopy/common/workingCopyService.js";
import { localize } from '../../../../../nls.js';
import { ConflictDetector } from '../conflicts.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../../base/common/event.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ResourceEdit, ResourceTextEdit } from '../../../../../editor/browser/services/bulkEditService.js';
import { toLanguageWorkspaceEdit } from '../bulkEditService.js';


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
interface PreviewSnapshot {
	readonly edit: LanguageWorkspaceEdit;
	readonly entries: readonly BulkEditPreviewEntry[];
	readonly canApply: boolean;
}
interface PreviewDependencies {
	readonly files: IFileService;
	readonly models: ITextModelResourceService;
	readonly workingCopies: IWorkingCopyService;
}

/** Selection is owned by the edit identities, so regrouping cannot change approval. */
export class CheckedStates<T extends object> extends Disposable {
	private readonly states = new WeakMap<T, boolean>();
	private count = 0;
	private readonly changes = this._register(new Emitter<T>());
	public readonly onDidChange = this.changes.event;
	public get checkedCount(): number { return this.count; }
	public isChecked(edit: T): boolean { return this.states.get(edit) === true; }
	public updateChecked(edit: T, checked: boolean): void {
		if (this.isChecked(edit) === checked) { return; }
		this.states.set(edit, checked);
		this.count += checked ? 1 : -1;
		this.changes.fire(edit);
	}
}

/** Owns immutable document steps, approval state and the preview conflict lifetime. */
export class BulkFileOperations extends Disposable {
	public readonly checked = this._register(new CheckedStates<ResourceEdit>());
	public readonly conflicts: ConflictDetector;
	private snapshot: PreviewSnapshot | undefined;
	private readonly editsByEntry: ResourceEdit[][] = [];
	constructor(
		private readonly bulkEdit: ResourceEdit[],
		@IFileService private readonly files: IFileService,
		@ITextModelResourceService private readonly models: ITextModelResourceService,
		@IWorkingCopyService private readonly workingCopies: IWorkingCopyService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		this.conflicts = this._register(instantiation.createInstance(ConflictDetector, bulkEdit));
	}
	public static async create(accessor: ServicesAccessor, bulkEdit: ResourceEdit[], signal: AbortSignal = new AbortController().signal): Promise<BulkFileOperations> {
		const model = accessor.get(IInstantiationService).createInstance(BulkFileOperations, bulkEdit);
		try {
			const edit = await toLanguageWorkspaceEdit(bulkEdit);
			model.snapshot = await createBulkEditPreview(edit, { files: model.files, models: model.models, workingCopies: model.workingCopies }, signal);
			let fileIndex = 0;
			const fileEdits = bulkEdit.filter(edit => !(edit instanceof ResourceTextEdit));
			const textEdits = new Map<string, Map<TextEdit, { edits: ResourceTextEdit[]; next: number; }>>();
			for (const edit of bulkEdit) {
				if (!(edit instanceof ResourceTextEdit)) { continue; }
				const key = edit.resource.toString();
				let byPayload = textEdits.get(key);
				if (!byPayload) {
					byPayload = new Map();
					textEdits.set(key, byPayload);
				}
				let occurrences = byPayload.get(edit.textEdit);
				if (!occurrences) {
					occurrences = { edits: [], next: 0 };
					byPayload.set(edit.textEdit, occurrences);
				}
				occurrences.edits.push(edit);
			}
			for (const entry of model.edit.entries) {
				model.editsByEntry.push(entry.kind === 'textDocument'
					? entry.edits.map(text => {
						const occurrences = textEdits.get(entry.resource.toString())!.get(text)!;
						return occurrences.edits[occurrences.next++]!;
					})
					: [fileEdits[fileIndex++]!]);
			}
			model.selectAll();
			return model;
		} catch (error) {
			model.dispose();
			throw error;
		}
	}
	public get edit(): LanguageWorkspaceEdit { return this.snapshot!.edit; }
	public get entries(): readonly BulkEditPreviewEntry[] { return this.snapshot!.entries; }
	public get canApply(): boolean { return this.snapshot!.canApply; }
	public isChecked(index: number): boolean { return this.editsByEntry[index]!.some(edit => this.checked.isChecked(edit)); }
	public selectedTextIndices(index: number): Set<number> {
		return new Set(this.editsByEntry[index]!.flatMap((edit, index) => this.checked.isChecked(edit) ? [index] : []));
	}
	public selectedTextEdits(index: number): readonly TextEdit[] {
		const entry = this.edit.entries[index]!;
		if (entry.kind !== 'textDocument') { return []; }
		return entry.edits.filter((_edit, editIndex) => this.checked.isChecked(this.editsByEntry[index]![editIndex]!));
	}
	public selectAll(): void {
		for (const entry of this.entries) {
			for (const edit of this.editsByEntry[entry.index]!) {
				this.checked.updateChecked(edit, entry.error === undefined);
			}
		}
	}
	public updateChecked(index: number, checked: boolean, textIndex?: number): void {
		const entry = this.edit.entries[index]!;
		if (textIndex !== undefined) {
			this.checked.updateChecked(this.editsByEntry[index]![textIndex]!, checked);
			return;
		}
		for (const edit of this.editsByEntry[index]!) { this.checked.updateChecked(edit, checked); }
		const resources = relatedResources(entry, this.edit.entries);
		this.edit.entries.forEach((candidate, candidateIndex) => {
			if ((entry.kind !== 'textDocument' || checked && candidate.kind !== 'textDocument') && entryResources(candidate).some(resource => resources.has(resource)) && this.entries[candidateIndex]!.error === undefined) {
				for (const edit of this.editsByEntry[candidateIndex]!) { this.checked.updateChecked(edit, checked); }
			}
		});
	}
	public getWorkspaceEdit(): ResourceEdit[] { return this.bulkEdit.filter(edit => this.checked.isChecked(edit)); }
	public hasSelectionDependencyError(): boolean {
		const contents = new Map<string, string>();
		for (const preview of this.entries) {
			const entry = this.edit.entries[preview.index]!;
			if (entry.kind !== 'textDocument') {
				if (this.isChecked(preview.index)) { for (const resource of entryResources(entry)) { contents.delete(resource); } }
				continue;
			}
			if (preview.before === undefined) { continue; }
			const key = entry.resource.toString();
			const before = contents.get(key) ?? preview.before;
			contents.set(key, before);
			if (!this.isChecked(preview.index)) { continue; }
			// Later ordered steps are meaningful only against their captured predecessor.
			if (normalizeTextLineEndings(before) !== normalizeTextLineEndings(preview.before)) { return true; }
			using snapshot = new TextModel(before);
			snapshot.applyEdits(this.selectedTextEdits(preview.index));
			contents.set(key, snapshot.getText());
		}
		return false;
	}
}

function entryResources(entry: LanguageWorkspaceEditEntry): readonly string[] {
	return entry.kind === 'rename' ? [entry.source.toString(), entry.target.toString()] : [entry.resource.toString()];
}

function relatedResources(entry: LanguageWorkspaceEditEntry, entries: readonly LanguageWorkspaceEditEntry[]): Set<string> {
	const resources = new Set(entryResources(entry));
	let previousSize: number;
	do {
		previousSize = resources.size;
		for (const candidate of entries) {
			if (candidate.kind === 'rename' && entryResources(candidate).some(resource => resources.has(resource))) {
				for (const resource of entryResources(candidate)) { resources.add(resource); }
			}
		}
	} while (resources.size !== previousSize);
	return resources;
}

interface FileState {
	readonly exists: boolean;
	readonly kind?: FileKind;
	readonly text?: string;
	readonly synthetic?: boolean;
}

/** Materializes a safe, selectable summary without mutating any editor or file. */
async function createBulkEditPreview(value: LanguageWorkspaceEdit, dependencies: PreviewDependencies, signal: AbortSignal): Promise<PreviewSnapshot> {
	const edit = normalizeLanguageWorkspaceEdit(value);
	const states = new Map<string, FileState>();
	const entries: BulkEditPreviewEntry[] = [];
	for (let index = 0; index < edit.entries.length; index++) {
		throwIfCancelled(signal, localize('bulkEdit.previewCancelled', "Bulk edit preview was cancelled"));
		entries.push(await previewEntry(edit.entries[index]!, index, dependencies, states, signal));
	}
	return Object.freeze({ edit, entries: Object.freeze(entries), canApply: entries.length > 0 && entries.every(entry => entry.error === undefined) });
}

async function previewEntry(entry: LanguageWorkspaceEditEntry, index: number, dependencies: PreviewDependencies, states: Map<string, FileState>, signal: AbortSignal): Promise<BulkEditPreviewEntry> {
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

async function previewTextDocument(entry: Extract<LanguageWorkspaceEditEntry, { kind: "textDocument"; }>, index: number, dependencies: PreviewDependencies, states: Map<string, FileState>, signal: AbortSignal): Promise<BulkEditPreviewEntry> {
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

async function previewCreate(entry: Extract<LanguageWorkspaceEditEntry, { kind: "create"; }>, index: number, dependencies: PreviewDependencies, states: Map<string, FileState>): Promise<BulkEditPreviewEntry> {
	const error = openResourceError(entry.resource, "create", dependencies.workingCopies);
	if (error) return { index, kind: entry.kind, resource: entry.resource, detail: localize('bulkEdit.create', "Create file"), error };
	const state = await getFileState(entry.resource, dependencies.files, states);
	if (state.exists && entry.existing === "error") return { index, kind: entry.kind, resource: entry.resource, detail: localize('bulkEdit.create', "Create file"), error: localize('bulkEdit.targetExists', "The target already exists.") };
	if (state.exists && state.kind !== FileKind.File) return { index, kind: entry.kind, resource: entry.resource, detail: localize('bulkEdit.create', "Create file"), error: localize('bulkEdit.targetNotFile', "The target is not a regular file.") };
	if (!state.exists || entry.existing === "overwrite") states.set(entry.resource.toString(), { exists: true, kind: FileKind.File, text: entry.contents ?? "", synthetic: true });
	return { index, kind: entry.kind, resource: entry.resource, detail: state.exists ? localize('bulkEdit.createExisting', 'Create file · {0}', existingLabel(entry.existing)) : localize('bulkEdit.create', "Create file"), before: state.text ?? '', after: state.exists && entry.existing === 'ignore' ? state.text : entry.contents ?? '' };
}

async function previewRename(entry: Extract<LanguageWorkspaceEditEntry, { kind: "rename"; }>, index: number, dependencies: PreviewDependencies, states: Map<string, FileState>): Promise<BulkEditPreviewEntry> {
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
	return { index, kind: entry.kind, resource: entry.source, secondaryResource: entry.target, detail: target.exists ? localize('bulkEdit.renameExisting', 'Rename · {0}', existingLabel(entry.existing)) : localize('bulkEdit.rename', "Rename"), before: source.text, after: source.text };
}

async function previewDelete(entry: Extract<LanguageWorkspaceEditEntry, { kind: "delete"; }>, index: number, dependencies: PreviewDependencies, states: Map<string, FileState>): Promise<BulkEditPreviewEntry> {
	const error = openResourceError(entry.resource, "delete", dependencies.workingCopies);
	if (error) return { index, kind: entry.kind, resource: entry.resource, detail: localize('bulkEdit.delete', "Delete"), error };
	const state = await getFileState(entry.resource, dependencies.files, states);
	if (!state.exists && entry.missing === "error") return { index, kind: entry.kind, resource: entry.resource, detail: localize('bulkEdit.delete', "Delete"), error: localize('bulkEdit.resourceMissing', "The resource does not exist.") };
	if (!state.exists) {
		states.set(entry.resource.toString(), { exists: false, synthetic: true });
		return { index, kind: entry.kind, resource: entry.resource, detail: localize('bulkEdit.deleteIgnored', "Delete · ignored because it is missing"), before: '', after: '' };
	}
	if (state.kind !== FileKind.File) return { index, kind: entry.kind, resource: entry.resource, detail: localize('bulkEdit.delete', 'Delete'), error: localize('bulkEdit.deleteRegularFile', 'Only regular UTF-8 files can be deleted by this workspace edit.') };
	states.set(entry.resource.toString(), { exists: false, synthetic: true });
	return { index, kind: entry.kind, resource: entry.resource, detail: localize('bulkEdit.delete', "Delete"), before: state.text, after: '' };
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
