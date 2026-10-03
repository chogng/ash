import { BulkTextEdits } from './bulkTextEdits.js';
import { BulkFileEdits } from './bulkFileEdits.js';
import { type URI } from '../../../../base/common/uri.js';
import { normalizeTextLineEndings } from '../../../../editor/common/core/textChange.js';
import { TextModel } from '../../../../editor/common/model/textModel.js';
import { ITextModelResourceService, type TextModelReference } from '../../../services/textmodelResolver/common/textModelResourceService.js';
import { FileKind, FileNotFoundError, IFileService } from '../../../../platform/files/common/files.js';
import { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';
import { Disposable, DisposableMap, toDisposable } from "../../../../base/common/lifecycle.js";
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { normalizeLanguageWorkspaceEdit, type LanguageTextDocumentEdit, type LanguageWorkspaceEdit, type LanguageWorkspaceEditEntry, type WorkspaceEdit } from "../../../../editor/common/languages.js";
import { type IBulkEditOptions, type IBulkEditPreviewHandler, type IBulkEditResult, type IBulkEditService, ResourceEdit, ResourceFileEdit, ResourceTextEdit, WorkspaceEditConflictError } from '../../../../editor/browser/services/bulkEditService.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { Extensions, type IConfigurationRegistry, ConfigurationScope } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { getErrorMessage } from '../../../../base/common/errors.js';

const autoSaveSetting = Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration<boolean>({
	key: 'files.refactoring.autoSave',
	defaultValue: true,
	scope: ConfigurationScope.WINDOW,
	schema: { type: 'boolean' },
	parse: value => {
		if (typeof value !== 'boolean') {
			throw new TypeError('files.refactoring.autoSave must be a boolean');
		}
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize('bulkEdit.autoSaveTitle', 'Save files after refactoring'); },
		get description() { return localize('bulkEdit.autoSaveDescription', 'Controls whether files changed by a refactoring are saved automatically.'); },
	},
});

interface WorkspaceEditResult {
	readonly resources: readonly URI[];
	readonly undo: () => Promise<void>;
	readonly states: readonly AppliedResourceState[];
}

interface AcquiredModel {
	readonly reference: TextModelReference;
	readonly wasOpen: boolean;
	version: number;
}

interface VirtualFile {
	exists: boolean;
	text: string | undefined;
	synthetic: boolean;
	document?: AcquiredModel;
	serializedText?: string;
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
interface AppliedResourceState {
	readonly resource: URI;
	readonly expected: VirtualFile;
	readonly textModel: boolean;
	readonly alternativeVersionId?: number;
}

/** Owns preview approval, ordered workspace transactions and their inverse operations. */
export class BulkEditService extends Disposable implements IBulkEditService {
	declare readonly _serviceBrand: undefined;
	private previewHandler: IBulkEditPreviewHandler | undefined;

	private readonly retainedFailedSaves = this._register(new DisposableMap<string, TextModelReference>());
	private readonly undoGroups = new Map<number, { readonly edits: WorkspaceEditResult[]; reverted: boolean }>();

	constructor(
		@ITextModelResourceService private readonly models: ITextModelResourceService,
		@IWorkingCopyService private readonly workingCopies: IWorkingCopyService,
		@IFileService private readonly files: IFileService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IDialogService private readonly dialogs: IDialogService,
	) {
		super();
		this._register(toDisposable(() => {
			this.previewHandler = undefined;
			this.undoGroups.clear();
		}));
	}

	hasPreviewHandler(): boolean {
		return this.previewHandler !== undefined;
	}

	setPreviewHandler(handler: IBulkEditPreviewHandler): ReturnType<typeof toDisposable> {
		this.assertNotDisposed();
		this.previewHandler = handler;
		return toDisposable(() => {
			if (this.previewHandler === handler) this.previewHandler = undefined;
		});
	}

