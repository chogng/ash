import { throwIfCancelled } from "../../../../base/common/cancellation.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { type URI } from "../../../../base/common/uri.js";
import { normalizeTextLineEndings } from "../../../../editor/common/core/textChange.js";
import { normalizeLanguageWorkspaceEdit, type LanguageTextDocumentEdit, type LanguageWorkspaceEdit, type LanguageWorkspaceEditEntry } from "../../../../editor/common/languages/languageWorkspaceEdit.js";
import { TextModel } from "../../../../editor/common/model/textModel.js";
import { type ITextModelResourceService, type TextModelReference } from "../../../../editor/common/services/textModelResourceService.js";
import { FileKind, FileNotFoundError, type IFileService } from "../../../../platform/files/common/files.js";
import { type IWorkingCopyService } from "../../workingCopy/common/workingCopyService.js";
import { type IWorkspaceEditService, type WorkspaceEditResult } from "../common/workspaceEditService.js";

interface AcquiredModel {
	readonly reference: TextModelReference;
	readonly wasOpen: boolean;
}

interface VirtualFile {
	exists: boolean;
	text: string | undefined;
	synthetic: boolean;
}

interface PreparedTextEdit {
	readonly kind: "textDocument";
	readonly entry: LanguageTextDocumentEdit;
	readonly model: AcquiredModel;
	readonly before: string;
	readonly after: string;
}

interface PreparedResourceEdit {
	readonly kind: "create" | "rename" | "delete";
	readonly entry: Exclude<LanguageWorkspaceEditEntry, LanguageTextDocumentEdit>;
	readonly applies: boolean;
	readonly sourceBefore?: string;
	readonly targetBefore?: string;
}

type PreparedEdit = PreparedTextEdit | PreparedResourceEdit;
type UndoOperation = () => Promise<void>;

/** Workbench owner for ordered, preflighted workspace edits with best-effort undo on failure. */
export class BrowserWorkspaceEditService extends Disposable implements IWorkspaceEditService {
	private readonly retainedFailedSaves = new Map<string, TextModelReference>();

	constructor(private readonly models: ITextModelResourceService, private readonly workingCopies: IWorkingCopyService, private readonly files: IFileService) {
		super();
		this._register(toDisposable(() => {
			for (const reference of this.retainedFailedSaves.values()) reference.dispose();
			this.retainedFailedSaves.clear();
		}));
	}

	async apply(value: LanguageWorkspaceEdit, signal: AbortSignal = new AbortController().signal): Promise<WorkspaceEditResult> {
		const edit = normalizeLanguageWorkspaceEdit(value);
		const states = new Map<string, VirtualFile>();
		const acquired = new Map<string, AcquiredModel>();
		const prepared: PreparedEdit[] = [];
		const touched = new Map<string, URI>();
		try {
			for (const entry of edit.entries) {
				throwIfCancelled(signal, "Workspace edit was cancelled");
				for (const resource of entryResources(entry)) touched.set(resource.toString(), resource);
				prepared.push(await this.preflight(entry, states, acquired, signal));
			}
			const undo: UndoOperation[] = [];
			try {
				for (const operation of prepared) {
					throwIfCancelled(signal, "Workspace edit was cancelled");
					await this.execute(operation, undo, signal);
				}
			} catch (error) {
				const rollbackErrors = await rollback(undo);
				if (rollbackErrors.length > 0) throw new AggregateError([error, ...rollbackErrors], "Workspace edit failed and could not be fully rolled back");
				throw error;
			}
			return Object.freeze({ resources: Object.freeze([...touched.values()]) });
		} finally {
			for (const [key, model] of acquired) {
				if (this.retainedFailedSaves.get(key) === model.reference) continue;
				model.reference.dispose();
			}
		}
	}

