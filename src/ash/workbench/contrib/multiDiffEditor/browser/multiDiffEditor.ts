import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import './media/multiDiffEditorPane.css';
import type { IContextMenuProvider } from '../../../../base/browser/contextmenu.js';
import { h } from '../../../../base/browser/dom.js';
import { type IDimension } from '../../../../base/browser/dom.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import type { IAction } from '../../../../base/common/actions.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { assertDefined } from '../../../../base/common/types.js';
import { MultiDiffEditorWidget } from '../../../../editor/browser/widget/multiDiffEditor/multiDiffEditorWidget.js';
import type { DiffEditorWidget } from '../../../../editor/browser/widget/diffEditor/diffEditorWidget.js';
import { DocumentDiffItem, MultiDiffEditorModel, type IDocumentDiffItem } from '../../../../editor/browser/widget/multiDiffEditor/model.js';
import { bindActionContext } from '../../../../editor/browser/widget/multiDiffEditor/utils.js';
import { type MultiDiffEditorLocation } from '../../../../editor/browser/widget/multiDiffEditor/multiDiffEditorViewModel.js';
import { DiffModel } from '../../../../editor/common/diff/diffModel.js';
import { type IDocumentDiffProvider } from '../../../../editor/common/diff/documentDiffProvider.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { type ITextModelResourceService } from '../../../services/textmodelResolver/common/textModelResourceService.js';
import { MenuWorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { MenuId, type IMenuService } from '../../../../platform/actions/common/actions.js';
import type { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { type IEditorPaneWithViewState } from '../../../browser/parts/editor/editorWithViewState.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import type { IEditorService } from '../../../services/editor/common/editorService.js';
import type { GitStatus, IGitService } from '../../../contrib/git/common/gitService.js';
import type { IViewsService } from '../../../services/views/common/viewsService.js';
import { VIEW_PANE_ID } from '../../scm/common/scm.js';
import { createGitMultiDiffEditorInput } from './scmMultiDiffAction.js';
import { isMultiDiffEditorInput, MULTI_DIFF_EDITOR_ID, multiDiffEditorItemKey, type MultiDiffEditorInput, type MultiDiffEditorInputItem } from './multiDiffEditorInput.js';
import { MultiDiffEditorToolbar } from './multiDiffEditorToolbar.js';
import { localize } from '../../../../nls.js';
import { ActiveEditorContext, ResourceContext } from '../../../common/contextkeys.js';
import { CodeEditorConfiguration } from '../../codeEditor/common/editorConfiguration.js';
import { getDiffComputationOptions, getDiffWordWrap } from '../../../services/editor/common/editorConfiguration.js';

export interface MultiDiffEditorOptions {
	readonly modelService: ITextModelResourceService;
	readonly createComputationService: () => IDocumentDiffProvider & IDisposable;
	readonly lineHeight?: number;
	readonly fontFamily?: string;
	readonly fontSize?: number;
	readonly fontLigatures?: boolean;
	readonly showLineNumbers?: boolean;
	readonly showInlineChanges?: boolean;
	readonly loopChanges?: boolean;
	readonly gitService?: IGitService;
	readonly editorService?: IEditorService;
	readonly viewsService?: IViewsService;
	readonly fileActions?: {
		readonly menuService: IMenuService;
		readonly contextMenuProvider: IContextMenuProvider;
		readonly contextKeyService: IContextKeyService;
	};
}

/** Workbench pane that loads visible comparisons and hosts the generic editor widget. */
export class MultiDiffEditor extends EditorPane implements IEditorPaneWithViewState {
	public readonly id = MULTI_DIFF_EDITOR_ID;
	public readonly viewStateTypeId = 'ash.multiDiffEditor';
	private readonly session = this._register(new MutableDisposable<MultiDiffEditorSession>());
	private readonly pendingSession = this._register(new MutableDisposable<MultiDiffEditorSession>());
	private editorContainerDomNode: HTMLDivElement | undefined;
	private dimension: IDimension = { width: 0, height: 0 };

	constructor(
		private readonly options: MultiDiffEditorOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super(MULTI_DIFF_EDITOR_ID, themeService, storageService);
		if (!options || typeof options !== 'object' || typeof options.createComputationService !== 'function') {
			this.dispose();
			throw new TypeError('Multi-diff editor pane requires a Workbench diff computation service');
		}
		if (!options.modelService || typeof options.modelService.acquire !== 'function') {
			this.dispose();
			throw new TypeError('Multi-diff editor pane requires a text model service');
		}
	}

	public override create(parent: HTMLElement): void {
		if (this.editorContainerDomNode) throw new ReferenceError('MultiDiffEditor has already been created');
		const editorContainerDomNode = h(parent.ownerDocument, 'div');
		editorContainerDomNode.className = 'stanza-multi-diff-editor-pane';
		parent.append(editorContainerDomNode);
		super.create(editorContainerDomNode);
		this.editorContainerDomNode = editorContainerDomNode;
		this._register(toDisposable(() => {
			editorContainerDomNode.remove();
			this.editorContainerDomNode = undefined;
		}));
	}

	public override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		if (!isMultiDiffEditorInput(input)) throw new TypeError('Multi-diff editor pane requires a multi-diff editor input');
		const container = this.requireContainer();
		throwIfCancelled(signal, 'Multi-diff editor input loading was cancelled');
		let next: MultiDiffEditorSession | undefined;
		try {
			next = this.instantiationService.createInstance(
				MultiDiffEditorSession, container, input,
				input.label ?? 'Changes', this.options, signal,
			);
			this.pendingSession.value = next;
			next.layout(this.dimension);
			await next.resolveVisible();
			throwIfCancelled(signal, 'Multi-diff editor input loading was cancelled');
			if (this.pendingSession.value !== next) throw new Error('Multi-diff editor input loading was cancelled');
		} catch (error) {
			if (this.pendingSession.value === next) this.pendingSession.clear();
			next?.dispose();
			throw error;
		}
		this.session.value = this.pendingSession.clearAndLeak();
		this.session.value?.show();
		await this.options.viewsService?.focusView(VIEW_PANE_ID);
	}

	public override clearInput(): void {
		this.pendingSession.clear();
		this.session.clear();
	}

	public override layout(dimension: IDimension): void {
		this.dimension = { width: Math.max(0, dimension.width), height: Math.max(0, dimension.height) };
		this.session.value?.layout(this.dimension);
	}

	public override setVisible(visibility: boolean): void {
		super.setVisible(visibility);
		if (visibility) this.session.value?.layout(this.dimension);
	}

	public override focus(): void {
		this.session.value?.focus();
	}

	public override getControl(): DiffEditorWidget | undefined {
		return this.session.value?.editor?.getActiveControl();
	}

	public getActiveDiffItem(): MultiDiffEditorInputItem | undefined {
		return this.session.value?.getActiveDiffItem();
	}

	public saveViewState(): unknown {
		return this.session.value?.editor?.saveViewState() ?? null;
	}

	public restoreViewState(state: unknown): void {
		const editor = this.session.value?.editor;
		if (!editor) throw new Error('Multi-diff editor view-state restoration is unavailable');
		editor.restoreViewState(state);
	}

	public toggleWordWrap(): void {
		this.session.value?.editor?.toggleWordWrap();
	}

	public nextChange(): Promise<MultiDiffEditorLocation | undefined> | undefined {
		return this.session.value?.editor?.nextChange();
	}

	public previousChange(): Promise<MultiDiffEditorLocation | undefined> | undefined {
		return this.session.value?.editor?.previousChange();
	}

	public collapseAll(): void {
		this.session.value?.editor?.collapseAll();
	}

	public expandAll(): void {
		this.session.value?.editor?.expandAll();
	}

	private requireContainer(): HTMLDivElement {
		assertDefined(this.editorContainerDomNode, new ReferenceError('Multi-diff editor pane has not been created'));
		return this.editorContainerDomNode;
	}
}

class MultiDiffEditorSession extends Disposable {
	public readonly editor: MultiDiffEditorWidget | undefined;
	private readonly models = new Set<DiffModel>();
	private readonly itemResources = this._register(new MutableDisposable<DisposableStore>());
	private readonly model: MultiDiffEditorModel;
	private readonly inputsById = new Map<string, MultiDiffEditorInputItem>();
	private refreshGeneration = 0;
	private refreshStatusKey: string | undefined;
	private readonly computationService: IDocumentDiffProvider;
	private readonly emptyDomNode: HTMLDivElement;
	private readonly abortController = new AbortController();
	private readonly domNode: HTMLDivElement;
	private readonly editorDomNode: HTMLDivElement;
	private readonly toolbar = this._register(new MutableDisposable<MultiDiffEditorToolbar>());

	constructor(
		container: HTMLElement,
		private paneInput: MultiDiffEditorInput,
		private readonly label: string,
		private readonly options: MultiDiffEditorOptions,
		initialSignal: AbortSignal,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IDialogService private readonly dialogs: IDialogService,
	) {
		super();
		try {
			this.domNode = h(container.ownerDocument, 'div');
			this.domNode.className = 'stanza-multi-diff-editor-session pending';
			this.editorDomNode = h(container.ownerDocument, 'div');
			this.editorDomNode.className = 'stanza-multi-diff-editor-host';
			this.domNode.append(this.editorDomNode);
			container.append(this.domNode);
			this._register(toDisposable(() => this.domNode.remove()));
			const abort = (): void => this.abortController.abort();
			initialSignal.addEventListener('abort', abort, { once: true });
			this._register(toDisposable(() => initialSignal.removeEventListener('abort', abort)));
			if (initialSignal.aborted) abort();
			const computationService = options.createComputationService();
			if (!computationService || typeof computationService.computeDiff !== 'function') {
				throw new TypeError('Multi-diff editor pane factory returned an invalid Workbench diff computation service');
			}
			this._register(computationService);
			this.computationService = computationService;
			const resources = new DisposableStore();
			this.itemResources.value = resources;
			const items = this.createItems(paneInput, resources);
			this.model = this._register(new MultiDiffEditorModel(items));
			this._register(configuration.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration(CodeEditorConfiguration.diffWordWrap)
					|| event.affectsConfiguration(CodeEditorConfiguration.wordWrap)) {
					this.editor?.setConfiguredWordWrap(getDiffWordWrap(configuration));
				}
				if ([CodeEditorConfiguration.lineHeight, CodeEditorConfiguration.fontFamily,
					CodeEditorConfiguration.fontSize, CodeEditorConfiguration.fontLigatures,
					CodeEditorConfiguration.diffShowLineNumbers, CodeEditorConfiguration.diffShowInlineChanges,
					CodeEditorConfiguration.diffLoopChanges].some(key => event.affectsConfiguration(key))) {
					this.editor?.updateOptions(this.getEditorOptions());
				}
				for (const model of this.models) {
					const languageId = model.modified.getLanguageId();
					if (event.affectsConfiguration(CodeEditorConfiguration.diffIgnoreTrimWhitespace, { overrideIdentifier: languageId })
						|| event.affectsConfiguration(CodeEditorConfiguration.diffMaxComputationTime, { overrideIdentifier: languageId })
						|| event.affectsConfiguration('diffEditor.experimental.showMoves')) {
						model.updateOptions(getDiffComputationOptions(configuration, languageId));
					}
				}
			}));
			const fileActions = options.fileActions;
			this.createToolbar();
			this._register(toDisposable(() => this.abortController.abort()));
			this.emptyDomNode = h(container.ownerDocument, 'div');
			this.emptyDomNode.className = 'stanza-multi-diff-editor-empty';
			this.emptyDomNode.textContent = localize('multiDiff.empty', 'No changes in this selection.');
			this.editorDomNode.append(this.emptyDomNode);
			this.emptyDomNode.hidden = items.length > 0;
			this.editor = this._register(instantiationService.createInstance(MultiDiffEditorWidget, {
				container: this.editorDomNode,
				model: this.model,
				wordWrap: getDiffWordWrap(configuration),
				...this.getEditorOptions(),
				...(fileActions ? {
					workbenchUIElementFactory: {
						createItemActions: (container: HTMLElement, item: IDocumentDiffItem) => {
							const input = this.inputsById.get(item.id);
							if (!input) throw new RangeError(`Unknown multi-diff item '${item.id}'`);
							return this.createFileActions(container, input, options, fileActions.contextMenuProvider);
						},
					},
				} : {}),
			}));
			if (paneInput.source?.kind === 'git' && options.gitService) {
				this.refreshStatusKey = new URLSearchParams(paneInput.resource.query).get('stream') + ':' + new URLSearchParams(paneInput.resource.query).get('revision');
				this._register(options.gitService.onDidChangeRepositoryStatus(status => {
					void this.refreshGitSource(status).catch(error => {
						if (!this.isDisposed) void this.dialogs.error(error instanceof Error ? error.message : String(error));
					});
				}));
			}
		} catch (error) {
			this.dispose();
			throw error;
		}
	}

	public layout(dimension: IDimension): void {
		const toolbarHeight = this.toolbar.value?.domNode.offsetHeight ?? (this.toolbar.value ? 40 : 0);
		this.editor?.layout({ width: dimension.width, height: Math.max(0, dimension.height - toolbarHeight) });
	}

	public resolveVisible(): Promise<void> {
		return this.editor?.resolveVisible() ?? Promise.resolve();
	}

	public show(): void {
		this.domNode.classList.remove('pending');
	}

	private async loadItem(input: MultiDiffEditorInputItem, modelService: ITextModelResourceService, computationService: IDocumentDiffProvider, configuration: IConfigurationService, owner: DisposableStore, signal: AbortSignal): Promise<DiffModel> {
		const resources = owner.add(new DisposableStore());
		try {
			const original = await modelService.acquire(input.original, signal);
			if (this.isDisposed || signal.aborted || owner.isDisposed) {
				original.dispose();
				throw new Error('Multi-diff editor input loading was cancelled');
			}
			resources.add(original);
			const modified = await modelService.acquire(input.modified, signal);
			if (this.isDisposed || signal.aborted || owner.isDisposed) {
				modified.dispose();
				throw new Error('Multi-diff editor input loading was cancelled');
			}
			resources.add(modified);
			const model = resources.add(new DiffModel({
				original: original.model,
				modified: modified.model,
				diffProvider: computationService,
				diffOptions: getDiffComputationOptions(configuration, modified.model.getLanguageId()),
			}));
			resources.add(modified.model.onDidChangeLanguage(() => {
				model.updateOptions(getDiffComputationOptions(configuration, model.modified.getLanguageId()));
			}));
			this.models.add(model);
			resources.add(toDisposable(() => this.models.delete(model)));
			return model;
		} catch (error) {
			resources.dispose();
			throw error;
		}
	}

	public focus(): void {
		this.editor?.focus();
	}

	public getActiveDiffItem(): MultiDiffEditorInputItem | undefined {
		const item = this.editor?.getActiveItem();
		return item ? this.paneInput.items.find(input => multiDiffEditorItemKey(input) === item.id) : undefined;
	}

	private createFileActions(container: HTMLElement, input: MultiDiffEditorInputItem, options: MultiDiffEditorOptions, contextMenuProvider: IContextMenuProvider): IDisposable {
		const actions: IAction[] = [];
		const change = input.gitChange;
		if (change) {
			actions.push(new PaneAction('multiDiff.discardFile', localize('multiDiff.discardChanges', 'Discard Changes'), localize('multiDiff.discardChanges', 'Discard Changes'), Lxicon.discard, change.hasWorktreeChanges, async item => {
				const confirmation = await this.dialogs.confirm({
					message: localize('multiDiff.discardFileConfirm', 'Discard changes in {0}? This cannot be undone.', item.gitChange!.path),
					primaryButton: localize('multiDiff.discardChanges', 'Discard Changes'),
				});
				if (!confirmation.confirmed || this.isDisposed) return;
				const status = await options.gitService?.discardWorktree([item.gitChange!.path], item.gitChange!.repositoryId);
				if (status) await this.refreshGitSource(status);
			}));
			actions.push(new PaneAction(change.staged ? 'multiDiff.unstageFile' : 'multiDiff.stageFile', change.staged ? localize('multiDiff.unstageChanges', 'Unstage Changes') : localize('multiDiff.stageChanges', 'Stage Changes'), change.staged ? localize('multiDiff.unstageChanges', 'Unstage Changes') : localize('multiDiff.stageChanges', 'Stage Changes'), change.staged ? Lxicon.remove : Lxicon.check, options.gitService !== undefined, async item => {
				const status = item.gitChange!.staged
					? await options.gitService?.unstage([item.gitChange!.path], item.gitChange!.repositoryId)
					: await options.gitService?.stage([item.gitChange!.path], item.gitChange!.repositoryId);
				if (status) await this.refreshGitSource(status);
			}, change.staged));
		}
		const resources = new DisposableStore();
		const scoped = resources.add(options.fileActions!.contextKeyService.createScoped(container));
		ActiveEditorContext.bindTo(scoped).set(MULTI_DIFF_EDITOR_ID);
		ResourceContext.bindTo(scoped).set((input.goToFile ?? input.modified).resource.toString());
		const toolbar = resources.add(new MenuWorkbenchToolBar(container, options.fileActions!.menuService, contextMenuProvider, MenuId.MultiDiffEditorFileToolbar, {
			ariaLabel: localize('multiDiff.fileActions', '{0} actions', input.label),
			presentation: 'inherit-foreground',
			contextKeyService: scoped,
			menuOptions: { arg: input.goToFile ?? input.modified },
		}));
		toolbar.setTrailingActions(actions.map(action => bindActionContext(action, () => input)));
		return resources;
	}

	private getEditorOptions(): Pick<MultiDiffEditorOptions, 'lineHeight' | 'fontFamily' | 'fontSize' | 'fontLigatures' | 'showLineNumbers' | 'showInlineChanges' | 'loopChanges'> {
		return {
			lineHeight: this.options.lineHeight ?? this.configuration.getValue(CodeEditorConfiguration.lineHeight),
			fontFamily: this.options.fontFamily ?? (this.configuration.getValue<string>(CodeEditorConfiguration.fontFamily) || undefined),
			fontSize: this.options.fontSize ?? this.configuration.getValue(CodeEditorConfiguration.fontSize),
			fontLigatures: this.options.fontLigatures ?? this.configuration.getValue(CodeEditorConfiguration.fontLigatures),
			showLineNumbers: this.options.showLineNumbers ?? this.configuration.getValue(CodeEditorConfiguration.diffShowLineNumbers),
			showInlineChanges: this.options.showInlineChanges ?? this.configuration.getValue(CodeEditorConfiguration.diffShowInlineChanges),
			loopChanges: this.options.loopChanges ?? this.configuration.getValue(CodeEditorConfiguration.diffLoopChanges),
		};
	}

	private createToolbar(): void {
		if (!this.options.fileActions) return;
		this.toolbar.value = this.instantiationService.createInstance(MultiDiffEditorToolbar, {
			container: this.domNode,
			input: this.paneInput,
			contextMenuProvider: this.options.fileActions.contextMenuProvider,
			gitService: this.options.gitService,
			editorService: this.options.editorService,
			viewsService: this.options.viewsService,
			collapseAll: () => this.editor?.collapseAll(),
			expandAll: () => this.editor?.expandAll(),
		});
		this.domNode.prepend(this.toolbar.value.domNode);
	}

	private createItems(input: MultiDiffEditorInput, resources: DisposableStore): IDocumentDiffItem[] {
		const abort = new AbortController();
		const cancel = (): void => abort.abort();
		this.abortController.signal.addEventListener('abort', cancel, { once: true });
		resources.add(toDisposable(() => this.abortController.signal.removeEventListener('abort', cancel)));
		if (this.abortController.signal.aborted) cancel();
		resources.add(toDisposable(() => abort.abort()));
		this.inputsById.clear();
		return input.items.map(item => {
			const id = multiDiffEditorItemKey(item);
			this.inputsById.set(id, item);
			return resources.add(new DocumentDiffItem({
				id, label: item.label,
				originalLabel: item.original.label, modifiedLabel: item.modified.label,
				readOnly: item.modified.readOnly,
			}, () => this.loadItem(item, this.options.modelService, this.computationService, this.configuration, resources, abort.signal)));
		});
	}

	private async refreshGitSource(status: GitStatus): Promise<void> {
		const source = this.paneInput.source;
		if (source?.kind !== 'git' || !this.options.gitService || source.repositoryId !== status.repositoryId) return;
		const key = `${status.streamInstanceId}:${status.revision}`;
		if (key === this.refreshStatusKey) return;
		this.refreshStatusKey = key;
		const generation = ++this.refreshGeneration;
		try {
			const next = await createGitMultiDiffEditorInput(this.options.gitService, source.scope, status, this.label);
			if (this.isDisposed || this.abortController.signal.aborted || generation !== this.refreshGeneration) return;
			const state = this.editor?.saveViewState();
			const resources = new DisposableStore();
			const items = this.createItems(next, resources);
			this.paneInput = next;
			this.model.setItems(items);
			this.itemResources.value = resources;
			if (state) this.editor?.restoreViewState(state);
			this.emptyDomNode.hidden = items.length > 0;
			this.createToolbar();
		} catch (error) {
			if (generation !== this.refreshGeneration || this.isDisposed) return;
			this.refreshStatusKey = undefined;
			throw error;
		}
	}

}

class PaneAction implements IAction {
	constructor(readonly id: string, readonly label: string, readonly tooltip: string, readonly icon: IAction['icon'], readonly enabled: boolean, private readonly execute: (input: MultiDiffEditorInputItem) => unknown, readonly checked?: boolean) { }

	public run(context?: unknown): unknown {
		return this.execute(context as MultiDiffEditorInputItem);
	}
}