	async apply(value: ResourceEdit[] | WorkspaceEdit | LanguageWorkspaceEdit, options: IBulkEditOptions = {}): Promise<IBulkEditResult> {
		this.assertNotDisposed();
		if (!Array.isArray(value) && 'edits' in value) {
			value = ResourceEdit.convert(value);
		}
		const sourceEdit = Array.isArray(value) ? undefined : normalizeLanguageWorkspaceEdit(value);
		let edits: ResourceEdit[];
		if (Array.isArray(value)) {
			edits = value.map(edit => {
				if (ResourceTextEdit.is(edit)) return ResourceTextEdit.lift(edit);
				if (ResourceFileEdit.is(edit)) return ResourceFileEdit.lift(edit);
				throw new TypeError('Unknown resource edit');
			});
		} else {
			edits = ResourceEdit.convert(sourceEdit!);
		}
		const signal = options.token ?? new AbortController().signal;
		throwIfCancelled(signal);
		if (edits.length === 0) return { ariaSummary: localize('bulkEdit.noneApplied', 'No edits were applied'), isApplied: false };
		let previewed = false;
		if (options.showPreview === true || edits.some(edit => edit.metadata?.needsConfirmation) || (options.showPreview !== false && edits.length > 1 && this.previewHandler)) {
			const previewHandler = this.previewHandler;
			if (!previewHandler) throw new Error("Bulk edit preview is not available");
			edits = await previewHandler(edits, { ...options, token: signal });
			previewed = true;
			if (signal.aborted || edits.length === 0) return { ariaSummary: localize('bulkEdit.noneApplied', 'No edits were applied'), isApplied: false };
		}
		const edit = sourceEdit && !previewed ? sourceEdit : await toLanguageWorkspaceEdit(edits);
		throwIfCancelled(signal);
		if (edit.entries.length === 0) return { ariaSummary: localize('bulkEdit.noneApplied', 'No edits were applied'), isApplied: false };
		// Approval transfers ownership to the transaction. Its own document changes can retire
		// the originating language request, which must not cancel an approved multi-file commit.
		const result: WorkspaceEditResult = await this.applyTransaction(edit, previewed ? new AbortController().signal : signal, options);
		if (result.resources.length === 0) return { ariaSummary: localize('bulkEdit.noneApplied', 'No edits were applied'), isApplied: false };
		let group: { readonly edits: WorkspaceEditResult[]; reverted: boolean };
		if (options.undoRedoGroupId !== undefined) {
			group = this.undoGroups.get(options.undoRedoGroupId) ?? { edits: [], reverted: false };
			group.edits.push(result);
			this.undoGroups.set(options.undoRedoGroupId, group);
		} else {
			group = { edits: [result], reverted: false };
		}
		const undo = async (): Promise<void> => {
			this.assertNotDisposed();
			if (group.reverted) {
				throw new Error('Workspace edit was already reverted');
			}
			if (options.confirmBeforeUndo) {
				const confirmation = await this.dialogs.confirm({
					message: localize('bulkEdit.confirmUndo', 'Undo {0}?', options.label ?? localize('bulkEdit.workspaceEdit', 'Workspace edit')),
					primaryButton: localize('bulkEdit.undo', 'Undo'),
					cancelButton: localize('bulkEdit.cancel', 'Cancel'),
				});
				if (!confirmation.confirmed) {
					return;
				}
			}
			const latest = new Map<string, AppliedResourceState>();
			for (const application of group.edits) {
				for (const state of application.states) {
					latest.set(state.resource.toString(), state);
				}
			}
			await this.verifyAppliedState([...latest.values()]);
			for (const application of [...group.edits].reverse()) {
				await application.undo();
			}
			group.reverted = true;
			if (options.undoRedoGroupId !== undefined) {
				this.undoGroups.delete(options.undoRedoGroupId);
			}
		};
		return { ariaSummary: localize('bulkEdit.resourcesChanged', '{0} resources changed', result.resources.length), isApplied: true, undo, resources: result.resources };
	}

