import { TextModelChangeReason } from '../../../editor/common/core/textChange.js';
import { IModelService } from '../../../editor/common/services/model.js';
import type { ITextModel } from '../../../editor/common/model.js';
import { isAiEdit } from '../../../editor/common/textModelEditSource.js';
import { extUriBiasedIgnorePathCase } from '../../../base/common/resources.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import type { ExtensionClientSource, ExtensionHostFleetSnapshot } from '../../../platform/agentHost/common/extensionHostApi.js';
import { localize, getNLSLanguage } from '../../../nls.js';
import { IMarkerService } from '../../../platform/markers/common/markers.js';
import { MarkerSeverity } from '../../../platform/markers/common/markers.js';
import { URI } from '../../../base/common/uri.js';
import { IEditorService } from '../../services/editor/common/editorService.js';
import { IEditorPart } from '../../browser/parts/editor/editorPart.js';
import { IQuickInputService } from '../../../platform/quickinput/common/quickInput.js';
import { DialogSeverity, IDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { IWorkspaceOpenService } from '../../services/workspaces/browser/workspaceOpenService.js';
import { IWorkingCopyService } from '../../services/workingCopy/common/workingCopyService.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IViewsService } from '../../services/views/common/viewsService.js';
import { IClipboardService } from '../../../platform/clipboard/common/clipboardService.js';
import { IOpenerService } from '../../../platform/opener/common/opener.js';
import { normalizeExtensionHostPayload } from '../../../platform/agentHost/browser/extensionHostProtocol.js';
import { type JsonValue } from '../../../platform/agentHost/common/extensionHostApi.js';
import type { IResourceEditorInput } from '../../common/editor.js';
import { isEditorPaneWithSelection } from '../../common/editor.js';
import { parseExtensionEditorInput } from './mainThreadEditorInput.js';
import { TextEditorSelectionSource } from '../../../platform/editor/common/editor.js';
import type { EditorOpenOptions } from '../../services/editor/common/editorService.js';
import { CancellationTokenSource } from '../../../base/common/cancellation.js';
import { ICodeEditorService } from '../../../editor/browser/services/codeEditorService.js';
import { MainThreadEditorChanges } from './mainThreadEditorChanges.js';
import { Range } from '../../../editor/common/core/range.js';
import { ITextFileService } from '../../services/textfile/common/textfiles.js';
import { IPathService } from '../../../platform/path/common/pathService.js';
/** Editor models, working copies and UI always stay in the client. */
export class MainThreadEditors extends Disposable {
	private readonly editSources = this._register(new DisposableMap<string, DisposableStore>());
	private readonly aiEdited = new Map<ITextModel, { version: number; chat: boolean; }>();
	private trackModel(model: ITextModel): void {
		const lifetime = new DisposableStore();
		this.editSources.set(model.uri.toString(), lifetime);
		lifetime.add(model.onDidChangeContent(event => {
			const reasons = event.detailedReasons.filter(isAiEdit);
			if (!reasons.length || event.reason === TextModelChangeReason.Undo || event.reason === TextModelChangeReason.Reset) this.aiEdited.delete(model);
			else this.aiEdited.set(model, { version: event.version, chat: reasons.some(reason => reason.metadata.source === 'Chat.applyEdits' || reason.metadata.source === 'inlineChat.applyEdits') });
		}));
		lifetime.add(toDisposable(() => this.aiEdited.delete(model)));
	}
	private readonly annotations = this._register(new DisposableMap<string, DisposableStore>());
	public updateSources(snapshot: ExtensionHostFleetSnapshot): void {
		const active = new Set(snapshot.extensions.filter(extension => extension.lifecycle === 'ready').map(extension => JSON.stringify([extension.id, extension.incarnation, extension.activationGeneration])));
		for (const key of this.annotations.keys()) if (!active.has(key)) this.annotations.deleteAndDispose(key);
	}
	public clearAnnotations(): void { this.annotations.clearAndDisposeAll(); }

	constructor(
		@IEditorService
		private readonly editors: IEditorService,
		@IEditorPart
		private readonly part: IEditorPart,
		@IQuickInputService
		private readonly quickInput: IQuickInputService,
		@IDialogService
		private readonly dialogs: IDialogService,
		@IWorkspaceOpenService
		private readonly workspace: IWorkspaceOpenService,
		@IWorkingCopyService
		private readonly workingCopies: IWorkingCopyService,
		@IInstantiationService
		private readonly instantiation: IInstantiationService,
		@IClipboardService
		private readonly clipboard: IClipboardService,
		@IOpenerService
		private readonly opener: IOpenerService,
		@ICodeEditorService
		private readonly codeEditors: ICodeEditorService,
		@ITextFileService
		private readonly files: ITextFileService,
		@IModelService private readonly models: IModelService,
		@IPathService private readonly paths: IPathService) {
		super();
		for (const model of models.getModels()) this.trackModel(model);
		this._register(models.onModelAdded(model => this.trackModel(model)));
		this._register(models.onModelRemoved(model => this.editSources.deleteAndDispose(model.uri.toString())));
	}
	public async handle(value: JsonValue, signal: AbortSignal, source?: ExtensionClientSource): Promise<JsonValue> {
		const request = record(value);
		signal.throwIfAborted();
		switch (request.method) {
			case 'aiEditedResources': {
				const root = URI.parse(text(request.root));
				if (request.mode !== 'all' && request.mode !== 'chatAndAgent') throw new TypeError('Invalid AI edit scope');
				const entries: JsonValue[] = [];
				let bytes = 0;
				for (const [model, evidence] of this.aiEdited) {
					if (evidence.version !== model.getVersionId() || request.mode !== 'all' && !evidence.chat || !extUriBiasedIgnorePathCase.isEqualOrParent(model.uri, root)) continue;
					const contents = model.getValue();
					bytes += new TextEncoder().encode(contents).byteLength;
					if (bytes > 256 * 1024 || entries.length >= 100) throw new RangeError('AI edit evidence exceeds the payload limit');
					entries.push({ uri: model.uri.toString(), text: contents });
				}
				return entries;
			}
			case 'setLineAnnotation': {
				if (!source) throw new Error('Missing extension source');
				const key = JSON.stringify([source.extensionId, source.incarnation, source.activationGeneration]);
				this.annotations.deleteAndDispose(key);
				if (request.uri == null || request.text === '') return null;
				const resource = URI.parse(text(request.uri));
				const line = positiveInteger(request.line);
				const label = text(request.text, 4096).replace(/[\r\n]/g, ' ');
				const editor = this.codeEditors.getActiveCodeEditor();
				const model = editor?.getModel();
				if (!editor || !model || !extUriBiasedIgnorePathCase.isEqual(model.uri, resource) || line > model.getLineCount() || request.version !== undefined && request.version !== model.getVersionId()) return null;
				const owner = new DisposableStore();
				this.annotations.set(key, owner);
				const type = `extension.annotation.${key}`;
				owner.add(this.codeEditors.registerDecorationType('Extension line annotation', type, { after: { contentText: `  ${label}`, color: { id: 'editorGhostText.foreground' }, fontStyle: 'italic' } }));
				const options = this.codeEditors.resolveDecorationOptions(type, true);
				const collection = editor.createDecorationsCollection([{ range: new Range(line, model.getLineMaxColumn(line), line, model.getLineMaxColumn(line)), options: { ...options, hoverMessage: request.hover == null ? undefined : { value: text(request.hover, 16384), isTrusted: false, supportHtml: false } } }]);
				owner.add(toDisposable(() => collection.clear()));
				owner.add(editor.onDidChangeModel(() => this.annotations.deleteAndDispose(key)));
				owner.add(editor.onDidDispose(() => this.annotations.deleteAndDispose(key)));
				return null;
			}
			case 'formatTimestamps': {
				if (!Array.isArray(request.timestamps) || request.timestamps.length > 512 || request.timestamps.some(value => typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 8.64e15)) throw new TypeError('Invalid timestamp batch');
				const date = new Intl.DateTimeFormat(getNLSLanguage(), { dateStyle: 'medium', timeStyle: 'short' });
				const relative = new Intl.RelativeTimeFormat(getNLSLanguage(), { numeric: 'auto' });
				const now = Date.now();
				return request.timestamps.map(value => {
					const milliseconds = value as number;
					const seconds = Math.round((milliseconds - now) / 1000);
					const [unit, divisor] = Math.abs(seconds) >= 86400 ? ['day', 86400] as const : Math.abs(seconds) >= 3600 ? ['hour', 3600] as const : ['minute', 60] as const;
					return { date: date.format(milliseconds), relative: relative.format(Math.round(seconds / divisor), unit) };
				});
			}
			case 'openEditorResources': return [...new Set(this.part.groups.flatMap(group => group.inputs.map(input => input.resource.toString())))].slice(0, 4096);
			case 'hostFacts': return { canClone: this.workspace.canOpenWorkspace, canOpenWorkspace: this.workspace.canOpenWorkspace };
			case 'input': {
				using cancellation = new CancellationTokenSource();
				const abort = () => cancellation.cancel();
				signal.addEventListener('abort', abort, { once: true });
				try {
					const result = await this.quickInput.input({ title: optionalText(request.title), placeHolder: optionalText(request.placeHolder), value: optionalText(request.value), password: request.password === true, validationMessage: optionalText(request.validationMessage) }, cancellation.token);
					signal.throwIfAborted();
					return result ?? null;
				}
				finally {
					signal.removeEventListener('abort', abort);
				}
			}
			case 'confirm': {
				const result = await this.dialogs.confirm({ title: optionalText(request.title), message: text(request.message), detail: optionalText(request.detail), primaryButton: optionalText(request.primaryButton) });
				signal.throwIfAborted();
				return { confirmed: result.confirmed };
			}
			case 'prompt': {
				if (!Array.isArray(request.buttons) || !request.buttons.length || request.buttons.length > 16) throw new TypeError('Invalid extension dialog buttons');
				if (request.severity !== undefined && request.severity !== 'info' && request.severity !== 'warning' && request.severity !== 'error') throw new TypeError('Invalid extension dialog severity');
				const buttons = request.buttons.map((label, index) => ({ label: text(label, 1024), run: () => index }));
				const result = await this.dialogs.prompt({
					title: optionalText(request.title), message: text(request.message), detail: optionalText(request.detail),
					severity: request.severity === 'warning' ? DialogSeverity.Warning : request.severity === 'error' ? DialogSeverity.Error : DialogSeverity.Info,
					buttons, cancelButton: optionalText(request.cancelButton),
				});
				signal.throwIfAborted();
				return { selection: result.result ?? null };
			}
			case 'pickFolder': {
				const folder = await this.workspace.pickFolder(optionalText(request.defaultPath));
				// The selected path belongs to the filesystem host, which may differ from
				// both the renderer and the extension process. Only URIs cross this boundary.
				const resource = folder === undefined ? undefined : await this.paths.fileURI(folder);
				signal.throwIfAborted();
				return resource?.toString() ?? null;
			}
			case 'openWorkspace':
				if (request.forceNewWindow !== undefined && typeof request.forceNewWindow !== 'boolean') throw new TypeError('Invalid workspace window policy');
				await this.workspace.openWorkspace(text(request.path), request.forceNewWindow === true);
				return null;
			case 'openView':
				await this.instantiation.invokeFunction(accessor => accessor.get(IViewsService).openView(text(request.id), request.focus === true));
				return null;
			case 'clipboard':
				await this.clipboard.writeText(text(request.text));
				return null;
			case 'openExternal':
				await this.opener.open(URI.parse(text(request.uri)), { openExternal: true, fromUserGesture: true, allowContributedOpeners: true });
				return null;
			case 'openEditorDocument': {
				const resource = URI.parse(text(request.uri));
				if (resource.scheme !== 'untitled') throw new TypeError('Expected an untitled document');
				await this.editors.openEditor({ resource, initialText: text(request.text), label: text(request.label), languageId: 'git-commit' }, { pinned: true });
				return null;
			}
			case 'readEditorDocument': {
				const resource = URI.parse(text(request.uri));
				const copy = this.workingCopies.get(resource).find(copy => copy.backupKind === 'text');
				return copy ? { text: copy.backup(), dirty: copy.isDirty } : null;
			}
			case 'closeEditorDocument': {
				const resource = URI.parse(text(request.uri));
				for (const group of this.part.groups) {
					for (const input of [...group.inputs]) if (extUriBiasedIgnorePathCase.isEqual(input.resource, resource)) {
						const copy = this.workingCopies.get(resource).find(copy => copy.backupKind === 'text');
						if (request.expectedText != null && copy?.backup() !== text(request.expectedText)) continue;
						await group.closeEditor(input, { skipConfirmation: request.expectedText != null });
					}
				}
				return null;
			}
			case 'prepareRepositoryOperation': {
				const root = URI.parse(text(request.root));
				if (!['always', 'staged', 'never'].includes(text(request.saveMode))) throw new TypeError('Invalid save policy');
				if (!Array.isArray(request.paths) || request.paths.length > 10000) throw new TypeError('Invalid repository paths');
				const paths = request.paths.map(value => URI.parse(text(value)));
				if (paths.some(path => !extUriBiasedIgnorePathCase.isEqualOrParent(path, root))) throw new TypeError('Path exceeds repository');
				const selected = (resource: URI) => request.saveMode === 'always' ? extUriBiasedIgnorePathCase.isEqualOrParent(resource, root) : paths.some(path => extUriBiasedIgnorePathCase.isEqual(path, resource));
				const dirty = request.saveMode === 'never' ? [] : this.workingCopies.getAll().filter(copy => copy.isDirty && selected(copy.resource));
				if (dirty.length) {
					const confirmation = await this.dialogs.confirm({ message: localize({ bundle: 'ash', key: 'extension.editor.saveBeforeOperation' }, 'Save {0} changed files before continuing?', dirty.length), primaryButton: localize({ bundle: 'ash', key: 'extension.editor.saveFiles' }, 'Save Files') });
					if (!confirmation.confirmed) return false;
					for (const copy of dirty) { await copy.save(signal); signal.throwIfAborted(); }
					if (dirty.some(copy => copy.isDirty)) return false;
				}
				if (request.diagnostics != null) {
					const sources = record(request.diagnostics);
					if (Object.keys(sources).length > 100 || Object.values(sources).some(level => level !== 'error' && level !== 'warning' && level !== 'information' && level !== 'hint' && level !== 'none')) throw new TypeError('Invalid diagnostic policy');
					const markers = this.instantiation.invokeFunction(accessor => accessor.get(IMarkerService)).read();
					const blocked = markers.filter(marker => paths.some(path => extUriBiasedIgnorePathCase.isEqual(path, marker.resource))).filter(marker => {
						const threshold = sources[marker.source ?? marker.owner] ?? sources['*'];
						const minimum = threshold === 'error' ? MarkerSeverity.Error : threshold === 'warning' ? MarkerSeverity.Warning : threshold === 'information' ? MarkerSeverity.Info : threshold === 'hint' ? MarkerSeverity.Hint : undefined;
						return minimum !== undefined && marker.severity >= minimum;
					});
					if (blocked.length) {
						await this.dialogs.confirm({ message: localize({ bundle: 'ash', key: 'extension.editor.commitDiagnostics' }, 'Resolve {0} diagnostics before committing.', blocked.length) });
						return false;
					}
				}
				return true;
			}
			case 'closeRelatedDiffs': {
				const root = URI.parse(text(request.root));
				for (const group of this.part.groups) {
					for (const input of [...group.inputs]) {
						if ('modified' in input && input.modified && typeof input.modified === 'object' && 'resource' in input.modified
							&& extUriBiasedIgnorePathCase.isEqualOrParent((input.modified as IResourceEditorInput).resource, root)) await group.closeEditor(input);
					}
				}
				return null;
			}
			case 'save': {
				await Promise.all(this.workingCopies.get(URI.parse(text(request.uri))).map(copy => copy.save(signal)));
				signal.throwIfAborted();
				return null;
			}
			case 'activeEditor': {
				const context = request.context == null ? undefined : record(request.context);
				const group = typeof context?.groupId === 'string' ? this.part.groups.find(group => group.id === context.groupId) : this.part.activeGroup;
				const index = context?.editorIndex;
				if (index != null && (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0)) {
					throw new TypeError('Invalid editor index');
				}
				const input = typeof index === 'number' ? group?.inputs[index] : group?.activeInput;
				const pane = input === group?.activeInput ? group?.activePane : undefined;
				const selection = isEditorPaneWithSelection(pane) ? pane.getSelection() : undefined;
				const copy = input ? this.workingCopies.get(input.resource).find(copy => copy.backupKind === 'text') : undefined;
				const contents = copy?.backup();
				return normalizeExtensionHostPayload({ version: input ? this.codeEditors.listCodeEditors().find(editor => extUriBiasedIgnorePathCase.isEqual(editor.getModel()?.uri, input.resource))?.getModel()?.getVersionId() ?? null : null, contents: contents && contents.length <= 2 * 1024 * 1024 ? contents : null, input: input ? { resource: input.resource.toString(), modified: 'modified' in input ? { resource: (input.modified as IResourceEditorInput).resource.toString() } : null } : null, selection: selection ? { startLineNumber: selection.startLineNumber, startColumn: selection.startColumn, endLineNumber: selection.endLineNumber, endColumn: selection.endColumn } : null });
			}
			case 'dirty':
			case 'diffChange':
			case 'readTextFile':
			case 'saveTextFile': return new MainThreadEditorChanges(this.codeEditors, this.workingCopies, this.files).handle(value, signal);
			case 'open': {
				const options = parseOptions(request.options);
				const input = parseExtensionEditorInput(request.input);
				await this.editors.openEditor(input, options, request.sideBySide === true ? 'sideGroup' : undefined);
				signal.throwIfAborted();
				return null;
			}
			default: throw new TypeError('Unsupported extension editor operation');
		}
	}
}
function record(value: JsonValue): Record<string, JsonValue> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('Expected extension editor object');
	} return value as Record<string, JsonValue>;
}
function text(value: JsonValue, limit = 16 * 1024 * 1024): string {
	if (typeof value !== 'string' || value.length > limit || value.includes('\0')) {
		throw new TypeError('Invalid extension editor text');
	} return value;
}
function optionalText(value: JsonValue | undefined): string | undefined { return value == null ? undefined : text(value); }
function positiveInteger(value: JsonValue): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
		throw new TypeError('Invalid editor coordinate');
	} return value;
}
function parseRange(value: JsonValue): Range { const range = record(value); return new Range(positiveInteger(range.startLineNumber), positiveInteger(range.startColumn), positiveInteger(range.endLineNumber), positiveInteger(range.endColumn)); }
function selectionSource(value: JsonValue): TextEditorSelectionSource {
	if (value === TextEditorSelectionSource.PROGRAMMATIC || value === TextEditorSelectionSource.NAVIGATION || value === TextEditorSelectionSource.JUMP) {
		return value;
	} throw new TypeError('Invalid editor selection source');
}
function parseOptions(value: JsonValue): EditorOpenOptions {
	if (value == null) {
		return {};
	}
	const entry = record(value);
	return { pinned: entry.pinned === true, revealIfOpened: entry.revealIfOpened === true, preserveFocus: entry.preserveFocus === true, selection: entry.selection == null ? undefined : parseRange(entry.selection), selectionSource: entry.selectionSource == null ? undefined : selectionSource(entry.selectionSource) };
}
