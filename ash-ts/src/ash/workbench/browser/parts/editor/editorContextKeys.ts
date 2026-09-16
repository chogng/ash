import type { Event } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable, type IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IContextKey } from "../../../../platform/contextkey/common/contextkey.js";
import type { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { isTextResourceLanguageInput, resolveTextResourceLanguageId, type TextResourceLanguageResolver } from '../../../../platform/language/common/textResourceLanguage.js';
import { ActiveEditorAvailableEditorIdsContext, ActiveEditorCanRevertContext, ActiveEditorContext, ActiveEditorDirtyContext, ActiveEditorFirstInGroupContext, ActiveEditorLastInGroupContext, ActiveEditorPinnedContext, ActiveEditorReadonlyContext, EditorGroupEditorsCountContext, EditorPartModalVisibleContext, ResourceContext, ResourceDirnameContext, ResourceExtensionContext, ResourceFilenameContext, ResourceLanguageIdContext, ResourcePathContext, ResourceSchemeContext, ResourceSetContext } from '../../../common/contextkeys.js';
import type { EditorInput } from '../../../services/editor/common/editorService.js';
import type { EditorGroupChangeEvent, EditorGroupState, IEditorStateSource } from '../../../services/editor/common/editorState.js';
import type { IWorkingCopy } from '../../../services/workingCopy/common/workingCopyService.js';
import type { IEditorPane } from './editorPane.js';
import type { EditorPaneRegistry } from './editorRegistry.js';

export interface EditorContextKeySource extends IEditorStateSource {
	readonly activeInput: EditorInput | undefined;
	readonly activePane: IEditorPane | undefined;
}

export interface EditorGroupContextKeySource {
	readonly onDidChangeEditors: Event<EditorGroupChangeEvent>;
	getEditorState(): EditorGroupState;
}

/** Projects editor-owned state into the Workbench context used by editor actions. */
export class EditorContextKeyController extends Disposable {
	private readonly keys: EditorContextKeyBindings;
	private readonly workingCopyListener = this._register(new MutableDisposable<IDisposable>());
	private activeWorkingCopy: IWorkingCopy | undefined;

	constructor(
		private readonly contextKeyService: IContextKeyService,
		private readonly source: EditorContextKeySource,
		private readonly editorRegistry: EditorPaneRegistry,
		private readonly languageResolver: TextResourceLanguageResolver | undefined,
	) {
		super();
		this.keys = bufferContextKeyChanges(contextKeyService, () => {
			const keys = createEditorContextKeyBindings(contextKeyService);
			this.update(keys);
			return keys;
		});
		this._register(this.source.onDidChangeEditors(() => this.update()));
		this._register(toDisposable(() => this.reset()));
	}

	private update(keys: EditorContextKeyBindings = this.keys): void {
		const state = this.source.getEditorState();
		const group = state.groups.find(candidate => candidate.id === state.activeGroupId);
		const activeEditor = group?.editors.find(candidate => candidate.instanceId === state.activeEditor?.instanceId);
		const input = state.isModalEditorVisible ? this.source.activeInput : activeEditor?.input;
		const pane = state.isModalEditorVisible ? this.source.activePane : undefined;
		const workingCopy = pane?.workingCopy;
		this.updateWorkingCopyListener(workingCopy, keys.activeEditorDirty);
		this.contextKeyService.bufferChangeEvents(() => {
			applyEditorContextKeys(this.contextKeyService, keys, this.editorRegistry, this.languageResolver, {
				input,
				paneId: state.isModalEditorVisible ? pane?.id : activeEditor?.paneId,
				isDirty: state.isModalEditorVisible ? workingCopy?.isDirty ?? false : activeEditor?.isDirty ?? false,
				isPreview: state.isModalEditorVisible ? false : activeEditor?.isPreview ?? false,
				canRevert: state.isModalEditorVisible ? workingCopy !== undefined : activeEditor?.canRevert ?? false,
				index: state.isModalEditorVisible ? -1 : activeEditor?.index ?? -1,
				groupEditorCount: group?.editors.length ?? 0,
				isModal: state.isModalEditorVisible,
			});
		});
	}

	private updateWorkingCopyListener(workingCopy: IWorkingCopy | undefined, activeEditorDirty: IContextKey<boolean>): void {
		if (workingCopy === this.activeWorkingCopy) return;
		this.activeWorkingCopy = workingCopy;
		this.workingCopyListener.value = workingCopy?.onDidChangeDirty(() => {
			if (this.activeWorkingCopy === workingCopy) activeEditorDirty.set(workingCopy.isDirty);
		});
	}

	private reset(): void {
		this.activeWorkingCopy = undefined;
		this.workingCopyListener.clear();
		this.contextKeyService.bufferChangeEvents(() => {
			resetEditorContextKeys(this.contextKeyService, this.keys);
		});
	}
}

/** Projects one EditorGroup's canonical state into its scoped context. */
export class EditorGroupContextKeyController extends Disposable {
	private readonly keys: EditorContextKeyBindings;

	constructor(
		private readonly contextKeyService: IContextKeyService,
		private readonly source: EditorGroupContextKeySource,
		private readonly editorRegistry: EditorPaneRegistry,
		private readonly languageResolver: TextResourceLanguageResolver | undefined,
	) {
		super();
		this.keys = bufferContextKeyChanges(contextKeyService, () => {
			const keys = createEditorContextKeyBindings(contextKeyService);
			this.update(keys);
			return keys;
		});
		this._register(this.source.onDidChangeEditors(() => this.update()));
		this._register(toDisposable(() => resetEditorContextKeys(this.contextKeyService, this.keys)));
	}

	private update(keys: EditorContextKeyBindings = this.keys): void {
		const state = this.source.getEditorState();
		const activeEditor = state.editors.find(candidate => candidate.instanceId === state.activeEditorInstanceId);
		applyEditorContextKeys(this.contextKeyService, keys, this.editorRegistry, this.languageResolver, {
			input: activeEditor?.input,
			paneId: activeEditor?.paneId,
			isDirty: activeEditor?.isDirty ?? false,
			isPreview: activeEditor?.isPreview ?? false,
			canRevert: activeEditor?.canRevert ?? false,
			index: activeEditor?.index ?? -1,
			groupEditorCount: state.editors.length,
			isModal: false,
		});
	}
}

function createEditorContextKeyBindings(contextKeyService: IContextKeyService) {
	const bindings = {
		activeEditor: ActiveEditorContext.bindTo(contextKeyService),
		activeEditorDirty: ActiveEditorDirtyContext.bindTo(contextKeyService),
		activeEditorPinned: ActiveEditorPinnedContext.bindTo(contextKeyService),
		activeEditorFirstInGroup: ActiveEditorFirstInGroupContext.bindTo(contextKeyService),
		activeEditorLastInGroup: ActiveEditorLastInGroupContext.bindTo(contextKeyService),
		activeEditorReadonly: ActiveEditorReadonlyContext.bindTo(contextKeyService),
		activeEditorCanRevert: ActiveEditorCanRevertContext.bindTo(contextKeyService),
		activeEditorAvailableEditorIds: ActiveEditorAvailableEditorIdsContext.bindTo(contextKeyService),
		editorGroupEditorsCount: EditorGroupEditorsCountContext.bindTo(contextKeyService),
		editorPartModalVisible: EditorPartModalVisibleContext.bindTo(contextKeyService),
		resource: ResourceContext.bindTo(contextKeyService),
		resourceScheme: ResourceSchemeContext.bindTo(contextKeyService),
		resourceFilename: ResourceFilenameContext.bindTo(contextKeyService),
		resourceDirname: ResourceDirnameContext.bindTo(contextKeyService),
		resourcePath: ResourcePathContext.bindTo(contextKeyService),
		resourceLanguageId: ResourceLanguageIdContext.bindTo(contextKeyService),
		resourceExtension: ResourceExtensionContext.bindTo(contextKeyService),
		resourceSet: ResourceSetContext.bindTo(contextKeyService),
	};
	return {
		...bindings,
		all: Object.values(bindings) as readonly Pick<IContextKey<never>, 'reset'>[],
	};
}

type EditorContextKeyBindings = ReturnType<typeof createEditorContextKeyBindings>;

interface EditorContextKeyProjection {
	readonly input: EditorInput | undefined;
	readonly paneId: string | undefined;
	readonly isDirty: boolean;
	readonly isPreview: boolean;
	readonly canRevert: boolean;
	readonly index: number;
	readonly groupEditorCount: number;
	readonly isModal: boolean;
}

function applyEditorContextKeys(
	contextKeyService: IContextKeyService,
	keys: EditorContextKeyBindings,
	editorRegistry: EditorPaneRegistry,
	languageResolver: TextResourceLanguageResolver | undefined,
	projection: EditorContextKeyProjection,
): void {
	const resource = projection.input?.resource;
	const path = resource ? resourceContextPath(resource) : undefined;
	const filename = path ? resourceFilename(path) : undefined;
	contextKeyService.bufferChangeEvents(() => {
		keys.activeEditor.set(projection.paneId ?? '');
		keys.activeEditorDirty.set(projection.isDirty);
		keys.activeEditorPinned.set(Boolean(projection.input && (projection.isModal || !projection.isPreview)));
		keys.activeEditorFirstInGroup.set(projection.index === 0);
		keys.activeEditorLastInGroup.set(projection.index >= 0 && projection.index === projection.groupEditorCount - 1);
		keys.activeEditorReadonly.set(projection.input?.readOnly === true);
		keys.activeEditorCanRevert.set(projection.canRevert);
		keys.activeEditorAvailableEditorIds.set(projection.input ? editorRegistry.getEditors(projection.input).map(editor => editor.id).join(',') : '');
		keys.editorGroupEditorsCount.set(projection.groupEditorCount);
		keys.editorPartModalVisible.set(projection.isModal);
		keys.resource.set(resource?.toString());
		keys.resourceScheme.set(resource?.scheme);
		keys.resourceFilename.set(filename);
		keys.resourceDirname.set(path ? resourceDirname(path) : undefined);
		keys.resourcePath.set(path);
		keys.resourceLanguageId.set(projection.input ? resourceLanguageId(projection.input, languageResolver) : undefined);
		keys.resourceExtension.set(filename ? resourceExtension(filename) : undefined);
		keys.resourceSet.set(resource !== undefined);
	});
}

function resetEditorContextKeys(contextKeyService: IContextKeyService, keys: EditorContextKeyBindings): void {
	contextKeyService.bufferChangeEvents(() => {
		for (const key of keys.all) key.reset();
	});
}

function resourceContextPath(resource: EditorInput['resource']): string {
	return resource.scheme === 'file' ? resource.fsPath : decodeURIComponent(resource.path);
}

function resourceFilename(path: string): string | undefined {
	const normalized = path.replace(/[\\/]+$/u, '');
	if (!normalized) return undefined;
	const separator = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
	return normalized.slice(separator + 1) || undefined;
}

function resourceDirname(path: string): string | undefined {
	const normalized = path.replace(/[\\/]+$/u, '');
	const separator = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
	if (separator < 0) return undefined;
	if (separator === 0) return normalized[0];
	if (separator === 2 && /^[A-Za-z]:[\\/]/u.test(normalized)) return normalized.slice(0, 3);
	return normalized.slice(0, separator);
}

function resourceExtension(filename: string): string {
	const dot = filename.lastIndexOf('.');
	return dot > 0 ? filename.slice(dot) : '';
}

function resourceLanguageId(input: EditorInput, resolver: TextResourceLanguageResolver | undefined): string | undefined {
	if (input.languageId) return input.languageId;
	return isTextResourceLanguageInput(input, resolver) ? resolveTextResourceLanguageId(input, resolver) : undefined;
}

function bufferContextKeyChanges<T>(contextKeyService: IContextKeyService, callback: () => T): T {
	let result!: T;
	contextKeyService.bufferChangeEvents(() => {
		result = callback();
	});
	return result;
}
