import { structuralEquals } from '../../../../base/common/equals.js';
import { EditorInputSerializers } from '../../../services/editor/common/editorInputSerializer.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { Icon } from '../../../../base/common/icon.js';
import { IMultiDiffSourceResolverService } from './multiDiffSourceResolverService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { IResourceEditorInput, ISaveOptions } from '../../../common/editor.js';
import { Emitter } from '../../../../base/common/event.js';
import { IWorkingCopyService, type IWorkingCopy } from '../../../services/workingCopy/common/workingCopyService.js';
import { EditorWorkingCopy } from '../../../browser/parts/editor/textResourceEditor.js';
import { TextFileBinaryError } from '../../../services/textfile/common/textFileService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import './media/multiDiffEditorPane.css';
import type { IContextMenuProvider } from '../../../../base/browser/contextmenu.js';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { IconLabel } from '../../../../base/browser/ui/iconlabel/iconlabel.js';
import { type IDimension } from '../../../../base/browser/dom.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import type { IAction } from '../../../../base/common/actions.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { assertDefined, isRecord } from '../../../../base/common/types.js';
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
import type { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { type IEditorPaneWithViewState } from '../../../browser/parts/editor/editorWithViewState.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import type { IEditorService } from '../../../services/editor/common/editorService.js';
import type { IViewsService } from '../../../services/views/common/viewsService.js';
import { VIEW_PANE_ID } from '../../scm/common/scm.js';
import { createMultiDiffEditorInput, isMultiDiffEditorInput, MULTI_DIFF_EDITOR_ID, multiDiffEditorItemKey, type MultiDiffEditorInput, type MultiDiffEditorInputItem } from './multiDiffEditorInput.js';
import { MultiDiffEditorToolbar } from './multiDiffEditorToolbar.js';
import { localize } from '../../../../nls.js';
import { extname } from '../../../../base/common/path.js';
import { basename, dirname } from '../../../../base/common/resources.js';
import { Range } from '../../../../editor/common/core/range.js';
import { URI } from '../../../../base/common/uri.js';
import type { IMultiDiffEditorOptionsViewState } from '../../../../editor/common/multiDiffEditor.js';
import {
	ActiveEditorContext,
	ActiveEditorReadonlyContext,
	ResourceContext,
	ResourceSchemeContext,
	ResourcePathContext,
	ResourceFilenameContext,
	ResourceDirnameContext,
	ResourceExtensionContext,
	ResourceLanguageIdContext,
	ResourceSetContext,
} from '../../../common/contextkeys.js';
import { CodeEditorConfiguration } from '../../codeEditor/common/editorConfiguration.js';
import { getDiffComputationOptions, getDiffWordWrap } from '../../../services/editor/common/editorConfiguration.js';
import { IResourceIconRenderer } from '../../../browser/labels.js';

export const MultiDiffEditorAllCollapsed = new RawContextKey<boolean>('multiDiffEditorAllCollapsed', false);
export const MultiDiffEditorHideUnchangedRegions = new RawContextKey<boolean>('multiDiffEditorHideUnchangedRegions', true);

export interface MultiDiffEditorOptions {
	/** A composed editor retains its own menu identity while reusing this comparison widget. */
	readonly activeEditorId?: string;
	readonly modelService: ITextModelResourceService;
	readonly createComputationService: () => IDocumentDiffProvider & IDisposable;
	readonly lineHeight?: number;
	readonly wordWrapColumn?: number;
	readonly fontFamily?: string;
	readonly fontSize?: number;
	readonly fontLigatures?: boolean;
	readonly showLineNumbers?: boolean;
	readonly showInlineChanges?: boolean;
	readonly loopChanges?: boolean;
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
	private readonly workingCopiesEmitter = this._register(new Emitter<void>());
	private readonly workingCopiesListener = this._register(new MutableDisposable<IDisposable>());
	private readonly collapseStateListener = this._register(new MutableDisposable<IDisposable>());
	private readonly hideUnchangedRegionsListener = this._register(new MutableDisposable<IDisposable>());
	public readonly onDidChangeWorkingCopies = this.workingCopiesEmitter.event;

	public getWorkingCopies(): readonly IWorkingCopy[] {
		return this.session.value?.workingCopies ?? [];
	}

	public get workingCopy(): IWorkingCopy | undefined {
		return this.session.value?.getActiveWorkingCopy();
	}

	public async save(options?: ISaveOptions): Promise<void> {
		await this.session.value?.save(options);
	}

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
		this._register(
			toDisposable(() => {
				editorContainerDomNode.remove();
				this.editorContainerDomNode = undefined;
			}),
		);
	}

	public override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		if (!isMultiDiffEditorInput(input)) throw new TypeError('Multi-diff editor pane requires a multi-diff editor input');
		const container = this.requireContainer();
		throwIfCancelled(signal, 'Multi-diff editor input loading was cancelled');
		let next: MultiDiffEditorSession | undefined;
		try {
			next = this.instantiationService.createInstance(MultiDiffEditorSession, container, input, input.label ?? 'Changes', this.options, signal);
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
		this.workingCopiesListener.value = this.session.value?.onDidChangeWorkingCopies(() => this.workingCopiesEmitter.fire());
		this.collapseStateListener.value = this.session.value?.editor?.onDidChangeCollapseState(() => this.updateCollapseContext());
		this.hideUnchangedRegionsListener.value = this.session.value?.editor?.onDidChangeHideUnchangedRegions(() => this.updateCollapseContext());
		this.updateCollapseContext();
		this.workingCopiesEmitter.fire();
		this.session.value?.show();
		if (input.source?.kind !== 'snapshot') {
			await this.options.viewsService?.focusView(VIEW_PANE_ID);
		}
	}

	public override clearInput(): void {
		this.collapseStateListener.clear();
		this.hideUnchangedRegionsListener.clear();
		this.workingCopiesListener.clear();
		this.pendingSession.clear();
		this.session.clear();
		this.updateCollapseContext();
		this.workingCopiesEmitter.fire();
	}

	public override layout(dimension: IDimension): void {
		this.dimension = { width: Math.max(0, dimension.width), height: Math.max(0, dimension.height) };
		this.session.value?.layout(this.dimension);
	}

	public override setVisible(visibility: boolean): void {
		super.setVisible(visibility);
		if (visibility) this.session.value?.layout(this.dimension);
		if (visibility) this.updateCollapseContext();
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
		if (isRecord(state) && (Object.keys(state).length === 0 || 'revealData' in state)) {
			const reveal = state.revealData;
			if (reveal === undefined) {
				return;
			}
			if (
				!isRecord(reveal) ||
				!isRecord(reveal.resource) ||
				![reveal.resource.original, reveal.resource.modified].some(resource => resource instanceof URI) ||
				![reveal.resource.original, reveal.resource.modified].every(resource => resource === undefined || resource instanceof URI) ||
				(reveal.range !== undefined &&
					(!Range.isIRange(reveal.range) ||
						![reveal.range.startLineNumber, reveal.range.startColumn, reveal.range.endLineNumber, reveal.range.endColumn].every(value => Number.isSafeInteger(value) && value > 0)))
			) {
				throw new TypeError('Invalid multi-diff editor view state');
			}
			const options = reveal as unknown as NonNullable<IMultiDiffEditorOptionsViewState['revealData']>;
			editor.reveal(options.resource, {
				range: options.range ? Range.lift(options.range) : undefined,
				highlight: false,
			});
			return;
		}
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

	public toggleCollapseAll(): void {
		this.session.value?.editor?.toggleCollapseAll();
	}

	private updateCollapseContext(): void {
		// Retained hidden tabs must not overwrite the active editor's title state.
		if (this.isVisible()) {
			this.options.fileActions?.contextKeyService.setContext(MultiDiffEditorAllCollapsed.key, this.session.value?.editor?.allCollapsed ?? false);
			this.options.fileActions?.contextKeyService.setContext(MultiDiffEditorHideUnchangedRegions.key, this.session.value?.editor?.collapseUnchangedRegions ?? true);
		}
	}

	public toggleCollapseUnchangedRegions(): Promise<void> | undefined {
		return this.session.value?.editor?.toggleCollapseUnchangedRegions();
	}

	private requireContainer(): HTMLDivElement {
		assertDefined(this.editorContainerDomNode, new ReferenceError('Multi-diff editor pane has not been created'));
		return this.editorContainerDomNode;
	}
}

class MultiDiffEditorSession extends Disposable {
	private readonly copies = new Map<string, IWorkingCopy>();
	private readonly copiesEmitter = this._register(new Emitter<void>());
	public readonly onDidChangeWorkingCopies = this.copiesEmitter.event;
	public get workingCopies(): readonly IWorkingCopy[] {
		return [...this.copies.values()];
	}
	public readonly editor: MultiDiffEditorWidget | undefined;
	private readonly models = new Set<DiffModel>();
	private readonly idleComparisons = new Map<DocumentDiffItem, number>();
	private readonly itemResources = this._register(new MutableDisposable<DisposableStore>());
	private readonly model: MultiDiffEditorModel;
	private readonly inputsById = new Map<string, MultiDiffEditorInputItem>();
	private refreshGeneration = 0;
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
		@ICommandService private readonly commandService: ICommandService,
		@IMultiDiffSourceResolverService private readonly sourceResolvers: IMultiDiffSourceResolverService,
		@IWorkingCopyService private readonly workingCopyService: IWorkingCopyService,
		@IResourceIconRenderer private readonly resourceIcons: IResourceIconRenderer,
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
			this._register(addDisposableListener(initialSignal, 'abort', abort, { once: true }));
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
			this._register(
				configuration.onDidChangeConfiguration(event => {
					if (event.affectsConfiguration(CodeEditorConfiguration.diffWordWrap) || event.affectsConfiguration(CodeEditorConfiguration.wordWrap)) {
						this.editor?.setConfiguredWordWrap(getDiffWordWrap(configuration));
					}
					if (
						[
							CodeEditorConfiguration.wordWrapColumn,
							CodeEditorConfiguration.lineHeight,
							CodeEditorConfiguration.fontFamily,
							CodeEditorConfiguration.fontSize,
							CodeEditorConfiguration.fontLigatures,
							CodeEditorConfiguration.diffShowLineNumbers,
							CodeEditorConfiguration.diffShowInlineChanges,
							CodeEditorConfiguration.diffLoopChanges,
						].some(key => event.affectsConfiguration(key))
					) {
						this.editor?.updateOptions(this.getEditorOptions());
					}
					for (const model of this.models) {
						const languageId = model.modified.getLanguageId();
						if (
							event.affectsConfiguration(CodeEditorConfiguration.diffIgnoreTrimWhitespace, {
								overrideIdentifier: languageId,
							}) ||
							event.affectsConfiguration(CodeEditorConfiguration.diffMaxComputationTime, {
								overrideIdentifier: languageId,
							}) ||
							event.affectsConfiguration('diffEditor.experimental.showMoves')
						) {
							model.updateOptions(getDiffComputationOptions(configuration, languageId));
						}
					}
				}),
			);
			const fileActions = options.fileActions;
			this._register(toDisposable(() => this.abortController.abort()));
			this.emptyDomNode = h(container.ownerDocument, 'div');
			this.emptyDomNode.className = 'stanza-multi-diff-editor-empty';
			this.emptyDomNode.textContent = localize('multiDiff.empty', 'No changes in this selection.');
			this.editor = this._register(
				instantiationService.createInstance(MultiDiffEditorWidget, {
					container: this.editorDomNode,
					model: this.model,
					wordWrap: getDiffWordWrap(configuration),
					...this.getEditorOptions(),
					...(fileActions
						? {
								workbenchUIElementFactory: {
									createResourceLabel: (container: HTMLElement, item: IDocumentDiffItem) => {
										const input = this.inputsById.get(item.id);
										if (!input) throw new RangeError(`Unknown multi-diff item '${item.id}'`);
										const resource = (input.goToFile ?? input.modified).resource;
										const resources = new DisposableStore();
										const label = resources.add(new IconLabel(container, { label: item.label, title: item.label }));
										const render = (): void => {
											const hasFileIcons = this.resourceIcons.getFileIconTheme().hasFileIcons;
											label.setIcon(undefined, hasFileIcons ? target => this.resourceIcons.renderFileIcon(resource, target) : undefined, hasFileIcons);
										};
										render();
										resources.add(this.resourceIcons.onDidChangeResourceIcons(render));
										return resources;
									},
									createItemActions: (container: HTMLElement, item: IDocumentDiffItem) => {
										const input = this.inputsById.get(item.id);
										if (!input) throw new RangeError(`Unknown multi-diff item '${item.id}'`);
										return this.createFileActions(container, item, input, options, fileActions.contextMenuProvider);
									},
								},
							}
						: {}),
				}),
			);
			this.createToolbar();
			this.updateEmptyState();
			this._register(
				this.sourceResolvers.onDidChange(() => {
					void this.refreshSource().catch(error => {
						if (!this.isDisposed) void this.dialogs.error(String(error));
					});
				}),
			);
			void this.refreshSource().catch(error => {
				if (!this.isDisposed) void this.dialogs.error(String(error));
			});
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

	private async loadItem(
		input: MultiDiffEditorInputItem,
		modelService: ITextModelResourceService,
		computationService: IDocumentDiffProvider,
		configuration: IConfigurationService,
		resources: DisposableStore,
		signal: AbortSignal,
	): Promise<DiffModel | undefined> {
		try {
			const original = await modelService.acquire(input.original, signal);
			if (this.isDisposed || signal.aborted || resources.isDisposed) {
				original.dispose();
				throw new Error('Multi-diff editor input loading was cancelled');
			}
			resources.add(original);
			const modified = await modelService.acquire(input.modified, signal);
			if (this.isDisposed || signal.aborted || resources.isDisposed) {
				modified.dispose();
				throw new Error('Multi-diff editor input loading was cancelled');
			}
			if (input.modified.readOnly === true) {
				resources.add(modified);
			} else {
				const copy = resources.add(new EditorWorkingCopy(modified, input.modified, this.workingCopyService, undefined));
				const id = multiDiffEditorItemKey(input);
				this.copies.set(id, copy);
				resources.add(
					toDisposable(() => {
						if (this.copies.get(id) === copy) {
							this.copies.delete(id);
							if (!this.isDisposed) this.copiesEmitter.fire();
						}
					}),
				);
				this.copiesEmitter.fire();
			}
			const model = resources.add(
				new DiffModel({
					original: original.model,
					modified: modified.model,
					diffProvider: computationService,
					diffOptions: getDiffComputationOptions(configuration, modified.model.getLanguageId()),
				}),
			);
			resources.add(
				modified.model.onDidChangeLanguage(() => {
					model.updateOptions(getDiffComputationOptions(configuration, model.modified.getLanguageId()));
				}),
			);
			this.models.add(model);
			resources.add(toDisposable(() => this.models.delete(model)));
			return model;
		} catch (error) {
			resources.dispose();
			if (error instanceof TextFileBinaryError) return undefined;
			throw error;
		}
	}

	public focus(): void {
		this.editor?.focus();
	}

	public getActiveWorkingCopy(): IWorkingCopy | undefined {
		const item = this.editor?.getActiveItem();
		return item ? this.copies.get(item.id) : undefined;
	}

	public async save(options?: ISaveOptions): Promise<void> {
		// Collapsing or virtualizing a file must not exclude it from an explicit Save.
		await Promise.all(this.model.items.filter(item => !item.binary && !item.readOnly).map(item => item.resolve()));
		throwIfCancelled(this.abortController.signal, 'Multi-diff save was cancelled');
		for (const copy of this.workingCopies) {
			if (copy.isDirty) await copy.save(this.abortController.signal, options);
		}
	}

	public getActiveDiffItem(): MultiDiffEditorInputItem | undefined {
		const item = this.editor?.getActiveItem();
		return item ? this.paneInput.items.find(input => multiDiffEditorItemKey(input) === item.id) : undefined;
	}

	private createFileActions(
		container: HTMLElement,
		item: IDocumentDiffItem,
		input: MultiDiffEditorInputItem,
		options: MultiDiffEditorOptions,
		contextMenuProvider: IContextMenuProvider,
	): IDisposable {
		const actions: IAction[] = [];
		for (const action of input.actions ?? []) {
			actions.push(
				new PaneAction(action.id, action.label, action.tooltip, action.icon ? Icon.fromId(action.icon) : undefined, action.enabled !== false, () =>
					this.commandService.executeCommand(action.command, ...action.arguments),
				),
			);
		}
		const resources = new DisposableStore();
		const scoped = resources.add(options.fileActions!.contextKeyService.createScoped(container));
		ActiveEditorContext.bindTo(scoped).set(options.activeEditorId ?? MULTI_DIFF_EDITOR_ID);
		scoped.createKey('multiDiffEditorFileIsBinary', input.binary === true);
		for (const [key, value] of Object.entries(input.contextKeys ?? {})) {
			scoped.createKey(key, value);
		}
		const resource = (input.goToFile ?? input.modified).resource;
		ActiveEditorReadonlyContext.bindTo(scoped).set(input.modified.readOnly === true);
		ResourceContext.bindTo(scoped).set(resource.toString());
		ResourceSetContext.bindTo(scoped).set(true);
		ResourceSchemeContext.bindTo(scoped).set(resource.scheme);
		ResourcePathContext.bindTo(scoped).set(resource.scheme === 'file' ? resource.fsPath : resource.path);
		ResourceFilenameContext.bindTo(scoped).set(basename(resource));
		ResourceDirnameContext.bindTo(scoped).set(resource.scheme === 'file' ? dirname(resource).fsPath : dirname(resource).path);
		ResourceExtensionContext.bindTo(scoped).set(extname(basename(resource)));
		const language = ResourceLanguageIdContext.bindTo(scoped);
		const languageListener = resources.add(new MutableDisposable<IDisposable>());
		const updateLanguage = (): void => {
			language.set(item.model?.modified.getLanguageId() ?? input.modified.languageId);
			languageListener.value = item.model?.modified.onDidChangeLanguage(() => language.set(item.model!.modified.getLanguageId()));
		};
		resources.add(item.onDidChange(updateLanguage));
		updateLanguage();
		const toolbar = resources.add(
			new MenuWorkbenchToolBar(container, options.fileActions!.menuService, contextMenuProvider, MenuId.MultiDiffEditorFileToolbar, {
				ariaLabel: localize('multiDiff.fileActions', '{0} actions', input.label),
				presentation: 'inherit-foreground',
				contextKeyService: scoped,
				menuOptions: { arg: input.goToFile ?? input.modified },
			}),
		);
		toolbar.setTrailingActions(actions.map(action => bindActionContext(action, () => input)));
		return resources;
	}

	private getEditorOptions(): Pick<MultiDiffEditorOptions, 'lineHeight' | 'fontFamily' | 'fontSize' | 'fontLigatures' | 'showLineNumbers' | 'showInlineChanges' | 'loopChanges' | 'wordWrapColumn'> {
		return {
			lineHeight: this.options.lineHeight ?? this.configuration.getValue(CodeEditorConfiguration.lineHeight),
			wordWrapColumn: this.options.wordWrapColumn ?? this.configuration.getValue(CodeEditorConfiguration.wordWrapColumn),
			fontFamily: this.options.fontFamily ?? (this.configuration.getValue<string>(CodeEditorConfiguration.fontFamily) || undefined),
			fontSize: this.options.fontSize ?? this.configuration.getValue(CodeEditorConfiguration.fontSize),
			fontLigatures: this.options.fontLigatures ?? this.configuration.getValue(CodeEditorConfiguration.fontLigatures),
			showLineNumbers: this.options.showLineNumbers ?? this.configuration.getValue(CodeEditorConfiguration.diffShowLineNumbers),
			showInlineChanges: this.options.showInlineChanges ?? this.configuration.getValue(CodeEditorConfiguration.diffShowInlineChanges),
			loopChanges: this.options.loopChanges ?? this.configuration.getValue(CodeEditorConfiguration.diffLoopChanges),
		};
	}

	private updateEmptyState(): void {
		const empty = this.model.items.length === 0;
		if (this.editor) {
			this.editor.domNode.hidden = empty;
			this.editor.domNode.setAttribute('aria-label', localize('multiDiff.ariaLabel', '{0}, {1} files', this.label, this.model.items.length));
		}
		if (empty) this.editorDomNode.prepend(this.emptyDomNode);
		else this.emptyDomNode.remove();
	}

	private createToolbar(): void {
		const editor = this.editor;
		if (!editor || !this.options.fileActions || !this.paneInput.source || this.paneInput.source.kind === 'snapshot') return;
		this.toolbar.value = this.instantiationService.createInstance(MultiDiffEditorToolbar, {
			container: this.domNode,
			input: this.paneInput,
			contextMenuProvider: this.options.fileActions.contextMenuProvider,
			editorService: this.options.editorService,
			viewsService: this.options.viewsService,
			editor,
		});
		this.domNode.prepend(this.toolbar.value.domNode);
	}

	private createItems(input: MultiDiffEditorInput, resources: DisposableStore): IDocumentDiffItem[] {
		const abort = new AbortController();
		const cancel = (): void => abort.abort();
		resources.add(addDisposableListener(this.abortController.signal, 'abort', cancel, { once: true }));
		if (this.abortController.signal.aborted) cancel();
		resources.add(toDisposable(() => abort.abort()));
		this.inputsById.clear();
		return input.items.map(item => {
			const id = multiDiffEditorItemKey(item);
			this.inputsById.set(id, item);
			const loaded = resources.add(new MutableDisposable<DisposableStore>());
			const comparison = resources.add(
				new DocumentDiffItem(
					{
						id,
						label: item.label,
						binary: item.binary,
						originalUri: item.original.resource,
						modifiedUri: item.modified.resource,
						originalLabel: item.original.label,
						modifiedLabel: item.modified.label,
						readOnly: item.modified.readOnly,
					},
					item.binary
						? undefined
						: () => {
								const lifetime = new DisposableStore();
								loaded.value = lifetime;
								return this.loadItem(item, this.options.modelService, this.computationService, this.configuration, lifetime, abort.signal);
							},
					item.modified.readOnly === true
						? {
								onDidChange: comparison => this.updateComparisonCache(comparison),
								release: () => loaded.clear(),
							}
						: undefined,
				),
			);
			resources.add(toDisposable(() => this.idleComparisons.delete(comparison)));
			return comparison;
		});
	}

	private updateComparisonCache(item: DocumentDiffItem): void {
		this.idleComparisons.delete(item);
		if (!item.isInUse && item.model) {
			// UTF-16 source size is a cheap budget estimate; the item cap also bounds
			// model, token and diff overhead for many small historical comparisons.
			this.idleComparisons.set(item, 2 * (item.model.original.getValueLength() + item.model.modified.getValueLength()));
		}
		let bytes = 0;
		for (const size of this.idleComparisons.values()) bytes += size;
		for (const [candidate, size] of this.idleComparisons) {
			if (this.idleComparisons.size <= 5 && bytes <= 16 * 1024 * 1024) break;
			if (!candidate.release()) continue;
			this.idleComparisons.delete(candidate);
			bytes -= size;
		}
	}

	private async refreshSource(): Promise<void> {
		if (this.paneInput.source?.kind !== 'external') return;
		const generation = ++this.refreshGeneration;
		try {
			const resolved = await this.sourceResolvers.resolve(this.paneInput.resource);
			if (!resolved) return;
			const next = createMultiDiffEditorInput(resolved.resource, resolved.resources, resolved.label, resolved.source);
			if (this.isDisposed || this.abortController.signal.aborted || generation !== this.refreshGeneration) return;
			// An unchanged source snapshot must retain the models used by an in-flight toolbar
			// action. Replacing them would invalidate its reviewed range during the client RPC.
			if (structuralEquals(EditorInputSerializers.serialize(this.paneInput), EditorInputSerializers.serialize(next))) return;
			const state = this.editor?.saveViewState();
			const resources = new DisposableStore();
			const items = this.createItems(next, resources);
			this.paneInput = next;
			this.model.setItems(items);
			this.itemResources.value = resources;
			if (state) this.editor?.restoreViewState(state);
			this.updateEmptyState();
			this.createToolbar();
		} catch (error) {
			if (generation !== this.refreshGeneration || this.isDisposed) return;
			throw error;
		}
	}
}

class PaneAction implements IAction {
	constructor(
		readonly id: string,
		readonly label: string,
		readonly tooltip: string,
		readonly icon: IAction['icon'],
		readonly enabled: boolean,
		private readonly execute: (input: MultiDiffEditorInputItem) => unknown,
		readonly checked?: boolean,
	) {}

	public run(context?: unknown): unknown {
		return this.execute(context as MultiDiffEditorInputItem);
	}
}
