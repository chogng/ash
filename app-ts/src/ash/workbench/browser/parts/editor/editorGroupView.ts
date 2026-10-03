import { addDisposableListener } from "../../../../base/browser/dom.js";
import { Dimension, type IDimension } from "../../../../base/browser/dom.js";
import { CancellationError, isCancellationError } from "../../../../base/common/errors.js";
import { Emitter, type Event } from "../../../../base/common/event.js";
import { validateJsonValue } from "../../../../base/common/jsonValue.js";
import { Disposable, DisposableMap, MutableDisposable, toDisposable, type IDisposable } from "../../../../base/common/lifecycle.js";
import { localize } from "../../../../nls.js";
import type { URI } from "../../../../base/common/uri.js";
import { EditorOpenSource, TextEditorSelectionSource } from '../../../../platform/editor/common/editor.js';
import type { IKeybindingService } from "../../../../platform/keybinding/common/keybinding.js";
import type { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import type { ITextFileService } from "../../../services/textfile/common/textFileService.js";
import type { IFileService } from "../../../../platform/files/common/files.js";
import { type ITextMateService } from "../../../services/textMate/common/textMateService.js";
import type { IWorkingCopyService } from "../../../services/workingCopy/common/workingCopyService.js";
import type { IDiffService } from "../../../services/diff/common/diffService.js";
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import type { IAccessibilityService } from "../../../../platform/accessibility/common/accessibility.js";
import type { IDocumentCollaborationApi } from "../../../../platform/collaboration/common/documentCollaborationApi.js";
import type { IServerEventApi } from "../../../../platform/app-server/common/appServerApi.js";
import type { EditorInput, EditorOpenOptions } from "./editorInput.js";
import type { EditorCloseOptions } from '../../../services/editor/common/editorGroupsService.js';
import type { IEditorGroupView } from './editor.js';
import { ActiveEditorLastInGroupContext, ActiveEditorPinnedContext, ActiveEditorStickyContext, EditorGroupEditorsCountContext, MultipleEditorsSelectedInGroupContext, ResourceContext, ResourceSchemeContext } from '../../../common/contextkeys.js';
import type { TextResourceLanguageResolver } from "../../../../platform/language/common/textResourceLanguage.js";
import { EditorPaneVisibility, type IEditorPane } from "./editorPane.js";
import { EditorInputCapabilities, EditorResourceAccessor, SideBySideEditor, isEditorPaneWithSelection } from '../../../common/editor.js';
import { isEditorPaneWithViewState } from "./editorWithViewState.js";
import { EditorPanes, type EditorPaneInstance } from './editorPanes.js';
import { extractExternalEditorInputs } from "./editorDropData.js";
import type { IEditorPaneDescriptor, IEditorPaneRegistry } from "../../editor.js";
import type { IEditorTabDragAndDrop, EditorTabDropPosition } from "./editorTabDragAndDrop.js";
import './media/editorgroupview.css';
import { h } from '../../../../base/browser/dom.js';
import { EditorGroupModel, type IEditorGroupModelEntry } from '../../../common/editor/editorGroupModel.js';
import { EditorGroupWatermark } from './editorGroupWatermark.js';
import { EditorTitleControl } from './editorTitleControl.js';
import { ErrorPlaceholderEditor } from "./editorPlaceholder.js";
import type { EditorTabDescriptor, EditorTabsDelegate } from "./editorTabsControl.js";
import type { EditorHeaderActions } from "./editorHeaderControl.js";
import { type LanguageLocation, type LanguageWorkspaceEdit } from "../../../../editor/common/languages.js";
import type { ILanguageDiagnosticsService } from "../../../services/language/common/languageDiagnosticsService.js";
import type { IKeybindingsResourceService } from "../../../../platform/keybinding/common/keybindingsResource.js";
import type { IKeyboardLayoutService } from "../../../../platform/keyboardLayout/common/keyboardLayout.js";
import type { IContextKeyService, IScopedContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { getFlatContextMenuActions } from "../../../../platform/actions/browser/menuEntryActionViewItem.js";
import { MenuId } from "../../../../platform/actions/common/actions.js";
import type { EditorCloseReason, EditorGroupChangeEvent, EditorGroupId, EditorGroupState, EditorInstanceId, EditorInstanceState } from "../../../services/editor/common/editorState.js";
import type { SerializedEditorViewState } from "../../../services/editor/common/editorWorkingSet.js";
import { EditorGroupContextKeyController } from './editorContextKeys.js';
import type { FileElement } from './breadcrumbsModel.js';
import type { IBreadcrumbsService } from './breadcrumbs.js';
import type { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import type { LanguageDocumentSymbol } from '../../../../editor/common/languages.js';
import type { Range } from '../../../../editor/common/core/range.js';
import { isDiffEditorInput } from '../../../common/editor/diffEditorInput.js';
import { associatedEditorId, DiffEditorAssociationsConfiguration, EditorAssociationsConfiguration, type EditorAssociations } from './editorConfiguration.js';

/** Construction inputs for one independently navigable EditorGroup. */
export interface EditorGroupOptions {
	readonly id?: EditorGroupId;
	readonly registry: IEditorPaneRegistry;
	readonly configurationService?: IConfigurationService;
	readonly contextKeyService?: IContextKeyService;
	readonly keybindingService?: IKeybindingService;
	readonly keybindingsResourceService?: IKeybindingsResourceService;
	readonly keyboardLayoutService?: IKeyboardLayoutService;
	readonly fileService?: IFileService;
	readonly textFileService?: ITextFileService;
	readonly textMateService?: ITextMateService;
	readonly languageResolver?: TextResourceLanguageResolver;
	readonly diffService?: IDiffService;
	readonly accessibilityService?: IAccessibilityService;
	readonly languageDiagnosticsService?: ILanguageDiagnosticsService;
	readonly documentCollaborationApi?: IDocumentCollaborationApi;
	readonly serverEvents?: IServerEventApi;
	readonly workingCopyService?: IWorkingCopyService;
	readonly onSave?: (group: IEditorGroupView, input: EditorInput, pane: IEditorPane) => Promise<boolean>;
	readonly onWillCloseEditor?: (group: IEditorGroupView, input: EditorInput, pane: IEditorPane) => Promise<boolean>;
	readonly onOpenLocation?: (location: LanguageLocation) => void | Promise<void>;
	readonly onApplyWorkspaceEdit?: (edit: LanguageWorkspaceEdit) => void | Promise<void>;
	readonly titleActions?: EditorHeaderActions;
	readonly showBreadcrumbPicker?: (element: FileElement, openFile: (resource: URI) => Promise<void>) => void;
	readonly breadcrumbsService?: IBreadcrumbsService;
	readonly languageFeaturesService?: ILanguageFeaturesService;
	readonly showBreadcrumbSymbolPicker?: (symbols: readonly LanguageDocumentSymbol[], selected: LanguageDocumentSymbol, reveal: (range: Range) => void) => void;
	readonly onDidActivate?: () => void;
	readonly resolveOpenError?: (error: unknown, input: EditorInput, options: EditorOpenOptions, open: (options: EditorOpenOptions) => Promise<IEditorPane>) => unknown;
	readonly onWillOpenEditor?: (input: EditorInput) => Promise<void> | undefined;
	readonly onOpenError?: (error: unknown, input: EditorInput, options: EditorOpenOptions) => Promise<void>;
	readonly dragAndDrop?: IEditorTabDragAndDrop;
}

/** Releases tab-scoped listeners; EditorPanes owns the pane itself. */
class EditorGroupEntry extends Disposable implements EditorTabDescriptor {
	public readonly labelListener = this._register(new MutableDisposable<IDisposable>());

	constructor(public readonly state: IEditorGroupModelEntry, public readonly paneInstance: EditorPaneInstance) {
		super();
	}

	public get input(): EditorInput { return this.state.input; }
	public get instanceId(): EditorInstanceId { return this.state.instanceId; }
	public get preview(): boolean { return this.state.preview; }
	public get sticky(): boolean { return this.state.sticky; }
	public get panelId(): string { return this.paneInstance.panelId; }
	public get tabId(): string { return this.paneInstance.tabId; }
	public get isDirty(): boolean { return this.paneInstance.pane.workingCopy?.isDirty ?? false; }
	public get hasExternalChange(): boolean { return this.paneInstance.pane.workingCopy?.hasExternalChange ?? false; }
}

/**
 * Assembles one editor group and owns its DOM and pane lifetimes.
 * Tab state belongs to EditorGroupModel.
 */
export class EditorGroupView extends Disposable implements IEditorGroupView {
	readonly id: EditorGroupId;
	readonly domNode: HTMLElement;
	private readonly editorChangeEmitter = this._register(new Emitter<EditorGroupChangeEvent>());
	readonly onDidChangeEditors: Event<EditorGroupChangeEvent> = this.editorChangeEmitter.event;
	private readonly contentDomNode: HTMLDivElement;
	private readonly titleControl: EditorTitleControl;
	private readonly watermark: EditorGroupWatermark | undefined;
	private readonly panes: EditorPanes;
	private readonly registry: IEditorPaneRegistry;
	private readonly configurationService: IConfigurationService | undefined;
	private readonly contextKeyService: IContextKeyService | undefined;
	private readonly scopedContextKeyService: IScopedContextKeyService | undefined;
	private readonly keybindingService: IKeybindingService | undefined;
	private readonly keybindingsResourceService: IKeybindingsResourceService | undefined;
	private readonly keyboardLayoutService: IKeyboardLayoutService | undefined;
	private readonly fileService: IFileService | undefined;
	private readonly textFileService: ITextFileService | undefined;
	private readonly textMateService: ITextMateService | undefined;
	private readonly languageResolver: TextResourceLanguageResolver | undefined;
	private readonly diffService: IDiffService | undefined;
	private readonly instantiationService: IInstantiationService;
	private readonly accessibilityService: IAccessibilityService | undefined;
	private readonly languageDiagnosticsService: ILanguageDiagnosticsService | undefined;
	private readonly documentCollaborationApi: IDocumentCollaborationApi | undefined;
	private readonly serverEvents: IServerEventApi | undefined;
	private readonly workingCopyService: IWorkingCopyService | undefined;
	private readonly onSave: ((group: IEditorGroupView, input: EditorInput, pane: IEditorPane) => Promise<boolean>) | undefined;
	private readonly onWillCloseEditor: ((group: IEditorGroupView, input: EditorInput, pane: IEditorPane) => Promise<boolean>) | undefined;
	private readonly onOpenLocation: ((location: LanguageLocation) => void | Promise<void>) | undefined;
	private readonly onApplyWorkspaceEdit: ((edit: LanguageWorkspaceEdit) => void | Promise<void>) | undefined;
	private readonly titleActions: EditorHeaderActions | undefined;
	private readonly resolveOpenError: EditorGroupOptions["resolveOpenError"];
	private readonly onWillOpenEditor: EditorGroupOptions["onWillOpenEditor"];
	private readonly onOpenError: EditorGroupOptions["onOpenError"];
	private readonly model: EditorGroupModel;
	private readonly paneEntries = this._register(new DisposableMap<EditorInstanceId, EditorGroupEntry>());

	private get entries(): readonly EditorGroupEntry[] {
		return this.model.entries.map(entry => this.paneEntries.get(entry.instanceId)!);
	}

	private get activeEntry(): EditorGroupEntry | undefined {
		const active = this.model.activeEditor;
		return active ? this.entry(active) : undefined;
	}

	private ordinaryContent: Element | undefined;
	private groupDimension: IDimension = Dimension.Zero;
	private dimension: IDimension = Dimension.Zero;
	private contentRightInset = 0;
	private contentVisible = true;
	private openSequence = 0;

	constructor(container: HTMLElement, options: EditorGroupOptions, @IInstantiationService instantiationService: IInstantiationService) {
		super();
		this.model = new EditorGroupModel(options.id);
		this.id = this.model.id;
		this.registry = options.registry;
		this.onOpenError = options.onOpenError;
		this.resolveOpenError = options.resolveOpenError;
		this.onWillOpenEditor = options.onWillOpenEditor;
		this.configurationService = options.configurationService;
		this.contextKeyService = options.contextKeyService;
		this.keybindingService = options.keybindingService;
		this.keybindingsResourceService = options.keybindingsResourceService;
		this.keyboardLayoutService = options.keyboardLayoutService;
		this.fileService = options.fileService;
		this.textFileService = options.textFileService;
		this.textMateService = options.textMateService;
		this.languageResolver = options.languageResolver;
		this.diffService = options.diffService;
		this.instantiationService = instantiationService;
		this.accessibilityService = options.accessibilityService;
		this.languageDiagnosticsService = options.languageDiagnosticsService;
		this.documentCollaborationApi = options.documentCollaborationApi;
		this.serverEvents = options.serverEvents;
		this.workingCopyService = options.workingCopyService;
		this.onSave = options.onSave;
		this.onWillCloseEditor = options.onWillCloseEditor;
		this.onOpenLocation = options.onOpenLocation;
		this.onApplyWorkspaceEdit = options.onApplyWorkspaceEdit;
		this.titleActions = options.titleActions;
		const showBreadcrumbPicker = options.showBreadcrumbPicker;
		const titleDelegate: EditorTabsDelegate = {
			activate: input => this.activateEntry(this.requireEntry(input), true),
			preview: input => this.activateEntry(this.requireEntry(input), false),
			select: (input, modifiers) => this.selectTab(input, modifiers),
			close: input => {
				void this.closeEditor(input).catch(reportEditorCloseError);
			},
			showContextMenu: (input, event, tab) => this.showTabContextMenu(input, event, tab),
			pinEditor: input => this.pinEditor(input),
			unstickEditor: input => this.unstickEditor(input),
			startDrag: input => options.dragAndDrop?.start(this, input),
			isDragging: () => options.dragAndDrop?.isDragging() ?? false,
			drop: (target, position) => options.dragAndDrop?.drop(this, target, position),
			dropExternal: (event, target, position) => {
				void this.openExternalEditors(event.dataTransfer, target, position).catch((error: unknown) => {
					console.error("Failed to open dropped editor resources", error);
				});
			},
			endDrag: () => options.dragAndDrop?.end(),
		};
		const onSelectBreadcrumb = showBreadcrumbPicker
			? (element: FileElement) => showBreadcrumbPicker(element, async resource => {
				await this.openEditor({ resource });
				this.focus();
			})
			: undefined;
		const ownerDocument = container.ownerDocument;
		this.domNode = h(ownerDocument, 'section');
		this.domNode.className = 'ash-editor-group';
		this.domNode.setAttribute('aria-label', 'Editor group');
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this.scopedContextKeyService = options.contextKeyService
			? this._register(options.contextKeyService.createScoped(this.domNode))
			: undefined;
		this.titleControl = this._register(instantiationService.createInstance(EditorTitleControl,
			this.domNode,
			titleDelegate,
			this.model,
			options.titleActions ? {
				...options.titleActions,
				contextKeyService: this.scopedContextKeyService,
			} : undefined,
			options.configurationService,
			onSelectBreadcrumb,
			this.id,
			options.breadcrumbsService,
			options.languageFeaturesService,
			options.showBreadcrumbSymbolPicker,
		));
		this.contentDomNode = h(ownerDocument, 'div');
		this.contentDomNode.className = 'ash-editor-group-content';
		this.panes = this._register(new EditorPanes(this.contentDomNode));
		if (options.keybindingService) {
			this.watermark = this._register(instantiationService.createInstance(EditorGroupWatermark, this.contentDomNode));
		}
		this.domNode.append(this.titleControl.domNode, this.contentDomNode);
		if (this.scopedContextKeyService) {
			this._register(new EditorGroupContextKeyController(
				this.scopedContextKeyService,
				this,
				this.registry,
				this.languageResolver,
			));
		}
		if (options.onDidActivate) {
			this._register(addDisposableListener(this.domNode, "focusin", () => {
				options.onDidActivate?.();
			}));
		}
		this._register(this.titleControl.onDidChangeHeight(() => this.layout(this.groupDimension)));
		this._register(toDisposable(() => {
			this.cancelPendingOpen();
		}));
		this.renderChrome();
	}

	private showTabContextMenu(input: EditorInput, event: MouseEvent | KeyboardEvent, tab: HTMLElement): void {
		const actions = this.titleActions;
		if (!actions) {
			return;
		}
		const entry = this.requireEntry(input);
		const editorIndex = this.model.indexOf(entry.input);
		const context = { groupId: this.id, editorIndex };
		const anchor = event.type === "contextmenu"
			? { x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY, targetWindow: tab.ownerDocument.defaultView ?? undefined }
			: tab;
		const menuContext = this.scopedContextKeyService?.createScoped(tab);
		menuContext?.bufferChangeEvents(() => {
			// Menu visibility follows the clicked tab, even while another editor stays active.
			const resource = EditorResourceAccessor.getOriginalUri(input, { supportSideBySide: SideBySideEditor.PRIMARY });
			menuContext.setContext(ResourceContext.key, resource?.toString());
			menuContext.setContext(ResourceSchemeContext.key, resource?.scheme);
			menuContext.setContext(MultipleEditorsSelectedInGroupContext.key, this.selectedInputs.includes(input) && this.selectedInputs.length > 1);
			menuContext.setContext(ActiveEditorPinnedContext.key, !entry.preview);
			menuContext.setContext(ActiveEditorStickyContext.key, entry.sticky);
			menuContext.setContext(ActiveEditorLastInGroupContext.key, editorIndex === this.inputs.length - 1);
			menuContext.setContext(EditorGroupEditorsCountContext.key, this.inputs.length);
		});
		actions.contextMenuProvider.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => getFlatContextMenuActions(actions.menuService.getMenuActions(MenuId.EditorTitleContext, { arg: context }, menuContext), undefined, tab.ownerDocument.defaultView ?? undefined),
			getActionsContext: () => context,
			onHide: didCancel => {
				menuContext?.dispose();
				const survivingTab = tab.ownerDocument.getElementById(entry.tabId);
				if (didCancel && survivingTab) {
					survivingTab.focus();
				} else {
					this.focus();
				}
			},
		});
	}

	get inputs(): readonly EditorInput[] {
		return this.model.getEditors();
	}

	get selectedInputs(): readonly EditorInput[] {
		return this.model.selectedEditors;
	}

	get editors(): readonly EditorInstanceState[] {
		return this.entries.map(entry => this.editorState(entry));
	}

	get activeInput(): EditorInput | undefined {
		return this.activeEntry?.input;
	}

	get isLocked(): boolean {
		return this.model.isLocked;
	}

	setLocked(locked: boolean): void {
		this.model.setLocked(locked);
		this.domNode.classList.toggle("ash-editor-group-locked", locked);
		this.domNode.setAttribute("aria-label", locked ? "Editor group, locked" : "Editor group");
		this.titleControl.setLocked(locked);
	}

	get activePane(): IEditorPane | undefined {
		return this.panes.activePane;
	}

	getEditorState(): EditorGroupState {
		return Object.freeze({
			id: this.id,
			editors: Object.freeze(this.editors),
			activeEditorInstanceId: this.activeEntry?.instanceId,
		});
	}

	saveEditorViewState(input: EditorInput): SerializedEditorViewState | undefined {
		const pane = this.entry(input)?.paneInstance.pane;
		if (!pane || !isEditorPaneWithViewState(pane)) return undefined;
		return Object.freeze({
			typeId: pane.viewStateTypeId,
			value: validateJsonValue(pane.saveViewState(), { path: "editor view state" }),
		});
	}

	restoreEditorViewState(input: EditorInput, state: SerializedEditorViewState | undefined): boolean {
		const pane = this.entry(input)?.paneInstance.pane;
		if (!pane || !state || !isEditorPaneWithViewState(pane) || pane.viewStateTypeId !== state.typeId) return false;
		pane.restoreViewState(validateJsonValue(state.value, { path: "editor view state" }));
		return true;
	}

	isPreview(input: EditorInput): boolean {
		return this.model.findEditor(input) !== undefined && !this.model.isPinned(input);
	}

	isSticky(input: EditorInput): boolean {
		return this.model.isSticky(input);
	}

	pinEditor(input: EditorInput | undefined = this.activeInput): void {
		if (!input) return;
		const entry = this.requireEntry(input);
		if (!entry.preview) return;
		const restoreTabFocus = this.domNode.ownerDocument.activeElement?.id === entry.tabId;
		this.model.pin(input);
		this.publishEditorState(entry);
		if (restoreTabFocus) this.domNode.ownerDocument.getElementById(entry.tabId)?.focus();
	}

	stickEditor(input: EditorInput | undefined = this.activeInput): void {
		if (input) {
			this.setSticky(input, true);
		}
	}

	unstickEditor(input: EditorInput | undefined = this.activeInput): void {
		if (input) {
			this.setSticky(input, false);
		}
	}

	private setSticky(input: EditorInput, sticky: boolean): void {
		const entry = this.requireEntry(input);
		if (entry.sticky === sticky) {
			return;
		}
		const previousIndex = this.model.indexOf(input);
		const focusedTab = this.domNode.ownerDocument.activeElement?.closest(".ash-tab");
		// Moving rows replaces the tab's action button; restore focus to its stable tab identity.
		const focusedTabId = focusedTab && this.domNode.contains(focusedTab) ? focusedTab.querySelector<HTMLElement>(".ash-tab-label")?.id : undefined;
		if (sticky) {
			this.model.stick(input);
		} else {
			this.model.unstick(input);
		}
		if (this.model.indexOf(input) !== previousIndex) {
			this.editorChangeEmitter.fire(Object.freeze({ kind: "editorMoved", editor: this.editorState(entry), previousIndex }));
		}
		this.publishEditorState(entry);
		if (focusedTabId) {
			this.domNode.ownerDocument.getElementById(focusedTabId)?.focus();
		}
	}

	async openEditor(
		input: EditorInput,
		options: EditorOpenOptions = {},
		instanceId?: EditorInstanceId,
	): Promise<IEditorPane> {
		const sequence = ++this.openSequence;
		this.cancelPendingOpen();
		const existing = this.entry(input);
		try {
			const confirmation = this.onWillOpenEditor?.(input);
			if (confirmation) await confirmation;
		} catch (error) {
			if (sequence !== this.openSequence) throw new EditorOpenSupersededError(input);
			return this.showOpenError(input, options, error, existing);
		}
		if (sequence !== this.openSequence) throw new EditorOpenSupersededError(input);
		let descriptor: IEditorPaneDescriptor;
		try {
			const matchInput = this.languageResolver
				? { ...input, languageId: input.languageId ?? this.languageResolver.resolveLanguageId({ resource: input.resource, ...(input.contentType === undefined ? {} : { contentType: input.contentType }) }) }
				: input;
			const association = options.preferredEditorId === undefined && this.configurationService
				? associatedEditorId(
					EditorResourceAccessor.getOriginalUri(input, { supportSideBySide: SideBySideEditor.PRIMARY })!.path,
					this.configurationService.getValue<EditorAssociations>(isDiffEditorInput(input) ? DiffEditorAssociationsConfiguration : EditorAssociationsConfiguration),
				)
				: undefined;
			const selected = this.registry.getEditorPane(matchInput, association ? { ...options, preferredEditorId: association } : options);
			if (!selected) {
				throw new RangeError(`No editor can open ${input.resource}`);
			}
			descriptor = selected;
		} catch (error) {
			return this.showOpenError(input, options, error, existing);
		}
		if (existing?.paneInstance.pane.id === descriptor.id) {
			const wasPreview = existing.preview;
			const previousIndex = this.model.indexOf(input);
			this.model.updateEditor(input, options);
			if (this.model.indexOf(input) !== previousIndex) {
				this.editorChangeEmitter.fire(Object.freeze({ kind: "editorMoved", editor: this.editorState(existing), previousIndex }));
			}
			existing.labelListener.value = input.onDidChangeLabel?.(() => this.publishEditorState(existing));
			if (options.inactive && this.activeInput) {
				this.renderChrome();
			} else {
				this.activateEntry(existing, false);
			}
			applyEditorOpenOptions(existing.paneInstance.pane, options);
			if (wasPreview !== existing.preview) this.publishEditorState(existing);
			return existing.paneInstance.pane;
		}

		let createdPane: IEditorPane | undefined;
		let pane: IEditorPane;
		try {
			pane = descriptor.create({
				input,
				configurationService: this.configurationService,
				contextKeyService: this.contextKeyService,
				...(this.titleActions ? {
					actionServices: {
						menuService: this.titleActions.menuService,
						contextMenuProvider: this.titleActions.contextMenuProvider,
						contextKeyService: this.scopedContextKeyService,
					},
				} : {}),
				keybindingService: this.keybindingService,
				keybindingsResourceService: this.keybindingsResourceService,
				keyboardLayoutService: this.keyboardLayoutService,
				fileService: this.fileService,
				textFileService: this.textFileService,
				textMateService: this.textMateService,
				languageResolver: this.languageResolver,
				diffService: this.diffService,
				instantiationService: this.instantiationService,
				accessibilityService: this.accessibilityService,
				languageDiagnosticsService: this.languageDiagnosticsService,
				documentCollaborationApi: this.documentCollaborationApi,
				serverEvents: this.serverEvents,
				workingCopyService: this.workingCopyService,
				onOpenLocation: this.onOpenLocation,
				onApplyWorkspaceEdit: this.onApplyWorkspaceEdit,
				...(this.onSave ? {
					onSave: () => {
						if (!createdPane) return Promise.reject(new Error("Editor save is unavailable"));
						return this.onSave!(this, input, createdPane);
					},
				} : {}),
			});
		} catch (error) {
			return this.showOpenError(input, options, error, existing);
		}
		createdPane = pane;
		if (pane.id !== descriptor.id) {
			pane.dispose();
			const error = new TypeError(
				`Editor pane factory '${descriptor.id}' created '${pane.id}'`,
			);
			return this.showOpenError(input, options, error, existing);
		}
		let paneInstance: EditorPaneInstance;
		try {
			paneInstance = this.panes.create(pane);
		} catch (error) {
			return this.showOpenError(input, options, error, existing);
		}
		this.panes.setPending(paneInstance);
		try {
			await pane.setInput(input, paneInstance.signal);
		} catch (error) {
			this.panes.disposePane(paneInstance);
			if (sequence !== this.openSequence) {
				throw new EditorOpenSupersededError(input);
			}
			return this.showOpenError(input, options, error, existing);
		}

		if (
			sequence !== this.openSequence ||
			this.panes.pendingPane !== paneInstance
		) {
			this.panes.disposePane(paneInstance);
			throw new EditorOpenSupersededError(input);
		}
		this.panes.clearPending(paneInstance);
		return this.commitEditorPane(input, options, paneInstance, existing, instanceId);
	}

	private commitEditorPane(input: EditorInput, options: EditorOpenOptions, paneInstance: EditorPaneInstance, existing: EditorGroupEntry | undefined, instanceId?: EditorInstanceId): IEditorPane {
		const pane = paneInstance.pane;
		// Completed panes and error pages can commit; cancelled loads retain the previous tab.
		const pinned = options.pinned !== false || pane.workingCopy?.isDirty === true;
		const preview = this.model.previewEditor;
		const replacement = existing ?? (!pinned && preview ? this.entry(preview) : undefined);
		const closedState = replacement ? this.editorState(replacement) : undefined;
		const result = this.model.openEditor(input, { ...options, pinned, ...(instanceId === undefined ? {} : { instanceId }) });
		const state = result.editor;
		const replaced = result.replaced ? this.paneEntries.get(result.replaced.instanceId) : undefined;
		if (replaced) {
			this.panes.disposePane(replaced.paneInstance);
			this.paneEntries.deleteAndDispose(replaced.instanceId);
		}
		const entry = new EditorGroupEntry(state, paneInstance);
		this.paneEntries.set(entry.instanceId, entry);
		if (closedState) {
			this.editorChangeEmitter.fire(Object.freeze({ kind: "editorClosed", editor: closedState, reason: existing ? "replace" : "previewReplace" }));
		}
		entry.labelListener.value = input.onDidChangeLabel?.(() => this.publishEditorState(entry));
		paneInstance.observeWorkingCopy(() => {
			if (entry.preview && entry.paneInstance.pane.workingCopy?.isDirty) this.model.pin(entry.input);
			this.publishEditorState(entry);
		});
		this.ordinaryContent = undefined;
		this.editorChangeEmitter.fire(Object.freeze({ kind: "editorOpened", editor: this.editorState(entry) }));
		if (options.inactive && this.activeInput) {
			paneInstance.setVisible(EditorPaneVisibility.Hidden);
			this.renderContent();
			this.renderChrome();
		} else {
			this.activateEntry(entry, false);
		}
		applyEditorOpenOptions(pane, options);
		return pane;
	}

	private async showOpenError(input: EditorInput, options: EditorOpenOptions, error: unknown, existing: EditorGroupEntry | undefined): Promise<IEditorPane> {
		if (options.ignoreError || isCancellationError(error)) throw error;
		const displayError = this.resolveOpenError ? this.resolveOpenError(error, input, options, openOptions => this.openEditor(input, openOptions)) : error;
		const pane = new ErrorPlaceholderEditor(
			displayError,
			() => this.openEditor(input, { ...options, source: EditorOpenSource.USER }),
			() => this.closeEditor(input),
		);
		const paneInstance = this.panes.create(pane);
		void pane.setInput(input, paneInstance.signal);
		// A failed resource owns a tab even when another file is already open.
		this.commitEditorPane(input, options, paneInstance, existing);
		await this.onOpenError?.(displayError, input, options);
		const current = this.entry(input)?.paneInstance.pane;
		if (!current) throw new CancellationError("The failed editor was closed");
		return current;
	}

	activateEditor(input: EditorInput): IEditorPane {
		const entry = this.requireEntry(input);
		this.activateEntry(entry, false);
		return entry.paneInstance.pane;
	}

	async confirmCloseEditor(input: EditorInput): Promise<boolean> {
		const entry = this.entry(input);
		if (!entry) return true;
		if (!entry.paneInstance.pane.workingCopy?.isDirty) return true;
		return await this.onWillCloseEditor?.(this, entry.input, entry.paneInstance.pane) ?? false;
	}

	async closeEditor(input: EditorInput, options: EditorCloseOptions = {}): Promise<boolean> {
		if ((options.reason === undefined || options.reason === 'close') && ((input.capabilities ?? EditorInputCapabilities.None) & EditorInputCapabilities.CannotClose)) {
			return false;
		}
		const entry = this.entry(input);
		if (!entry) return false;
		if (!options.skipConfirmation && entry.paneInstance.pane.workingCopy?.isDirty && !await this.confirmCloseEditor(input)) return false;
		if (this.paneEntries.get(entry.instanceId) !== entry) return true;
		this.doCloseEditor(entry, options.reason ?? "close");
		return true;
	}

	private doCloseEditor(entry: EditorGroupEntry, reason: EditorCloseReason): void {
		const index = this.model.indexOf(entry.input);
		if (index < 0) return;
		const closedState = this.editorState(entry, index);
		const wasActive = this.activeEntry === entry;
		this.model.closeEditor(entry.input);
		this.paneEntries.deleteAndDispose(entry.instanceId);
		this.panes.disposePane(entry.paneInstance);
		this.editorChangeEmitter.fire(Object.freeze({ kind: "editorClosed", editor: closedState, reason }));
		if (wasActive) {
			const next = this.entries[index] ?? this.entries[index - 1];
			if (next) this.activateEntry(next, true);
			else {
				this.editorChangeEmitter.fire(Object.freeze({ kind: "activeEditorChanged", editor: undefined }));
			}
		}
		this.renderContent();
		this.renderChrome();
	}

	async replaceEditor(input: EditorInput, replacement: EditorInput): Promise<void> {
		const index = this.model.indexOf(input);
		if (index < 0) throw new RangeError(`Editor is not open in this group: ${input.resource}`);
		const wasSticky = this.isSticky(input);
		const previouslyActive = this.activeInput;
		const wasActive = this.activeEntry === this.entry(input);
		await this.openEditor(replacement, { index });
		if (wasSticky) this.stickEditor(replacement);
		await this.closeEditor(input, { skipConfirmation: true, reason: "replace" });
		if (previouslyActive && !wasActive) this.activateEditor(previouslyActive);
	}

	getEditorInsertionIndex(target: EditorInput | undefined, position: EditorTabDropPosition): number {
		if (!target) return this.entries.length;
		const index = this.model.indexOf(target);
		if (index < 0) return this.entries.length;
		return position === "before" ? index : index + 1;
	}

	moveEditor(input: EditorInput, targetIndex: number): void {
		const sourceIndex = this.model.indexOf(input);
		if (sourceIndex < 0) return;
		const entry = this.entries[sourceIndex]!;
		this.model.moveEditor(input, targetIndex > sourceIndex ? targetIndex - 1 : targetIndex);
		this.renderContent();
		this.renderChrome();
		this.editorChangeEmitter.fire(Object.freeze({ kind: "editorMoved", editor: this.editorState(entry), previousIndex: sourceIndex }));
	}

	private async openExternalEditors(dataTransfer: DataTransfer | null, target: EditorInput | undefined, position: EditorTabDropPosition): Promise<void> {
		if (!dataTransfer) return;
		const inputs = await extractExternalEditorInputs(dataTransfer);
		let index = this.getEditorInsertionIndex(target, position);
		for (const input of inputs) {
			await this.openEditor(input, { index });
			index += 1;
		}
	}

	async moveEditorTo(input: EditorInput, target: IEditorGroupView, targetIndex: number): Promise<void> {
		if (target === this) {
			this.moveEditor(input, targetIndex);
			return;
		}
		const entry = this.requireEntry(input);
		await target.openEditor(input, { index: targetIndex }, entry.instanceId);
		if (entry.sticky) target.stickEditor(input);
		await this.closeEditor(input, { skipConfirmation: true, reason: "move" });
		target.activateEditor(input);
	}

	async setContent(content: Element): Promise<boolean> {
		const inputs = [...this.inputs];
		for (const input of inputs) {
			if (!await this.confirmCloseEditor(input)) return false;
		}
		this.openSequence += 1;
		this.cancelPendingOpen();
		for (const entry of [...this.entries]) this.doCloseEditor(entry, "reset");
		this.ordinaryContent = content;
		this.renderContent();
		this.renderChrome();
		return true;
	}

	layout(dimension: IDimension): void {
		this.groupDimension = dimension;
		this.dimension = new Dimension(
			Math.max(0, dimension.width - this.contentRightInset),
			Math.max(0, dimension.height - this.titleControl.height),
		);
		this.panes.layout(this.dimension);
	}

	public get titleHeight(): { readonly offset: number; readonly total: number } {
		return { offset: this.titleControl.height, total: this.titleControl.height };
	}

	public setContentRightInset(inset: number): void {
		this.contentRightInset = inset;
		this.contentDomNode.style.width = `calc(100% - ${inset}px)`;
		this.layout(this.groupDimension);
	}

	public setEditorContentVisible(visible: boolean): void {
		if (this.contentVisible === visible) {
			return;
		}
		this.contentVisible = visible;
		this.contentDomNode.hidden = !visible;
		this.activeEntry?.paneInstance.setVisible(visible ? EditorPaneVisibility.Visible : EditorPaneVisibility.Hidden);
	}

	focus(): void {
		this.panes.focus();
	}

	private activateEntry(entry: EditorGroupEntry, focus: boolean): void {
		const changed = this.model.setActive(entry.input);
		this.ordinaryContent = undefined;
		this.renderContent();
		this.panes.activate(entry.paneInstance, this.dimension);
		if (!this.contentVisible) {
			entry.paneInstance.setVisible(EditorPaneVisibility.Hidden);
		}
		if (changed) {
			this.editorChangeEmitter.fire(Object.freeze({ kind: "activeEditorChanged", editor: this.editorState(entry) }));
		}
		this.renderChrome();
		if (focus) this.panes.focus();
	}

	private renderContent(): void {
		const children: Element[] = [];
		if (this.ordinaryContent) {
			children.push(this.ordinaryContent);
		} else {
			if (this.watermark) {
				this.watermark.domNode.hidden = this.entries.length > 0;
				children.push(this.watermark.domNode);
			}
			children.push(...this.entries.map(entry => entry.paneInstance.domNode));
		}
		if (this.panes.pendingPane) children.push(this.panes.pendingPane.domNode);
		this.contentDomNode.replaceChildren(...children);
	}

	private renderChrome(): void {
		this.titleControl.setEditors(this.entries, this.activeInput, this.activePane, this.model.selectedEditorIds);
	}

	private selectTab(input: EditorInput, modifiers: { toggle: boolean; range: boolean }): boolean {
		if (!modifiers.toggle && !modifiers.range) return false;
		const entry = this.requireEntry(input);
		const restoreFocus = this.domNode.ownerDocument.activeElement?.id === entry.tabId;
		this.model.setSelection(input, modifiers);
		this.renderChrome();
		if (restoreFocus) this.domNode.ownerDocument.getElementById(entry.tabId)?.focus();
		return true;
	}

	private publishEditorState(entry: EditorGroupEntry): void {
		if (this.paneEntries.get(entry.instanceId) !== entry) return;
		this.renderChrome();
		this.editorChangeEmitter.fire(Object.freeze({ kind: "editorStateChanged", editor: this.editorState(entry) }));
	}

	private editorState(entry: EditorGroupEntry, index = this.model.indexOf(entry.input)): EditorInstanceState {
		const workingCopy = entry.paneInstance.pane.workingCopy;
		return Object.freeze({
			groupId: this.id,
			instanceId: entry.instanceId,
			paneId: entry.paneInstance.pane.id,
			input: entry.input,
			index,
			isActive: this.activeEntry === entry,
			isPreview: entry.preview,
			isSticky: entry.sticky,
			isDirty: workingCopy?.isDirty ?? false,
			canRevert: workingCopy !== undefined,
			hasExternalChange: workingCopy?.hasExternalChange ?? false,
		});
	}

	private entry(input: EditorInput): EditorGroupEntry | undefined {
		const state = this.model.findEditor(input);
		return state ? this.paneEntries.get(state.instanceId) : undefined;
	}

	private requireEntry(input: EditorInput): EditorGroupEntry {
		const entry = this.entry(input);
		if (!entry) {
			throw new RangeError(
				`Editor is not open in this group: ${input.resource}`,
			);
		}
		return entry;
	}

	private cancelPendingOpen(): void {
		this.panes.cancelPending();
	}
}

function applyEditorOpenOptions(pane: IEditorPane, options: EditorOpenOptions): void {
	if (!options.selection) return;
	if (isEditorPaneWithSelection(pane)) {
		pane.restoreSelection(options.selection, options.selectionSource ?? TextEditorSelectionSource.NAVIGATION);
		return;
	}
	pane.revealRange?.(options.selection);
}

export class EditorOpenSupersededError extends CancellationError {
	constructor(readonly input: EditorInput) {
		super(`Editor opening was superseded: ${input.resource}`);
		this.name = "EditorOpenSupersededError";
	}
}

function reportEditorCloseError(error: unknown): void {
	console.error("Failed to close editor", error);
}
