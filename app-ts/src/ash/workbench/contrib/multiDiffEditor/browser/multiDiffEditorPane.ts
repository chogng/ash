import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
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
import { DocumentDiffItem, MultiDiffEditorModel, type IDocumentDiffItem } from '../../../../editor/browser/widget/multiDiffEditor/model.js';
import { bindActionContext } from '../../../../editor/browser/widget/multiDiffEditor/utils.js';
import { type MultiDiffEditorLocation } from '../../../../editor/browser/widget/multiDiffEditor/multiDiffEditorViewModel.js';
import { DiffModel } from '../../../../editor/common/diff/diffModel.js';
import { type IDocumentDiffProvider } from '../../../../editor/common/diff/documentDiffProvider.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { type ITextModelResourceService } from '../../../services/textmodelResolver/common/textModelResourceService.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import type { IMenuService } from '../../../../platform/actions/common/menuService.js';
import type { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { type EditorInput } from '../../../browser/parts/editor/editorInput.js';
import { type IEditorPaneWithViewState } from '../../../browser/parts/editor/editorPane.js';
import { EditorPaneVisibility } from '../../../browser/parts/editor/editorPane.js';
import type { IChatService } from '../../../services/chat/common/chatService.js';
import type { IEditorService } from '../../../services/editor/common/editorService.js';
import type { IGitService } from '../../../services/git/common/gitService.js';
import type { IViewsService } from '../../../services/views/browser/viewsService.js';
import type { ISessionsManagementService } from '../../../../sessions/services/sessions/common/sessionsManagementService.js';
import { GIT_VIEW_ID } from '../../scm/browser/scmViewPane.js';
import { createGitMultiDiffEditorInput } from './scmMultiDiffAction.js';
import { isMultiDiffEditorInput, MULTI_DIFF_EDITOR_ID, multiDiffEditorItemKey, type MultiDiffEditorInput, type MultiDiffEditorInputItem } from './multiDiffEditorInput.js';
import { MultiDiffEditorToolbar } from './multiDiffEditorToolbar.js';
import { CodeEditorConfiguration, getDiffComputationOptions, getDiffWordWrap } from '../../codeEditor/common/editorConfiguration.js';

export interface MultiDiffEditorPaneOptions {
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
	readonly chatService?: IChatService;
	readonly sessionsService?: ISessionsManagementService;
	readonly editorService?: IEditorService;
	readonly viewsService?: IViewsService;
	readonly fileActions?: {
		readonly menuService: IMenuService;
		readonly contextMenuProvider: IContextMenuProvider;
		readonly contextKeyService?: IContextKeyService;
	};
}

/** Workbench pane that loads visible comparisons and hosts the generic editor widget. */
export class MultiDiffEditorPane extends Disposable implements IEditorPaneWithViewState {
	public readonly id = MULTI_DIFF_EDITOR_ID;
	public readonly viewStateTypeId = 'ash.multiDiffEditor';
	private readonly session = this._register(new MutableDisposable<MultiDiffEditorPaneSession>());
	private readonly pendingSession = this._register(new MutableDisposable<MultiDiffEditorPaneSession>());
	private editorContainerDomNode: HTMLDivElement | undefined;
	private dimension: IDimension = { width: 0, height: 0 };

	constructor(
		private readonly options: MultiDiffEditorPaneOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		if (!options || typeof options !== 'object' || typeof options.createComputationService !== 'function') {
			this.dispose();
			throw new TypeError('Multi-diff editor pane requires a Workbench diff computation service');
		}
		if (!options.modelService || typeof options.modelService.acquire !== 'function') {
			this.dispose();
			throw new TypeError('Multi-diff editor pane requires a text model service');
		}
	}

	public create(parent: HTMLElement): void {
		if (this.editorContainerDomNode) throw new ReferenceError('MultiDiffEditorPane has already been created');
		const editorContainerDomNode = h(parent.ownerDocument, 'div');
		editorContainerDomNode.className = 'stanza-multi-diff-editor-pane';
		parent.append(editorContainerDomNode);
		this.editorContainerDomNode = editorContainerDomNode;
		this._register(toDisposable(() => {
			editorContainerDomNode.remove();
			this.editorContainerDomNode = undefined;
		}));
	}

	public async setInput(input: EditorInput, signal: AbortSignal): Promise<void> {
		if (!isMultiDiffEditorInput(input)) throw new TypeError('Multi-diff editor pane requires a multi-diff editor input');
		const container = this.requireContainer();
		throwIfCancelled(signal, 'Multi-diff editor input loading was cancelled');
		let next: MultiDiffEditorPaneSession | undefined;
		try {
			next = this.instantiationService.createInstance(
				MultiDiffEditorPaneSession, container, input,
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
		this.options.viewsService?.focusView(GIT_VIEW_ID);
	}

	public clearInput(): void {
		this.pendingSession.clear();
		this.session.clear();
	}

	public layout(dimension: IDimension): void {
		this.dimension = { width: Math.max(0, dimension.width), height: Math.max(0, dimension.height) };
		this.session.value?.layout(this.dimension);
	}

	public setVisible(visibility: EditorPaneVisibility): void {
		if (!this.editorContainerDomNode) return;
		this.editorContainerDomNode.hidden = visibility === EditorPaneVisibility.Hidden;
		if (visibility === EditorPaneVisibility.Visible) this.session.value?.layout(this.dimension);
	}

	public focus(): void {
		this.session.value?.focus();
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

class MultiDiffEditorPaneSession extends Disposable {
	public readonly editor: MultiDiffEditorWidget | undefined;
	private readonly models: DiffModel[] = [];
	private readonly abortController = new AbortController();
	private readonly domNode: HTMLDivElement;
	private readonly editorDomNode: HTMLDivElement;
	private toolbar: MultiDiffEditorToolbar | undefined;

	constructor(
		container: HTMLElement,
		paneInput: MultiDiffEditorInput,
		label: string,
		options: MultiDiffEditorPaneOptions,
		initialSignal: AbortSignal,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configuration: IConfigurationService,
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
			const items: IDocumentDiffItem[] = paneInput.items.map(input => this._register(new DocumentDiffItem({
				id: multiDiffEditorItemKey(input),
				label: input.label,
				originalLabel: input.original.label,
				modifiedLabel: input.modified.label,
				readOnly: input.modified.readOnly,
			}, () => this.loadItem(input, options.modelService, computationService, configuration))));
			const model = this._register(new MultiDiffEditorModel(items));
			this._register(configuration.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration(CodeEditorConfiguration.diffWordWrap)
					|| event.affectsConfiguration(CodeEditorConfiguration.wordWrap)) {
					this.editor?.setConfiguredWordWrap(getDiffWordWrap(configuration));
				}
				for (const model of this.models) {
					const languageId = model.modified.getLanguageId();
					if (event.affectsConfiguration(CodeEditorConfiguration.diffIgnoreTrimWhitespace, { overrideIdentifier: languageId })
						|| event.affectsConfiguration(CodeEditorConfiguration.diffMaxComputationTime, { overrideIdentifier: languageId })) {
						model.updateOptions(getDiffComputationOptions(configuration, languageId));
					}
				}
			}));
			const inputsById = new Map(paneInput.items.map(item => [multiDiffEditorItemKey(item), item]));
			const fileActions = options.fileActions;
			if (options.fileActions) {
				this.toolbar = this._register(instantiationService.createInstance(MultiDiffEditorToolbar, {
					container: this.domNode,
					input: paneInput,
					contextMenuProvider: options.fileActions.contextMenuProvider,
					gitService: options.gitService,
					chatService: options.chatService,
					sessionsService: options.sessionsService,
					editorService: options.editorService,
					viewsService: options.viewsService,
					collapseAll: () => this.editor?.collapseAll(),
					expandAll: () => this.editor?.expandAll(),
				}));
				this.domNode.prepend(this.toolbar.domNode);
			}
			this._register(toDisposable(() => this.abortController.abort()));
			if (items.length === 0) {
				const emptyDomNode = h(container.ownerDocument, 'div');
				emptyDomNode.className = 'stanza-multi-diff-editor-empty';
				emptyDomNode.textContent = 'No changes in this selection.';
				this.editorDomNode.append(emptyDomNode);
				return;
			}
			this.editor = this._register(instantiationService.createInstance(MultiDiffEditorWidget, {
				container: this.editorDomNode,
				model,
				wordWrap: getDiffWordWrap(configuration),
				lineHeight: options.lineHeight,
				fontFamily: options.fontFamily,
				fontSize: options.fontSize,
				fontLigatures: options.fontLigatures,
				showLineNumbers: options.showLineNumbers,
				showInlineChanges: options.showInlineChanges,
				loopChanges: options.loopChanges,
				ariaLabel: `${label}, ${items.length} files`,
				...(fileActions ? {
					workbenchUIElementFactory: {
						createItemActions: (container: HTMLElement, item: IDocumentDiffItem) => {
							const input = inputsById.get(item.id);
							if (!input) throw new RangeError(`Unknown multi-diff item '${item.id}'`);
							return this.createFileActions(container, input, options, fileActions.contextMenuProvider, paneInput);
						},
					},
				} : {}),
			}));
		} catch (error) {
			this.dispose();
			throw error;
		}
	}

	public layout(dimension: IDimension): void {
		const toolbarHeight = this.toolbar?.domNode.offsetHeight ?? (this.toolbar ? 40 : 0);
		this.editor?.layout({ width: dimension.width, height: Math.max(0, dimension.height - toolbarHeight) });
	}

	public resolveVisible(): Promise<void> {
		return this.editor?.resolveVisible() ?? Promise.resolve();
	}

	public show(): void {
		this.domNode.classList.remove('pending');
	}

	private async loadItem(input: MultiDiffEditorInputItem, modelService: ITextModelResourceService, computationService: IDocumentDiffProvider, configuration: IConfigurationService): Promise<DiffModel> {
		const resources = this._register(new DisposableStore());
		try {
			const original = await modelService.acquire(input.original, this.abortController.signal);
			if (this.isDisposed || this.abortController.signal.aborted) {
				original.dispose();
				throw new Error('Multi-diff editor input loading was cancelled');
			}
			resources.add(original);
			const modified = await modelService.acquire(input.modified, this.abortController.signal);
			if (this.isDisposed || this.abortController.signal.aborted) {
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
			this.models.push(model);
			return model;
		} catch (error) {
			resources.dispose();
			throw error;
		}
	}

	public focus(): void {
		this.editor?.focus();
	}

	private createFileActions(container: HTMLElement, input: MultiDiffEditorInputItem, options: MultiDiffEditorPaneOptions, contextMenuProvider: IContextMenuProvider, sourceInput?: MultiDiffEditorInput): WorkbenchToolBar {
		const actions: IAction[] = [new PaneAction('multiDiff.openFile', 'Open File', 'Open File', Lxicon.linkExternal, true, item => options.editorService?.openEditor(item.goToFile ?? item.modified))];
		const change = input.gitChange;
		if (change) {
			actions.push(new PaneAction('multiDiff.discardFile', 'Discard Changes', 'Discard Changes', Lxicon.discard, change.hasWorktreeChanges, async item => {
				if (container.ownerDocument.defaultView?.confirm(`Discard changes in ${item.gitChange!.path}? This cannot be undone.`) !== true) return;
				await options.gitService?.discardWorktree([item.gitChange!.path], item.gitChange!.repositoryId);
				await this.refreshGitSource(sourceInput, options);
			}));
			actions.push(new PaneAction(change.staged ? 'multiDiff.unstageFile' : 'multiDiff.stageFile', change.staged ? 'Unstage Changes' : 'Stage Changes', change.staged ? 'Unstage Changes' : 'Stage Changes', change.staged ? Lxicon.remove : Lxicon.check, options.gitService !== undefined, async item => {
				if (item.gitChange!.staged) await options.gitService?.unstage([item.gitChange!.path], item.gitChange!.repositoryId);
				else await options.gitService?.stage([item.gitChange!.path], item.gitChange!.repositoryId);
				await this.refreshGitSource(sourceInput, options);
			}, change.staged));
		}
		const toolbar = new WorkbenchToolBar(container, contextMenuProvider, { ariaLabel: `${input.label} actions`, presentation: 'inherit-foreground' });
		toolbar.setActions(actions.map(action => bindActionContext(action, () => input)));
		return toolbar;
	}

	private async refreshGitSource(input: MultiDiffEditorInput | undefined, options: MultiDiffEditorPaneOptions): Promise<void> {
		if (input?.source?.kind !== 'git' || !options.gitService || !options.editorService) return;
		const next = await createGitMultiDiffEditorInput(options.gitService, input.source.scope);
		await options.editorService.openEditor(next, { pinned: true });
	}
}

class PaneAction implements IAction {
	constructor(readonly id: string, readonly label: string, readonly tooltip: string, readonly icon: IAction['icon'], readonly enabled: boolean, private readonly execute: (input: MultiDiffEditorInputItem) => unknown, readonly checked?: boolean) {}

	public run(context?: unknown): unknown {
		return this.execute(context as MultiDiffEditorInputItem);
	}
}