	private async preflight(entry: LanguageWorkspaceEditEntry, states: Map<string, VirtualFile>, acquired: Map<string, AcquiredModel>, signal: AbortSignal): Promise<PreparedEdit> {
		switch (entry.kind) {
			case "textDocument": {
				const state = await this.textState(entry.resource, states, acquired, signal);
				if (!state.exists || state.text === undefined) throw new Error(`Workspace edit target '${entry.resource.toString()}' does not exist`);
				const model = acquired.get(entry.resource.toString())!;
				if (entry.version !== undefined && model.reference.model.version !== entry.version) throw new Error(`Workspace edit for '${entry.resource.toString()}' is stale`);
				if (entry.expectedText !== undefined && normalizeTextLineEndings(entry.expectedText) !== state.text) throw new Error(`Workspace edit content for '${entry.resource.toString()}' is stale`);
				using snapshot = new TextModel(state.text);
				for (const edit of entry.edits) {
					if (!snapshot.isValidRange(edit.range)) throw new Error("Workspace edit range is outside the document: " + entry.resource.toString());
				}
				snapshot.applyEdits(entry.edits);
				const before = state.text;
				const after = snapshot.getText();
				state.text = after;
				return { kind: "textDocument", entry, model, before, after };
			}
			case "create": {
				this.requireClosed(entry.resource, "create");
				const target = await this.fileState(entry.resource, states);
				if (target.exists && entry.existing === "error") throw new Error(`Workspace create target '${entry.resource.toString()}' already exists`);
				const applies = !target.exists || entry.existing === "overwrite";
				const targetBefore = target.exists ? target.text : undefined;
				if (applies) states.set(entry.resource.toString(), { exists: true, text: "", synthetic: true });
				return { kind: entry.kind, entry, applies, targetBefore };
			}
			case "rename": {
				this.requireClosed(entry.source, "rename");
				this.requireClosed(entry.target, "rename");
				const source = await this.fileState(entry.source, states);
				const target = await this.fileState(entry.target, states);
				if (!source.exists || source.text === undefined) throw new Error(`Workspace rename source '${entry.source.toString()}' does not exist or is not a UTF-8 file`);
				if (target.exists && entry.existing === "error") throw new Error(`Workspace rename target '${entry.target.toString()}' already exists`);
				const applies = !target.exists || entry.existing === "overwrite";
				const targetBefore = target.exists ? target.text : undefined;
				if (applies) {
					states.set(entry.source.toString(), { exists: false, text: undefined, synthetic: true });
					states.set(entry.target.toString(), { exists: true, text: source.text, synthetic: true });
				}
				return { kind: entry.kind, entry, applies, sourceBefore: source.text, targetBefore };
			}
			case "delete": {
				this.requireClosed(entry.resource, "delete");
				const source = await this.fileState(entry.resource, states);
				if (!source.exists && entry.missing === "error") throw new Error(`Workspace delete target '${entry.resource.toString()}' does not exist`);
				const applies = source.exists;
				if (applies && source.text === undefined) throw new Error(`Workspace delete target '${entry.resource.toString()}' is not a UTF-8 file`);
				if (applies) states.set(entry.resource.toString(), { exists: false, text: undefined, synthetic: true });
				return { kind: entry.kind, entry, applies, sourceBefore: source.text };
			}
		}
	}