	private async applyTransaction(value: LanguageWorkspaceEdit, signal: AbortSignal, options: IBulkEditOptions): Promise<WorkspaceEditResult> {
		const progress = options.progress;
		const edit = normalizeLanguageWorkspaceEdit(value);
		const states = new Map<string, VirtualFile>();
		const acquired = new Map<string, AcquiredModel>();
		const prepared: PreparedEdit[] = [];
		const touched = new Map<string, URI>();
		try {
			for (const entry of edit.entries) {
				throwIfCancelled(signal, "Workspace edit was cancelled");
				prepared.push(await this.preflight(entry, states, acquired, signal));
			}
			const operations = prepared.filter(operation => operation.kind === 'textDocument' ? operation.before !== operation.after : operation.applies);
			for (const operation of operations) {
				for (const resource of entryResources(operation.entry)) touched.set(resource.toString(), resource);
			}
			const undo: UndoOperation[] = [];
			progress?.report({ total: operations.length, increment: 0 });
			try {
				for (const operation of operations) {
					throwIfCancelled(signal, "Workspace edit was cancelled");
					if (operation.kind === 'textDocument') {
						await new BulkTextEdits(operation, this.models, undo, this.retainedFailedSaves, signal, options.reason).apply();
					} else {
						await new BulkFileEdits(operation, this.files, undo).apply();
					}
					progress?.report({ increment: 1 });
				}
			} catch (error) {
				const rollbackErrors = await rollback(undo);
				if (rollbackErrors.length > 0) throw new AggregateError([error, ...rollbackErrors], "Workspace edit failed and could not be fully rolled back");
				throw error;
			}
			if (options.respectAutoSaveConfig && this.configuration.getValue<boolean>(autoSaveSetting) === true && touched.size > 1) {
				try {
					for (const resource of touched.values()) {
						for (const copy of this.workingCopies.get(resource)) {
							if (copy.isDirty) {
								await copy.save(signal);
							}
						}
					}
				} catch (error) {
					// Working copies own saving after commit. A save failure leaves the edit
					// applied and undoable, including copies that were already saved.
					await this.dialogs.error(localize('bulkEdit.autoSaveFailed', 'The changes were applied, but automatic saving failed: {0}', getErrorMessage(error)));
				}
			}
			const lastKind = new Map<string, PreparedEdit['kind']>();
			for (const operation of operations) {
				for (const resource of entryResources(operation.entry)) lastKind.set(resource.toString(), operation.kind);
			}
			const finalStates = [...touched.values()].map(resource => {
				const textModel = lastKind.get(resource.toString()) === 'textDocument';
				return {
					resource,
					expected: { ...states.get(resource.toString())! },
					textModel,
					...(textModel ? { alternativeVersionId: acquired.get(resource.toString())!.reference.model.getAlternativeVersionId() } : {}),
				};
			});
			let reverted = false;
			return Object.freeze({
				resources: Object.freeze([...touched.values()]),
				states: finalStates,
				undo: async (): Promise<void> => {
					if (reverted) throw new Error('Workspace edit was already reverted');
					await this.verifyAppliedState(finalStates);
					const errors = await rollback(undo);
					if (errors.length > 0) throw new AggregateError(errors, `Workspace edit could not be fully reverted: ${errors.map(String).join('; ')}`);
					reverted = true;
				},
			});
		} finally {
			for (const [key, model] of acquired) {
				if (this.retainedFailedSaves.get(key) === model.reference) continue;
				model.reference.dispose();
			}
		}
	}

	private async verifyAppliedState(resources: readonly AppliedResourceState[]): Promise<void> {
		for (const { resource, expected, textModel, alternativeVersionId } of resources) {
			if (textModel) {
				const reference = await this.models.acquire({ resource }, new AbortController().signal);
				try {
					if (reference.model.getText() !== expected.text || reference.model.getAlternativeVersionId() !== alternativeVersionId) {
						throw new Error(`Workspace edit target '${resource.toString()}' changed before replacement`);
					}
				} finally {
					reference.dispose();
				}
				continue;
			}
			const actual = await this.fileState(resource, new Map());
			if (actual.exists !== expected.exists || (expected.exists && actual.text !== expected.text)) {
				throw new Error(`Workspace edit target '${resource.toString()}' changed before replacement`);
			}
		}
	}

