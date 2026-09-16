import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import './media/multiDiffEditorPane.css';
import type { IContextMenuProvider } from '../../../../base/browser/contextmenu.js';
import { h } from '../../../../base/browser/dom.js';
import { type IDimension } from '../../../../base/browser/dom.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import type { IAction } from '../../../../base/common/actions.js';
import { lxiconsLibrary } from '../../../../base/common/lxiconsLibrary.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { assertDefined } from '../../../../base/common/types.js';
import { MultiDiffEditorWidget, type MultiDiffEditorItem, type MultiDiffEditorLocation } from '../../../../editor/browser/widget/multiDiffEditor/multiDiffEditorWidget.js';
import { DiffModel } from '../../../../editor/common/diff/diffModel.js';
import { type IDiffComputationService } from '../../../../editor/common/diff/diffComputationService.js';
import { type ITextModelResourceService, type TextModelReference } from '../../../../editor/common/services/textModelResourceService.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import type { IMenuService } from '../../../../platform/actions/common/menuService.js';
import type { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { type EditorInput } from '../../../browser/parts/editor/editorInput.js';
import { type IEditorPane } from '../../../browser/parts/editor/editorPane.js';
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

export interface MultiDiffEditorPaneOptions {
	readonly modelService: ITextModelResourceService;
	readonly createComputationService: () => IDiffComputationService;
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

interface ResolvedMultiDiffItem {
	readonly input: MultiDiffEditorInputItem;
	readonly original: TextModelReference;
	readonly modified: TextModelReference;
}

/** Workbench pane that resolves multi-diff inputs and hosts the generic editor widget. */
export class MultiDiffEditorPane extends Disposable implements IEditorPane {
	public readonly id = MULTI_DIFF_EDITOR_ID;
	private readonly session = this._register(new MutableDisposable<MultiDiffEditorPaneSession>());
	private editorContainerDomNode: HTMLDivElement | undefined;
	private dimension: IDimension = { width: 0, height: 0 };

	constructor(private readonly options: MultiDiffEditorPaneOptions, @IInstantiationService private readonly instantiationService: IInstantiationService) {
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
		const resolved: ResolvedMultiDiffItem[] = [];
		let referencesOwnedBySession = false;
		let next: MultiDiffEditorPaneSession | undefined;
		try {
			for (const item of input.items) {
				const original = await this.options.modelService.acquire(item.original, signal);
				let modified: TextModelReference | undefined;
				try {
					throwIfCancelled(signal, 'Multi-diff editor input loading was cancelled');
					modified = await this.options.modelService.acquire(item.modified, signal);
					resolved.push({ input: item, original, modified });
				} catch (error) {
					modified?.dispose();
					original.dispose();
					throw error;
				}
			}
			throwIfCancelled(signal, 'Multi-diff editor input loading was cancelled');
			referencesOwnedBySession = true;
			next = this.instantiationService.createInstance(MultiDiffEditorPaneSession, container, resolved, input.label ?? 'Changes', this.options, input);
			throwIfCancelled(signal, 'Multi-diff editor input loading was cancelled');
		} catch (error) {
			next?.dispose();
			if (!referencesOwnedBySession) disposeResolvedItems(resolved);
			throw error;
		}
		this.session.value = next;
		next.layout(this.dimension);
		this.options.viewsService?.focusView(GIT_VIEW_ID);
	}

	public clearInput(): void {
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

	public nextChange(): MultiDiffEditorLocation | undefined {
		return this.session.value?.editor?.nextChange();
	}

	public previousChange(): MultiDiffEditorLocation | undefined {
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
	private readonly domNode: HTMLDivElement;
	private readonly editorDomNode: HTMLDivElement;
	private toolbar: MultiDiffEditorToolbar | undefined;

	constructor(container: HTMLElement, resolved: readonly ResolvedMultiDiffItem[], label: string, options: MultiDiffEditorPaneOptions, paneInput: MultiDiffEditorInput | undefined, @IInstantiationService instantiationService: IInstantiationService) {
		super();
		try {
			this.domNode = h(container.ownerDocument, 'div');
			this.domNode.className = 'stanza-multi-diff-editor-session';
			this.editorDomNode = h(container.ownerDocument, 'div');
			this.editorDomNode.className = 'stanza-multi-diff-editor-host';
			this.domNode.append(this.editorDomNode);
			container.append(this.domNode);
			this._register(toDisposable(() => this.domNode.remove()));
			for (const item of resolved) {
				this._register(item.original);
				this._register(item.modified);
			}
			const computationService = options.createComputationService();
			if (!computationService || typeof computationService.compute !== 'function') {
				throw new TypeError('Multi-diff editor pane factory returned an invalid Workbench diff computation service');
			}
			this._register(computationService);
			const items: MultiDiffEditorItem[] = resolved.map((item) => ({
				id: multiDiffEditorItemKey(item.input),
				label: item.input.label,
				originalLabel: item.input.original.label,
				modifiedLabel: item.input.modified.label,
				model: this._register(new DiffModel({
					original: item.original.model,
					modified: item.modified.model,
					computationService,
				})),
			}));
			const inputsById = new Map(resolved.map((item) => [multiDiffEditorItemKey(item.input), item.input]));
			const fileActions = options.fileActions;
			if (paneInput && options.fileActions) {
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
			if (items.length === 0) {
				const emptyDomNode = h(container.ownerDocument, 'div');
				emptyDomNode.className = 'stanza-multi-diff-editor-empty';
				emptyDomNode.textContent = 'No changes in this selection.';
				this.editorDomNode.append(emptyDomNode);
				return;
			}
			this.editor = this._register(new MultiDiffEditorWidget({
				container: this.editorDomNode,
				items,
				lineHeight: options.lineHeight,
				fontFamily: options.fontFamily,
				fontSize: options.fontSize,
				fontLigatures: options.fontLigatures,
				showLineNumbers: options.showLineNumbers,
				showInlineChanges: options.showInlineChanges,
				loopChanges: options.loopChanges,
				ariaLabel: `${label}, ${items.length} files`,
				...(fileActions ? {
					createItemActions: (container: HTMLElement, item: MultiDiffEditorItem) => {
						const input = inputsById.get(item.id);
						if (!input) throw new RangeError(`Unknown multi-diff item '${item.id}'`);
						return this.createFileActions(container, input, options, fileActions.contextMenuProvider, paneInput);
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

	public focus(): void {
		this.editor?.domNode.focus({ preventScroll: true });
	}

	private createFileActions(container: HTMLElement, input: MultiDiffEditorInputItem, options: MultiDiffEditorPaneOptions, contextMenuProvider: IContextMenuProvider, sourceInput?: MultiDiffEditorInput): WorkbenchToolBar {
		const actions: IAction[] = [new PaneAction('multiDiff.openFile', 'Open File', 'Open File', lxiconsLibrary.linkExternal, true, () => options.editorService?.openEditor(input.goToFile ?? input.modified))];
		const change = input.gitChange;
		if (change) {
			actions.push(new PaneAction('multiDiff.discardFile', 'Discard Changes', 'Discard Changes', lxiconsLibrary.discard, change.hasWorktreeChanges, async () => {
				if (container.ownerDocument.defaultView?.confirm(`Discard changes in ${change.path}? This cannot be undone.`) !== true) return;
				await options.gitService?.discardWorktree([change.path], change.repositoryId);
				await this.refreshGitSource(sourceInput, options);
			}));
			actions.push(new PaneAction(change.staged ? 'multiDiff.unstageFile' : 'multiDiff.stageFile', change.staged ? 'Unstage Changes' : 'Stage Changes', change.staged ? 'Unstage Changes' : 'Stage Changes', change.staged ? lxiconsLibrary.remove : lxiconsLibrary.check, options.gitService !== undefined, async () => {
				if (change.staged) await options.gitService?.unstage([change.path], change.repositoryId);
				else await options.gitService?.stage([change.path], change.repositoryId);
				await this.refreshGitSource(sourceInput, options);
			}, change.staged));
		}
		const toolbar = new WorkbenchToolBar(container, contextMenuProvider, { ariaLabel: `${input.label} actions`, presentation: 'inherit-foreground' });
		toolbar.setActions(actions);
		return toolbar;
	}

	private async refreshGitSource(input: MultiDiffEditorInput | undefined, options: MultiDiffEditorPaneOptions): Promise<void> {
		if (input?.source?.kind !== 'git' || !options.gitService || !options.editorService) return;
		const next = await createGitMultiDiffEditorInput(options.gitService, input.source.scope);
		await options.editorService.openEditor(next, { pinned: true });
	}
}

class PaneAction implements IAction {
	constructor(readonly id: string, readonly label: string, readonly tooltip: string, readonly icon: IAction['icon'], readonly enabled: boolean, private readonly execute: () => unknown, readonly checked?: boolean) {}

	public run(): unknown {
		return this.execute();
	}
}

function disposeResolvedItems(items: readonly ResolvedMultiDiffItem[]): void {
	for (let index = items.length - 1; index >= 0; index -= 1) {
		items[index]!.modified.dispose();
		items[index]!.original.dispose();
	}
}