	private async execute(operation: PreparedEdit, undo: UndoOperation[], signal: AbortSignal): Promise<void> {
		if (operation.kind === "textDocument") {
			const { entry, model, before, after } = operation;
			if (model.reference.model.getText() !== before) throw new Error(`Workspace edit content for '${entry.resource.toString()}' changed during application`);
			model.reference.model.applyEdits(entry.edits);
			undo.push(async () => {
				model.reference.model.reset(before);
				if (!model.wasOpen) {
					await model.reference.save(new AbortController().signal);
					this.retainedFailedSaves.delete(entry.resource.toString());
				}
			});
			if (!model.wasOpen) {
				try {
					await model.reference.save(signal);
				} catch (error) {
					this.retainedFailedSaves.set(entry.resource.toString(), model.reference);
					throw error;
				}
			}
			if (model.reference.model.getText() !== after) throw new Error(`Workspace edit for '${entry.resource.toString()}' produced an inconsistent result`);
			return;
		}
		if (!operation.applies) return;
		switch (operation.kind) {
			case "create": {
				const entry = operation.entry;
				if (entry.kind !== "create") throw new Error("Invalid prepared workspace create");
				await this.files.createFile(entry.resource, entry.existing);
				undo.push(operation.targetBefore === undefined
					? () => this.files.delete(entry.resource, "ignore", "fileOrEmptyDirectory")
					: () => this.files.writeFile({ resource: entry.resource, content: operation.targetBefore! }).then(() => undefined));
				return;
			}
			case "rename": {
				const entry = operation.entry;
				if (entry.kind !== "rename") throw new Error("Invalid prepared workspace rename");
				await this.files.rename(entry.source, entry.target, entry.existing);
				undo.push(async () => {
					await this.files.rename(entry.target, entry.source, "overwrite");
					if (operation.targetBefore !== undefined) await this.files.writeFile({ resource: entry.target, content: operation.targetBefore });
				});
				return;
			}
			case "delete": {
				const entry = operation.entry;
				if (entry.kind !== "delete") throw new Error("Invalid prepared workspace delete");
				await this.files.delete(entry.resource, entry.missing, entry.mode);
				undo.push(async () => {
					await this.files.createFile(entry.resource, "overwrite");
					await this.files.writeFile({ resource: entry.resource, content: operation.sourceBefore! });
				});
			}
		}
	}

	private async textState(resource: URI, states: Map<string, VirtualFile>, acquired: Map<string, AcquiredModel>, signal: AbortSignal): Promise<VirtualFile> {
		const key = resource.toString();
		const existing = states.get(key);
		if (existing && !existing.exists) return existing;
		let model = acquired.get(key);
		if (!model) {
			const wasOpen = this.workingCopies.get(resource).length > 0;
			const retained = this.retainedFailedSaves.get(key);
			const reference = retained ?? await this.models.acquire({ resource, ...(existing?.synthetic && existing.text !== undefined ? { initialText: existing.text } : {}) }, signal);
			if (retained) this.retainedFailedSaves.delete(key);
			model = { reference, wasOpen };
			acquired.set(key, model);
		}
		const state = existing ?? { exists: true, text: model.reference.model.getText(), synthetic: false };
		if (state.text === undefined) state.text = model.reference.model.getText();
		states.set(key, state);
		return state;
	}

	private async fileState(resource: URI, states: Map<string, VirtualFile>): Promise<VirtualFile> {
		const key = resource.toString();
		const current = states.get(key);
		if (current) return current;
		try {
			const stat = await this.files.stat(resource);
			if (stat.kind !== FileKind.File) return { exists: true, text: undefined, synthetic: false };
			const content = await this.files.readFile(resource);
			const state = { exists: true, text: content.content, synthetic: false };
			states.set(key, state);
			return state;
		} catch (error) {
			if (!(error instanceof FileNotFoundError)) throw error;
			const state = { exists: false, text: undefined, synthetic: false };
			states.set(key, state);
			return state;
		}
	}

	private requireClosed(resource: URI, operation: string): void {
		if (this.workingCopies.get(resource).length > 0) throw new Error(`Cannot ${operation} open editor resource '${resource.toString()}'`);
	}
}

function entryResources(entry: LanguageWorkspaceEditEntry): readonly URI[] {
	return entry.kind === "rename" ? [entry.source, entry.target] : [entry.resource];
}

async function rollback(operations: readonly UndoOperation[]): Promise<unknown[]> {
	const errors: unknown[] = [];
	for (let index = operations.length - 1; index >= 0; index--) {
		try { await operations[index]!(); } catch (error) { errors.push(error); }
	}
	return errors;
}