	private async preflight(entry: LanguageWorkspaceEditEntry, states: Map<string, VirtualFile>, acquired: Map<string, AcquiredModel>, signal: AbortSignal): Promise<PreparedEdit> {
		switch (entry.kind) {
			case "textDocument": {
				const state = await this.textState(entry.resource, states, acquired, signal);
				if (!state.exists || state.text === undefined) throw new Error(`Workspace edit target '${entry.resource.toString()}' does not exist`);
				const model = acquired.get(entry.resource.toString())!;
				if (entry.version !== undefined && model.reference.model.version !== entry.version) throw new WorkspaceEditConflictError(`Workspace edit for '${entry.resource.toString()}' is stale`);
				if (entry.expectedText !== undefined && normalizeTextLineEndings(entry.expectedText) !== normalizeTextLineEndings(state.text)) throw new WorkspaceEditConflictError(`Workspace edit content for '${entry.resource.toString()}' is stale`);
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
				if (applies) states.set(entry.resource.toString(), { exists: true, text: entry.contents ?? "", synthetic: true });
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

	private async textState(resource: URI, states: Map<string, VirtualFile>, acquired: Map<string, AcquiredModel>, signal: AbortSignal): Promise<VirtualFile> {
		const key = resource.toString();
		const existing = states.get(key);
		if (existing && !existing.exists) return existing;
		let model = acquired.get(key);
		if (!model) {
			const wasOpen = this.workingCopies.get(resource).length > 0;
			const retained = this.retainedFailedSaves.get(key);
			const reference = retained ?? await this.models.acquire({ resource, ...(existing?.synthetic && existing.text !== undefined ? { initialText: existing.text } : {}) }, signal);
			if (retained) this.retainedFailedSaves.deleteAndLeak(key);
			model = { reference, wasOpen, version: reference.model.version };
			acquired.set(key, model);
		}
		const state: VirtualFile = existing ?? { exists: true, text: model.reference.model.getText(), synthetic: false, document: model };
		if (!state.document && state.text !== undefined) {
			state.serializedText = state.text;
			using snapshot = new TextModel(state.text);
			state.text = snapshot.getText();
			state.document = model;
		}
		if (state.text === undefined) state.text = model.reference.model.getText();
		states.set(key, state);
		return state;
	}

	private async fileState(resource: URI, states: Map<string, VirtualFile>): Promise<VirtualFile> {
		const key = resource.toString();
		const current = states.get(key);
		if (current) {
			if (current.document && current.text !== undefined) {
				// File operations and their inverse use serialized bytes. A model snapshot omits
				// the BOM and normalizes mixed EOLs, so an unchanged document keeps its original bytes.
				const original = current.serializedText ?? (await this.files.readFile(resource)).content;
				current.text = current.text === current.document.reference.model.getText()
					? original
					: (original.startsWith('\uFEFF') ? '\uFEFF' : '') + current.text;
				current.serializedText = current.text;
				delete current.document;
			}
			return current;
		}
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

export async function toLanguageWorkspaceEdit(edits: readonly ResourceEdit[]): Promise<LanguageWorkspaceEdit> {
	const entries: LanguageWorkspaceEditEntry[] = [];
	const groups = new Map<string, { kind: 'textDocument'; resource: ResourceTextEdit['resource']; version?: number; expectedText?: string; edits: ResourceTextEdit['textEdit'][] }>();
	let snapshot: LanguageTextDocumentEdit | undefined;
	const flushText = (): void => {
		entries.push(...groups.values());
		groups.clear();
	};
	for (const edit of edits) {
		if (edit instanceof ResourceTextEdit) {
			const currentSnapshot = edit.snapshot;
			if (snapshot !== currentSnapshot) {
				flushText();
				snapshot = currentSnapshot;
			}
			const key = edit.resource.toString();
			let group = groups.get(key);
			if (!group) {
				group = { kind: 'textDocument', resource: edit.resource, version: edit.versionId, expectedText: snapshot?.expectedText, edits: [] };
				groups.set(key, group);
			} else if (edit.versionId !== undefined) {
				if (group.version !== undefined && group.version !== edit.versionId) throw new Error(`Conflicting workspace edit versions for ${key}`);
				group.version = edit.versionId;
			}
			group.edits.push(edit.textEdit);
			continue;
		}
		flushText();
		snapshot = undefined;
		if (!(edit instanceof ResourceFileEdit)) throw new TypeError('Unknown resource edit');
		if (edit.oldResource && edit.newResource) entries.push({ kind: 'rename', source: edit.oldResource, target: edit.newResource, existing: existing(edit.options) });
		else if (edit.newResource) entries.push({ kind: 'create', resource: edit.newResource, existing: existing(edit.options), ...(edit.options.contents ? { contents: (await edit.options.contents).toString() } : {}) });
		else entries.push({ kind: 'delete', resource: edit.oldResource!, missing: edit.options.ignoreIfNotExists ? 'ignore' : 'error', mode: edit.options.recursive ? 'recursive' : 'fileOrEmptyDirectory' });
	}
	flushText();
	return normalizeLanguageWorkspaceEdit({ entries });
}

function existing(options: ResourceFileEdit['options']): 'error' | 'overwrite' | 'ignore' {
	return options.ignoreIfExists ? 'ignore' : options.overwrite ? 'overwrite' : 'error';
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
