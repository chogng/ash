import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { IAction } from '../../../../base/common/actions.js';
import { localize } from '../../../../nls.js';
import Severity from '../../../../base/common/severity.js';
import { createEditorOpenError, isEditorOpenError, type IResourceEditorInput, type IEditorPane } from '../../../common/editor.js';
import "./media/editorpart.css";
import { isNonEmptyArray } from "../../../../base/common/arrays.js";
import { basename } from "../../../../base/common/resources.js";
import type { IContextMenuProvider } from "../../../../base/browser/contextmenu.js";
import type { URI } from "../../../../base/common/uri.js";
import { Emitter, type Event } from "../../../../base/common/event.js";
import { CancellationError } from "../../../../base/common/errors.js";
import { validateJsonValue } from "../../../../base/common/jsonValue.js";
import { computeScreenAwareSize, Dimension, type IDimension } from "../../../../base/browser/dom.js";
import { type IPositionedRectangle } from "../../../../base/browser/geometry.js";
import { Direction, SerializableGrid, Sizing, type Direction as GridDirection, type GridDescriptor, type ISerializableView as ISerializableGridView } from "../../../../base/browser/ui/grid/grid.js";
import { DisposableMap, Disposable, MutableDisposable, type IDisposable } from "../../../../base/common/lifecycle.js";
import { rot } from "../../../../base/common/numbers.js";
import { Schemas } from "../../../../base/common/network.js";
import type { IMenuService } from "../../../../platform/actions/common/actions.js";
import { EditorOpenSource, TextEditorSelectionSource } from '../../../../platform/editor/common/editor.js';
import type { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";
import type { IKeybindingService } from "../../../../platform/keybinding/common/keybinding.js";
import type { IKeyboardLayoutService } from "../../../../platform/keyboardLayout/common/keyboardLayout.js";
import type { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { ConfirmResult, DialogSeverity, type IDialogService, type IFileDialogService } from "../../../../platform/dialogs/common/dialogs.js";
import { TextFileBinaryError, TextFileTooLargeError, type ITextFileService } from "../../../services/textfile/common/textFileService.js";
import { FileNotFoundError, type IFileService } from "../../../../platform/files/common/files.js";
import { type ITextMateService } from "../../../services/textMate/common/textMateService.js";
import type { IDiffService } from "../../../services/diff/common/diffService.js";
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import type { IAccessibilityService } from "../../../../platform/accessibility/common/accessibility.js";
import type { IDocumentCollaborationApi } from "../../../../platform/collaboration/common/documentCollaborationApi.js";
import type { IServerEventApi } from "../../../../platform/app-server/common/appServerApi.js";
import { Part } from "../../part.js";
import { EditorGroupView, type EditorGroupOptions } from "./editorGroupView.js";
import type { IEditorGroupView } from "./editor.js";
import { AutoLockGroupsConfiguration, DefaultBinaryEditorConfiguration, EditorLargeFileConfirmationConfiguration, EditorOpenErrorDialogConfiguration, type AutoLockGroups } from "./editorConfiguration.js";
import type { FileElement } from "./breadcrumbsModel.js";
import type { IBreadcrumbsService } from "./breadcrumbs.js";
import type { ILanguageFeaturesService } from "../../../../editor/common/services/languageFeatures.js";
import type { LanguageDocumentSymbol } from "../../../../editor/common/languages.js";
import type { Range } from "../../../../editor/common/core/range.js";
import { EditorDropTarget } from "./editorDropTarget.js";
import { EditorsObserver } from "./editorsObserver.js";
import { EditorTabDragAndDropController, type EditorTabDropEvent } from "./editorTabDragAndDrop.js";
import { GroupDirection, GroupLocation, type IEditorGroup, type IEditorGroupsContainer, type IFindGroupScope } from '../../../services/editor/common/editorGroupsService.js';
import type { EditorOpenOptions, EditorOpenTarget } from "../../../services/editor/common/editorService.js";
import type { TextResourceLanguageResolver } from "../../../../platform/language/common/textResourceLanguage.js";
import type { IWorkingCopyService } from "../../../services/workingCopy/common/workingCopyService.js";

import { EditorPanes, type IEditorPaneDescriptor, type IEditorPaneRegistry } from "../../editor.js";
import type { IBulkEditService } from "../../../../editor/browser/services/bulkEditService.js";
import type { ILanguageDiagnosticsService } from "../../../services/language/common/languageDiagnosticsService.js";
import { EditorInputSerializers, type EditorInputSerializerRegistry, isSerializedEditorInput } from "../../../services/editor/common/editorInputSerializer.js";
import type { ApplyEditorWorkingSetOptions, EditorWorkingSet, EditorWorkingSetLayout, EditorWorkingSetTarget } from "../../../services/editor/common/editorWorkingSet.js";
import { parseEditorWorkingSetLayout } from '../../../services/editor/common/editorWorkingSet.js';
import { ModalEditorPart, type ModalEditorPartOptions } from "./modalEditorPart.js";
import type { EditorGroupChangeEvent, EditorGroupId, EditorIdentifier, EditorPartChangeEvent, EditorPartState, IEditorStateSource } from "../../../services/editor/common/editorState.js";
import { editorInputKey } from "./editorTabsControl.js";
import { WorkbenchConfiguration } from "../../../common/configuration.js";
import { EditorOpenSideBySideDirectionConfiguration } from '../../../services/editor/common/editorConfiguration.js';

export { EditorOpenSupersededError } from "./editorGroupView.js";

/** Keep the CSS variable reference so theme changes recolor existing Grid boundaries without restyling the Grid. */
const EDITOR_GROUP_GRID_STYLES = { separatorBorder: "var(--ash-editorGroup-border)" } as const;

// Matches the standard stroke token used by modernUI/browser/media/editorBorder.css.
const EDITOR_FRAME_BORDER_WIDTH = 1;

/** Editor-region operations available to Workbench contributions. */
export interface IEditorPart extends IEditorStateSource, IDisposable {
	readonly domNode: HTMLElement;
	readonly onDidChangeEditors: Event<EditorPartChangeEvent>;
	readonly groups: readonly IEditorGroupView[];
	readonly activeGroup: IEditorGroupView;
	addGroup(reference: EditorGroupId, direction: GridDirection): IEditorGroupView;
	activateGroup(id: EditorGroupId): void;
	findGroup(scope: IFindGroupScope, source?: IEditorGroup): IEditorGroup | undefined;
	isGroupVisible(id: EditorGroupId): boolean;
	setGroupVisible(id: EditorGroupId, visible: boolean): void;
	toggleActiveGroupLock(): boolean;
	readonly activeInput: IResourceEditorInput | undefined;
	readonly activePane: IEditorPane | undefined;
	readonly isModalEditorVisible: boolean;
	readonly editorsMru: readonly EditorIdentifier[];
	readonly recentlyClosedEditors: readonly RecentlyClosedEditor[];

	openEditor(input: IResourceEditorInput, options?: EditorOpenOptions, target?: EditorOpenTarget): Promise<IEditorPane>;
	activateEditor(input: IResourceEditorInput): IEditorPane;
	activateEditorIdentifier(identifier: EditorIdentifier): IEditorPane | undefined;
	activateEditorMru(offset: number): IEditorPane | undefined;
	closeEditor(input: IResourceEditorInput): Promise<boolean>;
	closeEditorIdentifier(identifier: EditorIdentifier): Promise<boolean>;
	confirmCloseAllEditors(): Promise<boolean>;
	closeAllEditors(options?: EditorCloseAllOptions): Promise<boolean>;
	moveActiveEditorTo(target: IEditorPart): Promise<boolean>;
	saveActiveEditor(): Promise<void>;
	setContent(content: Element): Promise<void>;
	splitActiveGroup(direction: GridDirection): Promise<void>;
	/** Copies the requested tabs beside their source group without activating a source tab. */
	splitEditors(groupId: EditorGroupId, inputs: readonly IResourceEditorInput[], direction: GridDirection): Promise<void>;
	splitActiveGroupHorizontal(): Promise<void>;
	splitActiveGroupVertical(): Promise<void>;
	getEditorPaneChoices(input?: IResourceEditorInput): readonly IEditorPaneDescriptor[];
	reopenActiveEditorWith(preferredEditorId: string): Promise<IEditorPane | undefined>;
	reopenClosedEditor(): Promise<boolean>;
	saveWorkingSet(id: string, excludedGroups?: readonly EditorGroupId[]): EditorWorkingSet;
	applyWorkingSet(workingSet: EditorWorkingSetTarget, options?: ApplyEditorWorkingSetOptions): Promise<void>;
	layout(dimension: IDimension): void;
	focus(): void;
}

export interface RecentlyClosedEditor {
	readonly input: IResourceEditorInput;
	readonly preferredEditorId: string;
}

export interface EditorCloseAllOptions {
	readonly reason?: "close" | "reset";
	readonly skipConfirmation?: boolean;
}

export const IEditorPart =
	createServiceIdentifier<IEditorPart>("editorPart");

/** Named collaborators used to construct the editor region. */
export interface IEditorPartOptions {
	/** Ash extension: reuse the editor host for single-content groups without changing ordinary multi-tab editors. */
	readonly editorLimit?: 1;
	readonly configurationService?: IConfigurationService;
	readonly contextKeyService?: IContextKeyService;
	readonly keybindingService?: IKeybindingService;
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
	readonly dialogService?: IDialogService;
	readonly fileDialogService?: IFileDialogService;
	readonly bulkEditService?: IBulkEditService;
	readonly registry?: IEditorPaneRegistry;
	readonly titleActions?: {
		readonly menuService: IMenuService;
		readonly contextMenuProvider: IContextMenuProvider;
	};
	readonly showBreadcrumbPicker?: (element: FileElement, openFile: (resource: URI) => Promise<void>) => void;
	readonly breadcrumbsService?: IBreadcrumbsService;
	readonly languageFeaturesService?: ILanguageFeaturesService;
	readonly showBreadcrumbSymbolPicker?: (symbols: readonly LanguageDocumentSymbol[], selected: LanguageDocumentSymbol, reveal: (range: Range) => void) => void;
	readonly saveAsResource?: (defaultName: string) => Promise<URI | undefined>;
	readonly replaceEditorResource?: (source: IEditorGroupView, input: IResourceEditorInput, replacement: IResourceEditorInput) => Promise<void>;
	readonly inputSerializers?: EditorInputSerializerRegistry;
}

/** Owns EditorGroupView layout and delegates editor behavior to the active group. */
export class EditorPart extends Part implements IEditorPart, IEditorGroupsContainer {
	private readonly editorChangeEmitter = this._register(new Emitter<EditorPartChangeEvent>());
	readonly onDidChangeEditors: Event<EditorPartChangeEvent> = this.editorChangeEmitter.event;
	public readonly onDidChangeActiveGroup: Event<IEditorGroup> = (listener, thisArgs, disposables) =>
		this.onDidChangeEditors(event => {
			if (event.kind === 'activeGroupChanged') {
				listener.call(thisArgs, this.activeGroup);
			}
		}, undefined, disposables);
	readonly onDidChangeModalVisibility: Event<boolean>;
	private readonly gridSlot = this._register(new MutableDisposable<SerializableGrid<EditorGroupGridView>>());
	private readonly gridChanges = this._register(new MutableDisposable<IDisposable>());
	private readonly layoutEmitter = this._register(new Emitter<Dimension>());
	public readonly onDidLayout = this.layoutEmitter.event;
	private readonly groupHosts = this._register(new DisposableMap<EditorGroupId, EditorGroupHost>());
	private readonly modalEditor: ModalEditorPart;
	private readonly groupOptions: Omit<EditorGroupOptions, "onDidActivate" | "dragAndDrop">;
	private readonly _groups: EditorGroupHost[] = [];
	private _activeGroup: EditorGroupView;
	private readonly tabDragAndDrop: EditorTabDragAndDropController;
	private dimension = Dimension.Zero;
	private contentRightInset = 0;
	private editorContentVisible = true;
	private readonly saveAsResource: ((defaultName: string) => Promise<URI | undefined>) | undefined;
	private readonly replaceEditorResource: ((source: IEditorGroupView, input: IResourceEditorInput, replacement: IResourceEditorInput) => Promise<void>) | undefined;
	private readonly inputSerializers: EditorInputSerializerRegistry;
	private readonly dialogService: IDialogService | undefined;
	private readonly fileDialogService: IFileDialogService | undefined;
	private readonly editorsObserver: EditorsObserver;
	private readonly recentlyClosed: RecentlyClosedEditor[] = [];

	override get minimumWidth(): number { return Math.max(120, this.editorGrid.minimumWidth); }
	override get minimumHeight(): number { return 119; }

	constructor(
		container: HTMLElement,
		options: IEditorPartOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super(container, "editor", themeService, storageService, {
			borderWidth: () => this.getFloatingBorderWidth() * 2,
		});
		const ownerDocument = container.ownerDocument;
		this.titleDomNode.remove();
		this.domNode.setAttribute("aria-label", "Editor");
		this.groupOptions = {
			editorLimit: options.editorLimit,
			registry: options.registry ?? EditorPanes,
			resolveOpenError: (error, input, openOptions, open) => this.resolveEditorOpenError(error, input, openOptions, open),
			onWillOpenEditor: input => this.confirmLargeFileOpen(input),
			onOpenError: (error, input, openOptions) => this.showEditorOpenErrorDialog(error, input, openOptions),
			configurationService: options.configurationService,
			contextKeyService: options.contextKeyService,
			keybindingService: options.keybindingService,
			keyboardLayoutService: options.keyboardLayoutService,
			fileService: options.fileService,
			textFileService: options.textFileService,
			textMateService: options.textMateService,
			languageResolver: options.languageResolver,
			diffService: options.diffService,
			accessibilityService: options.accessibilityService,
			languageDiagnosticsService: options.languageDiagnosticsService,
			documentCollaborationApi: options.documentCollaborationApi,
			serverEvents: options.serverEvents,
			workingCopyService: options.workingCopyService,
			onWillCloseEditor: (group, input, pane, closingGroups) => this.confirmEditorClose(group, input, pane, closingGroups),
			onOpenLocation: location => this.openEditor({ resource: location.resource }, { selection: location.selectionRange ?? location.range, selectionSource: TextEditorSelectionSource.JUMP }).then(() => undefined),
			onApplyWorkspaceEdit: options.bulkEditService ? (edit, bulkOptions) => options.bulkEditService!.apply(edit, bulkOptions).then(() => undefined) : undefined,
			titleActions: options.titleActions,
			showBreadcrumbPicker: options.showBreadcrumbPicker,
			breadcrumbsService: options.breadcrumbsService,
			languageFeaturesService: options.languageFeaturesService,
			showBreadcrumbSymbolPicker: options.showBreadcrumbSymbolPicker,
			...(options.saveAsResource ? {
				onSave: (group: IEditorGroupView, input: IResourceEditorInput, pane: IEditorPane) => this.saveEditor(group, input, pane),
			} : {}),
		};
		this.saveAsResource = options.saveAsResource;
		this.replaceEditorResource = options.replaceEditorResource;
		if (this.saveAsResource && !this.replaceEditorResource) throw new Error('Editor Save As requires editor-wide replacement');
		this.inputSerializers = options.inputSerializers ?? EditorInputSerializers;
		this.dialogService = options.dialogService;
		this.fileDialogService = options.fileDialogService;
		this.tabDragAndDrop = new EditorTabDragAndDropController((event) => {
			this.dropEditor(event);
		});
		const initial = this.createGroup();
		this._groups.push(initial);
		this._activeGroup = initial.group;
		this.gridSlot.value = new SerializableGrid(this.contentDomNode, {
			type: "leaf",
			view: initial.view,
			size: 1,
		}, { styles: EDITOR_GROUP_GRID_STYLES });
		this.observeGrid();
		this._register(new EditorDropTarget(
			this.contentDomNode,
			target => this._groups.find(host => host.group.domNode.contains(target))?.group,
			this.tabDragAndDrop,
		));
		this.modalEditor = this._register(instantiationService.createInstance(ModalEditorPart, {
			container,
			registry: this.groupOptions.registry,
			resolveOpenError: this.groupOptions.resolveOpenError,
			onWillOpenEditor: this.groupOptions.onWillOpenEditor,
			onOpenError: this.groupOptions.onOpenError,
			paneCreationOptions: {
				instantiationService,
				configurationService: options.configurationService,
				contextKeyService: options.contextKeyService,
				keybindingService: options.keybindingService,
				keyboardLayoutService: options.keyboardLayoutService,
				fileService: options.fileService,
				textFileService: options.textFileService,
				textMateService: options.textMateService,
				languageResolver: options.languageResolver,
				diffService: options.diffService,
				accessibilityService: options.accessibilityService,
				languageDiagnosticsService: options.languageDiagnosticsService,
				documentCollaborationApi: options.documentCollaborationApi,
				serverEvents: options.serverEvents,
				workingCopyService: options.workingCopyService,
				onOpenLocation: location => this.openEditor({ resource: location.resource }, { selection: location.selectionRange ?? location.range, selectionSource: TextEditorSelectionSource.JUMP }).then(() => undefined),
				onApplyWorkspaceEdit: options.bulkEditService ? (edit, bulkOptions) => options.bulkEditService!.apply(edit, bulkOptions).then(() => undefined) : undefined,
				...(options.titleActions ? {
					actionServices: {
						menuService: options.titleActions.menuService,
						contextMenuProvider: options.titleActions.contextMenuProvider,
						contextKeyService: options.contextKeyService,
					},
				} : {}),
			},
		} satisfies ModalEditorPartOptions));
		this.onDidChangeModalVisibility = this.modalEditor.onDidChangeVisibility;
		this.editorsObserver = this._register(new EditorsObserver(this));
		this._register(this.modalEditor.onDidRequestClose(input => {
			void this.closeEditor(input).catch(reportEditorCloseError);
		}));
	}

	get groups(): readonly IEditorGroupView[] {
		return this._groups.map(({ group }) => group);
	}

	get activeGroup(): IEditorGroupView {
		return this._activeGroup;
	}

	public addGroup(reference: EditorGroupId, direction: GridDirection): IEditorGroupView {
		return this.insertGroup(this.groupHosts.get(reference)!.group, direction).group;
	}

	public activateGroup(id: EditorGroupId): void {
		this.setActiveGroup(this.groupHosts.get(id)!.group);
	}

	public getSize(group: IEditorGroupView | EditorGroupId): IDimension {
		return this.editorGrid.getViewSize(this.groupHosts.get(typeof group === 'string' ? group : group.id)!.view);
	}

	public setSize(group: IEditorGroupView | EditorGroupId, size: IDimension): void {
		this.editorGrid.resizeView(this.groupHosts.get(typeof group === 'string' ? group : group.id)!.view, size);
	}

	/** Ash extension: expose the same Grid state used by working sets without serializing editor inputs. */
	public serializeLayout(): EditorWorkingSetLayout {
		return this.editorGrid.serialize() as EditorWorkingSetLayout;
	}

	/** Rebind saved group identities while retaining the live panes and their focus. Missing groups are pruned. */
	public restoreLayout(layout: EditorWorkingSetLayout, groupMapping: ReadonlyMap<EditorGroupId, EditorGroupId>): void {
		const retained = filterWorkingSetLayout(layout, new Set(groupMapping.keys()));
		if (!retained) return;
		const mapped = new Set(groupMapping.values());
		if (mapped.size !== groupMapping.size || [...mapped].some(id => !this.groupHosts.has(id))) throw new TypeError('Invalid Editor Grid group mapping');
		const missing = this._groups.filter(host => !mapped.has(host.group.id));
		const extra: EditorWorkingSetLayout[] = missing.map(host => ({ type: 'leaf', data: { groupId: host.group.id }, size: this.editorGrid.getViewSize(host.view).width, visible: true, priority: 'normal' }));
		const rebound = remapWorkingSetLayout(retained, groupMapping);
		const combined: EditorWorkingSetLayout = extra.length ? {
			type: 'branch', orientation: 'horizontal', size: this.dimension.width, priority: 'normal',
			children: [...(rebound.type === 'branch' && rebound.orientation === 'horizontal' ? rebound.children : [rebound]), ...extra],
		} : rebound;
		this.preserveFocus(() => {
			this.gridSlot.clear();
			this.gridSlot.value = SerializableGrid.deserialize<EditorGroupGridView>(this.contentDomNode, combined, {
				fromJSON: data => {
					const savedId = editorGroupIdFromGridData(data);
					return this.groupHosts.get(savedId)!.view;
				},
			}, { styles: EDITOR_GROUP_GRID_STYLES });
			this.observeGrid();
			this.layoutEditorContent();
			this.notifyConstraintsChanged();
		});
	}

	public moveGroup(group: IEditorGroupView | EditorGroupId, location: IEditorGroupView | EditorGroupId, direction: GroupDirection): IEditorGroupView {
		const source = this.groupHosts.get(typeof group === 'string' ? group : group.id)!;
		const target = this.groupHosts.get(typeof location === 'string' ? location : location.id)!;
		if (source === target) return source.group;
		const directions = { [GroupDirection.LEFT]: Direction.Left, [GroupDirection.RIGHT]: Direction.Right, [GroupDirection.UP]: Direction.Up, [GroupDirection.DOWN]: Direction.Down };
		this.preserveFocus(() => this.editorGrid.moveView(source.view, Sizing.Split, target.view, directions[direction]));
		this._groups.splice(this._groups.indexOf(source), 1);
		this._groups.splice(this._groups.indexOf(target) + (direction === GroupDirection.LEFT || direction === GroupDirection.UP ? 0 : 1), 0, source);
		this.layoutEditorContent();
		return source.group;
	}

	public removeGroup(group: IEditorGroupView | EditorGroupId): void {
		this.removeGroupHost(this.groupHosts.get(typeof group === 'string' ? group : group.id)!);
	}

	public findGroup(scope: IFindGroupScope, source: IEditorGroup = this._activeGroup): IEditorGroup | undefined {
		const host = this.groupHosts.get(source.id)!;
		if (scope.direction !== undefined) {
			const directions = { [GroupDirection.UP]: Direction.Up, [GroupDirection.DOWN]: Direction.Down, [GroupDirection.LEFT]: Direction.Left, [GroupDirection.RIGHT]: Direction.Right };
			const neighbor = this.editorGrid.getNeighborViews(host.view, directions[scope.direction])[0];
			return neighbor && this._groups.find(candidate => candidate.view === neighbor)!.group;
		}
		const visible = this._groups.filter(candidate => this.editorGrid.isViewVisible(candidate.view));
		const index = visible.indexOf(host);
		switch (scope.location) {
			case GroupLocation.FIRST: return visible[0]?.group;
			case GroupLocation.LAST: return visible.at(-1)?.group;
			case GroupLocation.NEXT: return visible[index + 1]?.group;
			case GroupLocation.PREVIOUS: return visible[index - 1]?.group;
		}
		return undefined;
	}

	public isGroupVisible(id: EditorGroupId): boolean {
		return this.editorGrid.isViewVisible(this.groupHosts.get(id)!.view);
	}

	public setGroupVisible(id: EditorGroupId, visible: boolean): void {
		const host = this.groupHosts.get(id)!;
		if (this.editorGrid.isViewVisible(host.view) === visible) return;
		host.group.setEditorContentVisible(visible);
		this.editorGrid.setViewVisible(host.view, visible);
		this.layoutEditorContent();
		this.notifyConstraintsChanged();
		this.editorChangeEmitter.fire({ kind: 'groupVisibilityChanged', groupId: id, visible });
	}

	private get editorGrid(): SerializableGrid<EditorGroupGridView> {
		const grid = this.gridSlot.value;
		if (!grid) throw new Error("Editor Grid is unavailable");
		return grid;
	}

	get activeInput(): IResourceEditorInput | undefined {
		if (this.modalEditor.isVisible) return this.modalEditor.activeInput;
		return this._activeGroup.activeInput;
	}

	get activePane(): IEditorPane | undefined {
		if (this.modalEditor.isVisible) return this.modalEditor.activePane;
		return this._activeGroup.activePane;
	}

	get isModalEditorVisible(): boolean {
		return this.modalEditor.isVisible;
	}

	get editorsMru(): readonly EditorIdentifier[] {
		return this.editorsObserver.editors;
	}

	get recentlyClosedEditors(): readonly RecentlyClosedEditor[] {
		return Object.freeze([...this.recentlyClosed]);
	}

	getEditorState(): EditorPartState {
		return Object.freeze({
			groups: Object.freeze(this._groups.map(({ group }) => group.getEditorState())),
			activeGroupId: this._activeGroup.id,
			activeEditor: this.activeEditorIdentifier(),
			isModalEditorVisible: this.modalEditor.isVisible,
		});
	}

	async openEditor(input: IResourceEditorInput, options: EditorOpenOptions = {}, target?: EditorOpenTarget): Promise<IEditorPane> {
		if (target === "modalGroup") {
			const modalInput = this.modalEditor.activeInput;
			if (modalInput && editorInputKey(modalInput) !== editorInputKey(input) && !await this.closeEditor(modalInput)) {
				throw new CancellationError("Opening the modal editor was cancelled");
			}
			const pane = await this.modalEditor.openEditor(input, options);
			this.editorChangeEmitter.fire(Object.freeze({ kind: "modalEditorChanged", visible: true }));
			return pane;
		}
		if (!await this.closeActiveModalEditor()) throw new CancellationError("Opening the editor was cancelled");
		if (typeof target === 'object') {
			const group = this.groupHosts.get(target.groupId)!.group;
			const pane = await group.openEditor(input, options);
			if (!options.preserveFocus) this.setActiveGroup(group);
			return pane;
		}
		if (target === undefined && this._groups.length > 1 && this._activeGroup.isLocked && !this._activeGroup.inputs.some(candidate => editorInputKey(candidate) === editorInputKey(input))) {
			const unlocked = this._groups.find(({ group }) => !group.isLocked);
			const host = unlocked ?? this.insertGroup(this._activeGroup, Direction.Right);
			try {
				const pane = await host.group.openEditor(input, options);
				if (!options.preserveFocus) this.setActiveGroup(host.group);
				return pane;
			} catch (error) {
				if (!unlocked) this.removeGroupHost(host);
				throw error;
			}
		}
		if (target === undefined || target === "activeGroup") return this._activeGroup.openEditor(input, options);
		const source = this._activeGroup;
		const { host, created } = this.resolveSideGroup(source);
		try {
			const pane = await host.group.openEditor(input, options);
			if (!options.preserveFocus) {
				this.setActiveGroup(host.group);
			}
			return pane;
		} catch (error) {
			if (created) this.removeGroupHost(host);
			this.setActiveGroup(source);
			throw error;
		}
	}

	private resolveEditorOpenError(error: unknown, input: IResourceEditorInput, options: EditorOpenOptions, open: (options: EditorOpenOptions) => Promise<IEditorPane>): unknown {
		console.error("Could not open editor", error);
		let displayError = error;
		if (error instanceof TextFileBinaryError) {
			const editorId = this.groupOptions.configurationService?.getValue<string>(DefaultBinaryEditorConfiguration) || "ash.editor.binary";
			const binaryEditor = this.groupOptions.registry.getEditorPanesForInput(input).find(candidate => candidate.id === editorId);
			const actions: IAction[] = binaryEditor ? [{
				id: "workbench.editor.openAsBinary",
				label: localize("workbench.editorOpenAsBinary", "Open as Binary"),
				tooltip: "",
				enabled: true,
				run: () => open({ ...options, preferredEditorId: binaryEditor.id }),
			}] : [];
			displayError = createEditorOpenError(localize("workbench.editorOpenBinaryMessage", "This file cannot be displayed as text because it is binary or uses an unsupported text encoding."), actions, {
				forceMessage: true,
				forceSeverity: Severity.Warning,
			});
		} else if (error instanceof FileNotFoundError) {
			const files = this.groupOptions.fileService;
			const actions: IAction[] = files && input.readOnly !== true ? [{
				id: "workbench.editor.createMissingFile",
				label: localize("workbench.editorOpenCreateFile", "Create file"),
				tooltip: "",
				enabled: true,
				run: async () => {
					await files.createFile(input.resource, "error");
					await open({ ...options, pinned: true });
				},
			}] : [];
			displayError = createEditorOpenError(localize("workbench.editorOpenNotFound", "The file could not be opened because it was not found."), actions, { forceMessage: true, allowDialog: true });
		} else if (error instanceof TextFileTooLargeError) {
			displayError = createEditorOpenError(localize("workbench.editorOpenTooLarge", "This file is too large to open as text ({0} MiB).", (error.sizeBytes / 1024 / 1024).toFixed(1)), [], { forceMessage: true, forceSeverity: Severity.Warning });
		}
		return displayError;
	}

	private async showEditorOpenErrorDialog(error: unknown, input: IResourceEditorInput, options: EditorOpenOptions): Promise<void> {
		if (options.source !== EditorOpenSource.USER || !this.dialogService) return;
		if (this.groupOptions.configurationService?.getValue<boolean>(EditorOpenErrorDialogConfiguration) === false) return;
		const openError = isEditorOpenError(error) ? error : undefined;
		if (openError && !openError.allowDialog) return;
		const title = localize("workbench.editorOpenFailure", "Unable to open {0}", input.label || basename(input.resource));
		const severity = openError?.forceSeverity === Severity.Warning ? DialogSeverity.Warning
			: openError?.forceSeverity === Severity.Info ? DialogSeverity.Info : DialogSeverity.Error;
		const actions = openError?.actions ?? [];
		const { result } = await this.dialogService.prompt({
			title,
			message: openError?.forceMessage ? openError.message : title,
			detail: openError?.forceMessage ? undefined : error instanceof Error ? error.message : String(error),
			severity,
			buttons: actions.length
				? actions.filter(action => action.enabled).map(action => ({ label: action.label, run: () => action }))
				: [{ label: localize("workbench.editorOpenDismiss", "Dismiss"), run: () => undefined }],
			cancelButton: localize("workbench.editorOpenDismiss", "Dismiss"),
		});
		if (result) {
			try {
				await result.run();
			} catch (actionError) {
				await this.dialogService.error(actionError instanceof Error ? actionError.message : String(actionError));
			}
		}
	}

	private confirmLargeFileOpen(input: IResourceEditorInput): Promise<void> | undefined {
		const fileService = this.groupOptions.fileService;
		const configuration = this.groupOptions.configurationService;
		const dialogService = this.dialogService;
		if (!fileService || !configuration || !dialogService || input.resource.scheme !== "file" || this._groups.some(({ group }) => group.inputs.some(open => editorInputKey(open) === editorInputKey(input)))) return undefined;
		const thresholdMiB = configuration.getValue<number>(EditorLargeFileConfirmationConfiguration);
		return fileService.stat(input.resource).then(async stat => {
			if (stat.sizeBytes < thresholdMiB * 1024 * 1024) return;
			const confirmed = await dialogService.confirm({
				title: "Open Large File",
				message: `Open ${input.label ?? (basename(input.resource) || input.resource.path)}?`,
				detail: `This file is ${(stat.sizeBytes / 1024 / 1024).toFixed(1)} MiB. Opening it may take time and use substantial memory.`,
				primaryButton: "Open File",
				cancelButton: "Cancel",
			});
			if (!confirmed.confirmed) throw new CancellationError("Opening the large file was cancelled");
		});
	}

	toggleActiveGroupLock(): boolean {
		const locked = !this._activeGroup.isLocked;
		this._activeGroup.setLocked(locked);
		return locked;
	}

	activateEditor(input: IResourceEditorInput): IEditorPane {
		if (this.modalEditor.activeInput?.resource.toString() === input.resource.toString()) {
			this.modalEditor.focus();
			return this.modalEditor.activePane!;
		}
		return this._activeGroup.activateEditor(input);
	}

	activateEditorIdentifier(identifier: EditorIdentifier): IEditorPane | undefined {
		const host = this._groups.find(candidate => candidate.group.id === identifier.groupId);
		const editor = host?.group.editors.find(candidate => candidate.instanceId === identifier.instanceId);
		if (!host || !editor) return undefined;
		this.setActiveGroup(host.group);
		return host.group.activateEditor(editor.input);
	}

	activateEditorMru(offset: number): IEditorPane | undefined {
		if (!Number.isInteger(offset) || offset === 0) throw new TypeError("Editor MRU offset must be a non-zero integer");
		const editors = this.editorsMru;
		if (editors.length === 0) return undefined;
		const index = rot(offset, editors.length);
		return this.activateEditorIdentifier(editors[index]!);
	}

	async closeEditor(input: IResourceEditorInput): Promise<boolean> {
		if (this.modalEditor.activeInput && editorInputKey(this.modalEditor.activeInput) === editorInputKey(input)) {
			const pane = this.modalEditor.activePane;
			if (pane && !await this.confirmEditorClose(undefined, input, pane)) return false;
			if (!this.modalEditor.closeEditor(input)) return false;
			if (pane) this.addRecentlyClosed(input, pane.id);
			this.editorChangeEmitter.fire(Object.freeze({ kind: "modalEditorChanged", visible: false }));
			return true;
		}
		return await this._activeGroup.closeEditor(input);
	}

	async closeEditorIdentifier(identifier: EditorIdentifier): Promise<boolean> {
		const host = this._groups.find(candidate => candidate.group.id === identifier.groupId);
		const editor = host?.group.editors.find(candidate => candidate.instanceId === identifier.instanceId);
		return host && editor ? host.group.closeEditor(editor.input) : false;
	}

	async closeAllEditors(options: EditorCloseAllOptions = {}): Promise<boolean> {
		if (!options.skipConfirmation && !await this.confirmCloseAllEditors()) return false;
		const modalInput = this.modalEditor.activeInput;
		const modalPane = this.modalEditor.activePane;
		const inputsByGroup = this._groups.map(({ group }) => ({ group, inputs: [...group.inputs] }));
		if (modalInput) {
			this.modalEditor.closeEditor(modalInput);
			if ((options.reason ?? "close") === "close" && modalPane) this.addRecentlyClosed(modalInput, modalPane.id);
			this.editorChangeEmitter.fire(Object.freeze({ kind: "modalEditorChanged", visible: false }));
		}
		for (const { group } of inputsByGroup) {
			for (const input of [...group.inputs]) await group.closeEditor(input, { skipConfirmation: true, reason: options.reason ?? "close" });
		}
		return true;
	}

	async confirmCloseAllEditors(): Promise<boolean> {
		const modalInput = this.modalEditor.activeInput;
		const modalPane = this.modalEditor.activePane;
		const inputsByGroup = this._groups.map(({ group }) => ({ group, inputs: [...group.inputs] }));
		const closingGroups = inputsByGroup.map(({ group }) => group.id);
		if (modalInput && modalPane && !await this.confirmEditorClose(undefined, modalInput, modalPane, closingGroups)) return false;
		for (const { group, inputs } of inputsByGroup) {
			for (const input of inputs) {
				if (!await group.confirmCloseEditor(input, closingGroups)) return false;
			}
		}
		return true;
	}

	async moveActiveEditorTo(target: IEditorPart): Promise<boolean> {
		const input = this._activeGroup.activeInput;
		if (!input || target === this) return false;
		await this._activeGroup.moveEditorTo(input, target.activeGroup, target.activeGroup.inputs.length);
		return true;
	}

	async saveActiveEditor(): Promise<void> {
		await this.activePane?.save?.();
	}

	async setContent(content: Element): Promise<void> {
		if (!await this.closeActiveModalEditor() || !await this._activeGroup.setContent(content)) {
			throw new CancellationError("Replacing editor content was cancelled");
		}
	}

	async splitActiveGroupHorizontal(): Promise<void> {
		await this.splitActiveGroup(Direction.Right);
	}

	async splitActiveGroupVertical(): Promise<void> {
		await this.splitActiveGroup(Direction.Down);
	}

	async splitActiveGroup(direction: GridDirection): Promise<void> {
		await this.splitEditors(this._activeGroup.id, this._activeGroup.activeInput ? [this._activeGroup.activeInput] : [], direction);
	}

	async splitEditors(groupId: EditorGroupId, inputs: readonly IResourceEditorInput[], direction: GridDirection): Promise<void> {
		const source = this.groupHosts.get(groupId)!.group;
		const previousActive = this._activeGroup;
		const created = this.insertGroup(source, direction);
		this.setActiveGroup(created.group);
		try {
			for (const input of inputs) {
				const preferredEditorId = source.editors.find(editor => editor.input === input)?.paneId;
				await created.group.openEditor(input, { pinned: true, preferredEditorId });
			}
			created.group.focus();
		} catch (error) {
			this.removeGroupHost(created);
			this.setActiveGroup(previousActive);
			throw error;
		}
	}

	getEditorPaneChoices(input: IResourceEditorInput | undefined = this.activeInput): readonly IEditorPaneDescriptor[] {
		return input ? this.groupOptions.registry.getEditorPanesForInput(input) : [];
	}

	async reopenActiveEditorWith(preferredEditorId: string): Promise<IEditorPane | undefined> {
		const input = this.activeInput;
		if (!input) return undefined;
		return await this.openEditor(input, { preferredEditorId, pinned: true }, this.modalEditor.isVisible ? "modalGroup" : "activeGroup");
	}

	async reopenClosedEditor(): Promise<boolean> {
		const closed = this.recentlyClosed.shift();
		if (!closed) return false;
		try {
			const choices = this.groupOptions.registry.getEditorPanesForInput(closed.input);
			const preferredEditorId = choices.some(choice => choice.id === closed.preferredEditorId)
				? closed.preferredEditorId
				: undefined;
			await this.openEditor(closed.input, { ...(preferredEditorId ? { preferredEditorId } : {}), pinned: true });
			return true;
		} catch (error) {
			this.recentlyClosed.unshift(closed);
			throw error;
		}
	}

	protected getFloatingBorderWidth(): number {
		return this.groupOptions.configurationService?.getValue(WorkbenchConfiguration.layoutStyle) === "modern"
			? computeScreenAwareSize(this.domNode.ownerDocument.defaultView!, EDITOR_FRAME_BORDER_WIDTH)
			: 0;
	}

	override layout(dimension: IDimension): void {
		const height = dimension.height - this.getFloatingBorderWidth() * 2;
		this.doLayout(this.layoutContents(dimension.width, height).contentSize);
	}

	public getTabsHeight(): number {
		return this._activeGroup.titleHeight.offset;
	}

	public setContentRightInset(inset: number): void {
		this.contentRightInset = inset;
		this.layoutEditorContent();
	}

	private layoutEditorContent(): void {
		// A single group keeps its tabs across the shared column. Split groups reserve
		// Details once at the grid boundary, rather than subtracting it from every pane.
		const visibleGroups = this._groups.filter(host => this.editorGrid.isViewVisible(host.view));
		const inset = Math.min(this.contentRightInset, this.dimension.width);
		for (const host of this._groups) {
			host.group.setContentRightInset(visibleGroups.length === 1 ? inset : 0);
			host.group.setEditorContentVisible(this.editorContentVisible && this.editorGrid.isViewVisible(host.view));
		}
		this.editorGrid.layout(this.dimension.width - (visibleGroups.length > 1 ? inset : 0), this.dimension.height);
		this.layoutEmitter.fire(this.dimension);
	}

	private observeGrid(): void {
		this.gridChanges.value = this.editorGrid.onDidChange(() => this.layoutEmitter.fire(this.dimension));
	}

	public setEditorContentVisible(visible: boolean): void {
		this.editorContentVisible = visible;
		for (const host of this._groups) {
			host.group.setEditorContentVisible(visible && this.editorGrid.isViewVisible(host.view));
		}
	}

	private doLayout(dimension: IDimension): void {
		if (Dimension.equals(this.dimension, dimension)) return;
		this.dimension = new Dimension(dimension.width, dimension.height);
		this.layoutEditorContent();
	}

	focus(): void {
		if (this.modalEditor.isVisible) {
			this.modalEditor.focus();
			return;
		}
		this._activeGroup.focus();
	}

	private async closeActiveModalEditor(): Promise<boolean> {
		const input = this.modalEditor.activeInput;
		if (!input) return true;
		return await this.closeEditor(input);
	}

	private async confirmEditorClose(group: IEditorGroupView | undefined, input: IResourceEditorInput, pane: IEditorPane, closingGroups: readonly EditorGroupId[] = []): Promise<boolean> {
		const workingCopy = pane.workingCopy;
		if (!workingCopy?.isDirty) return true;
		// Another open view still owns this dirty document, including a custom view in the same group.
		if (this._groups.some(host => !closingGroups.includes(host.group.id) && host.group.editors.some(other => other.canRevert && (host.group !== group || other.input !== input) && other.input.resource.toString() === input.resource.toString()))) {
			return true;
		}
		if (!this.fileDialogService) return false;
		const label = editorInputLabel(input);
		const decision = await this.fileDialogService.showSaveConfirm([label], workingCopy.hasExternalChange
			? "The file has also changed on disk. Saving may require resolving a conflict." : undefined);
		if (decision === ConfirmResult.CANCEL) return false;
		const controller = new AbortController();
		if (decision === ConfirmResult.DONT_SAVE) {
			await workingCopy.revert(controller.signal);
			return !workingCopy.isDirty;
		}
		if (group && input.resource.scheme === 'untitled') return this.saveEditor(group, input, pane);
		await workingCopy.save(controller.signal);
		if (group && !group.inputs.some(candidate => editorInputKey(candidate) === editorInputKey(input))) return true;
		return !workingCopy.isDirty;
	}

	private async saveEditor(group: IEditorGroupView, input: IResourceEditorInput, pane: IEditorPane): Promise<boolean> {
		if (input.resource.scheme !== "untitled") throw new Error("Save As is only available for untitled editors");
		if (!this.saveAsResource) throw new Error("Editor Save As is unavailable in this host");
		if (!pane.saveAs) throw new Error("The active editor cannot save this document");
		const target = await this.saveAsResource(editorInputLabel(input));
		if (!target) return false;
		await pane.saveAs(target);
		await this.replaceEditorResource!(group, input, {
			resource: target,
			label: editorInputLabel({ resource: target }),
		});
		return true;
	}

	private createGroup(id?: EditorGroupId): EditorGroupHost {
		let group: EditorGroupView;
		group = this.instantiationService.createInstance(EditorGroupView, this.contentDomNode, {
			...this.groupOptions,
			...(id ? { id } : {}),
			onDidActivate: () => {
				this.setActiveGroup(group);
			},
			dragAndDrop: {
				start: (source, input) => this.tabDragAndDrop.start(source, input),
				isDragging: () => this.tabDragAndDrop.isDragging(),
				drop: (target, targetInput, position, splitDirection) => this.tabDragAndDrop.drop(target, targetInput, position, splitDirection),
				end: () => this.tabDragAndDrop.end(),
			},
		} satisfies EditorGroupOptions);
		const host = new EditorGroupHost(group, group.onDidChangeEditors(event => {
			this.handleEditorGroupChange(event);
			this.editorChangeEmitter.fire(Object.freeze({ kind: "groupChanged", groupId: group.id, event }));
		}));
		if (this.groupHosts.has(group.id)) {
			host.dispose();
			throw new Error(`Duplicate editor group ID: ${group.id}`);
		}
		this.groupHosts.set(group.id, host);
		return host;
	}

	private resolveSideGroup(source: EditorGroupView): { readonly host: EditorGroupHost; readonly created: boolean; } {
		const sourceIndex = this.groupIndex(source);
		const existing = this._groups[sourceIndex + 1];
		if (existing) return { host: existing, created: false };
		const direction = this.groupOptions.configurationService?.getValue<string>(EditorOpenSideBySideDirectionConfiguration) === 'down' ? Direction.Down : Direction.Right;
		return { host: this.insertGroup(source, direction), created: true };
	}

	protected insertGroup(source: IEditorGroupView, direction: GridDirection, id?: EditorGroupId): EditorGroupHost {
		const sourceIndex = this.groupIndex(source);
		const sourceHost = this._groups[sourceIndex]!;
		const created = this.createGroup(id);
		const targetIndex = sourceIndex + 1;
		this._groups.splice(targetIndex, 0, created);
		this.preserveFocus(() => this.editorGrid.addView(created.view, Sizing.Split, sourceHost.view, direction));
		this.layoutEditorContent();
		this.notifyConstraintsChanged();
		this.editorChangeEmitter.fire(Object.freeze({ kind: "groupAdded", group: created.group.getEditorState() }));
		return created;
	}

	private removeGroupHost(host: EditorGroupHost): void {
		const index = this._groups.indexOf(host);
		if (index < 0) return;
		if (this._groups.length === 1) throw new Error("EditorPart cannot remove its last group");
		this.preserveFocus(() => this.editorGrid.removeView(host.view));
		this._groups.splice(index, 1);
		this.layoutEditorContent();
		this.notifyConstraintsChanged();
		if (this._activeGroup === host.group) {
			this.setActiveGroup((this._groups[index] ?? this._groups[index - 1])!.group);
		}
		this.editorChangeEmitter.fire(Object.freeze({ kind: "groupRemoved", groupId: host.group.id }));
		this.groupHosts.deleteAndDispose(host.group.id);
	}

	private groupIndex(group: IEditorGroupView): number {
		const index = this._groups.findIndex((host) => host.group === group);
		if (index < 0) throw new Error("EditorGroupView is not owned by EditorPart");
		return index;
	}

	private preserveFocus(action: () => void): void {
		const focused = this.domNode.ownerDocument.activeElement;
		const owned = focused instanceof this.domNode.ownerDocument.defaultView!.HTMLElement && this.domNode.contains(focused);
		action();
		// Grid structure changes can reattach a retained pane; preserve its actual input focus.
		if (owned && focused.isConnected) focused.focus({ preventScroll: true });
	}

	private dropEditor(event: EditorTabDropEvent): void {
		// Independent editor hosts can have different pane registries. Reject a transfer
		// the receiving host cannot render before moving or closing its source input.
		if (!this.groupOptions.registry.getEditorPanesForInput(event.input).length) return;
		if (event.splitDirection) {
			const created = this.insertGroup(event.target, event.splitDirection);
			void event.source.moveEditorTo(event.input, created.group, 0)
				.then(() => {
					const sourceHost = this._groups.find(host => host.group === event.source);
					if (sourceHost && sourceHost.group.inputs.length === 0 && this._groups.length > 1) this.removeGroupHost(sourceHost);
					this.setActiveGroup(created.group);
					created.group.focus();
				})
				.catch(error => {
					if (this._groups.includes(created)) this.removeGroupHost(created);
					console.error("Failed to split Editor tab", error);
				});
			return;
		}
		const targetIndex = event.target.getEditorInsertionIndex(event.targetInput, event.position);
		if (event.source === event.target) {
			event.target.moveEditor(event.input, targetIndex);
			this.setActiveGroup(event.target);
			event.target.focus();
			return;
		}
		void event.source.moveEditorTo(event.input, event.target, targetIndex)
			.then(() => {
				this.setActiveGroup(event.target);
				event.target.focus();
			})
			.catch((error) => {
				console.error("Failed to move Editor tab", error);
			});
	}

	saveWorkingSet(id: string, excludedGroups: readonly EditorGroupId[] = []): EditorWorkingSet {
		if (!id.trim()) throw new TypeError("Editor working set requires a non-empty ID");
		const areas = this._groups.map(({ view }) => {
			const size = this.editorGrid.getViewSize(view);
			return size.width * size.height;
		});
		const totalArea = areas.reduce((sum, area) => sum + area, 0);
		const state: EditorWorkingSet = Object.freeze({
			id,
			activeGroupIndex: this._groups.findIndex(({ group }) => group === this._activeGroup),
			groups: Object.freeze(this._groups.map(({ group }, index) => Object.freeze({
				id: group.id,
				locked: group.isLocked,
				editors: Object.freeze(group.inputs.map(input => {
					const viewState = group.saveEditorViewState(input);
					return Object.freeze({
						input: this.inputSerializers.serialize(input),
						preview: group.isPreview(input),
						sticky: group.isSticky(input),
						...(viewState ? { viewState } : {}),
					});
				})),
				activeEditorIndex: group.activeInput ? group.inputs.indexOf(group.activeInput) : -1,
				size: totalArea > 0 ? areas[index]! / totalArea : 1 / this._groups.length,
			}))),
			layout: this.serializeLayout(),
		});
		if (excludedGroups.length === 0) return state;
		const groups = state.groups.filter(group => !excludedGroups.includes(group.id!));
		if (groups.length === 0) throw new Error('An editor working set must include a group');
		const active = state.groups[state.activeGroupIndex]!;
		return { ...state, groups, activeGroupIndex: Math.max(0, groups.indexOf(active)), layout: filterWorkingSetLayout(state.layout!, new Set(groups.map(group => group.id!)))! };
	}

	async applyWorkingSet(workingSet: EditorWorkingSetTarget, options: ApplyEditorWorkingSetOptions = {}): Promise<void> {
		const target = workingSet === "empty" ? emptyWorkingSet() : validateWorkingSet(workingSet);
		const groups = target.groups.map(group => ({
			...group,
			inputs: group.editors.map(editor => this.inputSerializers.deserialize(editor.input)),
		}));
		const hadEditorFocus = this.domNode.contains(this.domNode.ownerDocument.activeElement);
		if (!await this.closeActiveModalEditor()) throw new CancellationError('Applying the editor working set was cancelled');
		const retained = (options.preserveGroups ?? []).map(id => this.groupHosts.get(id)!);
		const retainedLayout = retained.length ? filterWorkingSetLayout(this.editorGrid.serialize() as EditorWorkingSetLayout, new Set(retained.map(host => host.group.id))) : undefined;
		const closing = this._groups.filter(host => !retained.includes(host));
		for (const { group } of closing) {
			for (const input of group.inputs) {
				if (!await group.confirmCloseEditor(input, closing.map(host => host.group.id))) throw new CancellationError('Applying the editor working set was cancelled');
			}
		}
		for (const { group } of closing) {
			for (const input of [...group.inputs]) await group.closeEditor(input, { reason: 'reset', skipConfirmation: true });
		}
		this.rebuildGroups(groups, target.layout, target.activeGroupIndex, retained, retainedLayout);
		for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
			const state = groups[groupIndex]!;
			const group = this._groups[retained.length + groupIndex]!.group;
			for (let inputIndex = 0; inputIndex < state.inputs.length; inputIndex += 1) {
				const input = state.inputs[inputIndex]!;
				await group.openEditor(input, {
					index: inputIndex,
					pinned: !state.editors[inputIndex]!.preview,
					preserveFocus: true,
				});
				group.restoreEditorViewState(input, state.editors[inputIndex]!.viewState);
				if (state.editors[inputIndex]!.sticky) group.stickEditor(input);
			}
			const activeInput = state.inputs[state.activeEditorIndex];
			if (activeInput) group.activateEditor(activeInput);
			group.setLocked(state.locked === true);
		}
		const activeGroup = this._groups[retained.length + target.activeGroupIndex]!;
		this.setActiveGroup(activeGroup.group);
		this.layoutEditorContent();
		if (!options.preserveFocus && hadEditorFocus) this._activeGroup.focus();
	}

	private rebuildGroups(
		groups: readonly { readonly id?: string; readonly size: number; }[],
		layout: EditorWorkingSetLayout | undefined,
		activeGroupIndex: number,
		retained: readonly EditorGroupHost[] = [],
		retainedLayout?: EditorWorkingSetLayout,
	): void {
		const previous = this._groups.splice(0);
		this.gridSlot.clear();
		for (const host of previous) {
			if (retained.includes(host)) continue;
			this.editorChangeEmitter.fire(Object.freeze({ kind: "groupRemoved", groupId: host.group.id }));
			this.groupHosts.deleteAndDispose(host.group.id);
		}
		const hosts = groups.map(group => this.createGroup(group.id));
		this._groups.push(...retained, ...hosts);
		const hostById = new Map(this._groups.map(host => [host.group.id, host]));
		const documentLayout = layout ?? { type: 'branch' as const, orientation: 'horizontal' as const, priority: 'normal' as const, size: this.dimension.width, children: hosts.map((host, index) => ({ type: 'leaf' as const, data: { groupId: host.group.id }, size: groups[index]!.size * this.dimension.width, visible: true, priority: 'normal' as const })) };
		const combinedLayout = retainedLayout ? { type: 'branch' as const, orientation: 'horizontal' as const, priority: 'normal' as const, size: this.dimension.width, children: [retainedLayout, documentLayout].flatMap(child => child.type === 'branch' && child.orientation === 'horizontal' ? child.children : [child]) } : layout;
		const grid = combinedLayout
			? SerializableGrid.deserialize<EditorGroupGridView>(this.contentDomNode, combinedLayout, {
				fromJSON: data => {
					const groupId = editorGroupIdFromGridData(data);
					const host = hostById.get(groupId);
					if (!host) throw new Error(`Editor Grid references unknown group '${groupId}'`);
					return host.view;
				},
			}, { styles: EDITOR_GROUP_GRID_STYLES })
			: new SerializableGrid(this.contentDomNode, legacyGridDescriptor(hosts, groups, this.dimension), { styles: EDITOR_GROUP_GRID_STYLES });
		this.gridSlot.value = grid;
		this.observeGrid();
		this._activeGroup = hosts[activeGroupIndex]!.group;
		this.layoutEditorContent();
		this.notifyConstraintsChanged();
		for (const host of hosts) {
			this.editorChangeEmitter.fire(Object.freeze({ kind: "groupAdded", group: host.group.getEditorState() }));
		}
	}

	private handleEditorGroupChange(event: EditorGroupChangeEvent): void {
		if (event.kind === "editorOpened" && this._groups.length > 1) {
			const group = this._groups.find(host => host.group.id === event.editor.groupId)?.group;
			const autoLock = this.groupOptions.configurationService?.getValue<AutoLockGroups>(AutoLockGroupsConfiguration);
			if (group?.inputs.length === 1 && autoLock?.[event.editor.paneId]) group.setLocked(true);
		}
		if (event.kind !== "editorClosed") return;
		if (event.reason === "close") this.addRecentlyClosed(event.editor.input, event.editor.paneId);
	}

	private addRecentlyClosed(input: IResourceEditorInput, preferredEditorId: string): void {
		if (input.resource.scheme === Schemas.untitled) return;
		const closed = Object.freeze({ input, preferredEditorId });
		const duplicate = this.recentlyClosed.findIndex(candidate => editorInputKey(candidate.input) === editorInputKey(closed.input) && candidate.preferredEditorId === closed.preferredEditorId);
		if (duplicate >= 0) this.recentlyClosed.splice(duplicate, 1);
		this.recentlyClosed.unshift(closed);
		if (this.recentlyClosed.length > 20) this.recentlyClosed.length = 20;
	}

	private setActiveGroup(group: EditorGroupView): void {
		if (this._activeGroup === group) return;
		this._activeGroup = group;
		this.editorChangeEmitter.fire(Object.freeze({ kind: "activeGroupChanged", groupId: group.id }));
	}

	private activeEditorIdentifier(): EditorIdentifier | undefined {
		const editor = this._activeGroup.editors.find(candidate => candidate.isActive);
		if (!editor) return undefined;
		return Object.freeze({ groupId: editor.groupId, instanceId: editor.instanceId, paneId: editor.paneId, input: editor.input });
	}
}

/** Pruning a working set preserves the exact geometry of the selected group subtree. */
function filterWorkingSetLayout(layout: EditorWorkingSetLayout, groups: ReadonlySet<string>): EditorWorkingSetLayout | undefined {
	if (layout.type === 'leaf') return groups.has(layout.data.groupId) ? layout : undefined;
	const children = layout.children.map(child => filterWorkingSetLayout(child, groups)).filter((child): child is EditorWorkingSetLayout => child !== undefined).flatMap(child => child.type === 'branch' && child.orientation === layout.orientation ? child.children : [child]);
	if (children.length === 0) return undefined;
	if (children.length === 1) return { ...children[0]!, size: layout.size };
	return { ...layout, children };
}

function remapWorkingSetLayout(layout: EditorWorkingSetLayout, groups: ReadonlyMap<string, string>): EditorWorkingSetLayout {
	if (layout.type === 'leaf') return { ...layout, data: { groupId: groups.get(layout.data.groupId)! } };
	return { ...layout, children: layout.children.map(child => remapWorkingSetLayout(child, groups)) };
}

function emptyWorkingSet(): EditorWorkingSet {
	return Object.freeze({
		id: "empty",
		activeGroupIndex: 0,
		groups: Object.freeze([Object.freeze({ editors: Object.freeze([]), activeEditorIndex: -1, size: 1 })]),
	});
}

function validateWorkingSet(value: EditorWorkingSet): EditorWorkingSet {
	if (!value || typeof value !== "object" || typeof value.id !== "string" || !value.id.trim()) {
		throw new TypeError("Invalid editor working set");
	}
	if (!isNonEmptyArray(value.groups) || !Number.isInteger(value.activeGroupIndex) || value.activeGroupIndex < 0 || value.activeGroupIndex >= value.groups.length) {
		throw new TypeError("Invalid editor working set groups");
	}
	let sizeTotal = 0;
	const groupIds = new Set<string>();
	for (const group of value.groups) {
		if (!group || typeof group !== "object" || !Array.isArray(group.editors) || !Number.isInteger(group.activeEditorIndex) || group.activeEditorIndex < -1 || group.activeEditorIndex >= group.editors.length || (group.locked !== undefined && typeof group.locked !== "boolean") || !Number.isFinite(group.size) || group.size < 0) {
			throw new TypeError("Invalid editor group working set");
		}
		if (group.id !== undefined) {
			if (!isEditorGroupId(group.id) || groupIds.has(group.id)) throw new TypeError("Invalid editor working set group ID");
			groupIds.add(group.id);
		}
		for (const editor of group.editors) {
			if (!editor || typeof editor !== "object" || typeof editor.preview !== "boolean" || (editor.sticky !== undefined && typeof editor.sticky !== "boolean") || (editor.sticky === true && editor.preview) || !isSerializedEditorInput(editor.input)) {
				throw new TypeError("Invalid editor working set entry");
			}
			if (editor.viewState !== undefined) {
				if (!editor.viewState || typeof editor.viewState !== "object" || typeof editor.viewState.typeId !== "string" || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(editor.viewState.typeId) || !("value" in editor.viewState)) {
					throw new TypeError("Invalid editor working set view state");
				}
				validateJsonValue(editor.viewState.value, { path: "editor working set view state" });
			}
		}
		sizeTotal += group.size;
	}
	if (sizeTotal <= 0) throw new TypeError("Invalid editor working set layout");
	if (value.layout !== undefined) {
		if (groupIds.size !== value.groups.length) throw new TypeError('Editor Grid layout requires an ID for every group');
		parseEditorWorkingSetLayout(value.layout, groupIds);
	}
	return value;
}

function isEditorGroupId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function editorGroupIdFromGridData(value: unknown): string {
	if (!value || typeof value !== "object" || Array.isArray(value) || !("groupId" in value) || !isEditorGroupId(value.groupId)) {
		throw new TypeError("Invalid Editor Grid group data");
	}
	return value.groupId;
}

function legacyGridDescriptor(
	hosts: readonly EditorGroupHost[],
	groups: readonly { readonly size: number; }[],
	dimension: IDimension,
): GridDescriptor<EditorGroupGridView> {
	const width = Math.max(1, dimension.width);
	return {
		type: "branch",
		orientation: "horizontal",
		size: width,
		children: hosts.map((host, index) => ({
			type: "leaf",
			view: host.view,
			size: width * groups[index]!.size,
		})),
	};
}

function editorInputLabel(input: Pick<IResourceEditorInput, "resource" | "label">): string {
	if (input.label?.trim()) return input.label;
	return basename(input.resource) || input.resource.toString();
}

class EditorGroupHost extends Disposable {
	readonly view: EditorGroupGridView;

	constructor(readonly group: EditorGroupView, listener: IDisposable) {
		super();
		this._register(group);
		this._register(listener);
		this.view = new EditorGroupGridView(group);
	}
}

class EditorGroupGridView implements ISerializableGridView {
	readonly minimumWidth = 120;
	readonly maximumWidth = Infinity;
	readonly minimumHeight = 119;
	readonly maximumHeight = Infinity;

	constructor(readonly group: EditorGroupView) { }

	get element(): HTMLElement {
		return this.group.domNode;
	}

	layout(bounds: IPositionedRectangle): void {
		this.group.layout(bounds);
	}

	toJSON(): unknown {
		return Object.freeze({ groupId: this.group.id });
	}
}

function reportEditorCloseError(error: unknown): void {
	console.error("Failed to close editor", error);
}
