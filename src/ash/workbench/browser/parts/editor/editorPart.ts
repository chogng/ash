import { Orientation } from '../../../../base/browser/ui/sash/sash.js';
import { LayoutPriority } from '../../../../base/browser/ui/splitview/splitview.js';
import { ErrorPlaceholderEditor } from './editorPlaceholder.js';
import { EditorInputCapabilities } from '../../../common/editor.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import type { IAction } from '../../../../base/common/actions.js';
import { localize } from '../../../../nls.js';
import Severity from '../../../../base/common/severity.js';
import { getEditorWorkingCopies, createEditorOpenError, isEditorOpenError, type IResourceEditorInput, type IEditorIdentifier, type IEditorPane } from '../../../common/editor.js';
import './media/editorpart.css';
import { isNonEmptyArray } from '../../../../base/common/arrays.js';
import { basename } from '../../../../base/common/resources.js';
import type { IContextMenuProvider } from '../../../../base/browser/contextmenu.js';
import { URI } from '../../../../base/common/uri.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { validateJsonValue } from '../../../../base/common/jsonValue.js';
import { computeScreenAwareSize, Dimension, type IDimension } from '../../../../base/browser/dom.js';
import { type IPositionedRectangle } from '../../../../base/browser/geometry.js';
import { Direction, SerializableGrid, Sizing, type GridDescriptor, type ISerializableView as ISerializableGridView } from '../../../../base/browser/ui/grid/grid.js';
import { DisposableMap, Disposable, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { rot } from '../../../../base/common/numbers.js';
import { Schemas } from '../../../../base/common/network.js';
import type { IMenuService } from '../../../../platform/actions/common/actions.js';
import { EditorOpenSource, TextEditorSelectionSource } from '../../../../platform/editor/common/editor.js';
import type { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import type { IKeyboardLayoutService } from '../../../../platform/keyboardLayout/common/keyboardLayout.js';
import type { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ConfirmResult, DialogSeverity, type IDialogService, type IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { TextFileBinaryError, TextFileTooLargeError } from '../../../services/textfile/common/textFileService.js';
import { type ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { FileNotFoundError, type IFileService } from '../../../../platform/files/common/files.js';
import type { IDiffService } from '../../../services/diff/common/diffService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import type { IDocumentCollaborationApi } from '../../../../platform/collab/common/documentCollaborationApi.js';
import type { IServerEventApi } from '../../../../platform/agentHost/common/appServerApi.js';
import { Part } from '../../part.js';
import { EditorGroupView, EditorOpenSupersededError, type EditorGroupOptions } from './editorGroupView.js';
import type { IEditorGroupView, IEditorGroupViewOptions } from './editor.js';
import { AutoLockGroupsConfiguration, DefaultBinaryEditorConfiguration, EditorLargeFileConfirmationConfiguration, EditorOpenErrorDialogConfiguration, type AutoLockGroups } from './editorConfiguration.js';
import type { FileElement } from './breadcrumbsModel.js';
import type { IBreadcrumbsService } from './breadcrumbs.js';
import type { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import type { LanguageDocumentSymbol } from '../../../../editor/common/languages.js';
import type { Range } from '../../../../editor/common/core/range.js';
import { EditorDropTarget } from './editorDropTarget.js';
import { EditorsObserver } from './editorsObserver.js';
import { EditorTabDragAndDropController, type EditorTabDropEvent } from './editorTabDragAndDrop.js';
import { GroupDirection, GroupLocation, type IEditorGroup, type IEditorGroupsContainer, type IFindGroupScope } from '../../../services/editor/common/editorGroupsService.js';
import type { EditorOpenOptions, EditorOpenTarget } from '../../../services/editor/common/editorService.js';
import type { TextResourceLanguageResolver } from '../../../../platform/language/common/textResourceLanguage.js';
import type { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';

import { EditorPanes, type IEditorPaneDescriptor, type IEditorPaneRegistry } from '../../editor.js';
import type { IBulkEditService } from '../../../../editor/browser/services/bulkEditService.js';
import type { ILanguageDiagnosticsService } from '../../../services/language/common/languageDiagnosticsService.js';
import { EditorInputSerializers, type EditorInputSerializerRegistry, isSerializedEditorInput, UnknownEditorInputSerializerError } from '../../../services/editor/common/editorInputSerializer.js';
import type { ApplyEditorWorkingSetOptions, EditorWorkingSet, EditorWorkingSetLayout, EditorWorkingSetTarget } from '../../../services/editor/common/editorWorkingSet.js';
import { parseEditorWorkingSetLayout } from '../../../services/editor/common/editorWorkingSet.js';
import { ModalEditorPart, type ModalEditorPartOptions } from './modalEditorPart.js';
import type { EditorGroupChangeEvent, EditorGroupId, EditorIdentifier, EditorPartChangeEvent, EditorPartState, IEditorStateSource } from '../../../services/editor/common/editorState.js';
import { WorkbenchConfiguration } from '../../../common/configuration.js';
import { EditorCloseEmptyGroupsConfiguration, EditorOpenSideBySideDirectionConfiguration } from '../../../services/editor/common/editorConfiguration.js';
import { EditorPartMaximizedEditorGroupContext, EditorPartMultipleEditorGroupsContext } from '../../../common/contextkeys.js';

export { EditorOpenSupersededError } from './editorGroupView.js';

/** Keep the CSS variable reference so theme changes recolor existing Grid boundaries without restyling the Grid. */
const EDITOR_GROUP_GRID_STYLES = { separatorBorder: 'var(--ash-editorGroup-border)' } as const;

// Matches the standard stroke token used by modernUI/browser/media/editorBorder.css.
const EDITOR_FRAME_BORDER_WIDTH = 1;

/** Editor-region operations available to Workbench contributions. */
export interface IEditorPart extends IEditorStateSource, IDisposable {
	readonly domNode: HTMLElement;
	readonly onDidChangeEditors: Event<EditorPartChangeEvent>;
	readonly groups: readonly IEditorGroupView[];
	readonly activeGroup: IEditorGroupView;
	addGroup(reference: EditorGroupId, direction: Direction): IEditorGroupView;
	removeGroup(group: IEditorGroupView | EditorGroupId): Promise<boolean>;
	activateGroup(id: EditorGroupId): void;
	findGroup(scope: IFindGroupScope, source?: IEditorGroup): IEditorGroup | undefined;
	isGroupVisible(id: EditorGroupId): boolean;
	setGroupVisible(id: EditorGroupId, visible: boolean): void;
	hasMaximizedGroup(): boolean;
	toggleMaximizeGroup(group?: IEditorGroup | EditorGroupId): void;
	toggleActiveGroupLock(): boolean;
	readonly activeInput: IResourceEditorInput | undefined;
	readonly activePane: IEditorPane | undefined;
	readonly isModalEditorVisible: boolean;
	readonly editorsMru: readonly EditorIdentifier[];

	openEditor(input: IResourceEditorInput, options?: EditorOpenOptions, target?: EditorOpenTarget): Promise<IEditorPane>;
	activateEditor(input: IResourceEditorInput): IEditorPane;
	activateEditorIdentifier(identifier: EditorIdentifier): IEditorPane | undefined;
	activateEditorMru(offset: number): IEditorPane | undefined;
	closeEditor(input: IResourceEditorInput): Promise<boolean>;
	closeEditorIdentifier(identifier: EditorIdentifier): Promise<boolean>;
	confirmCloseAllEditors(options?: EditorCloseAllOptions, closingEditors?: readonly IEditorIdentifier[]): Promise<boolean>;
	closeAllEditors(options?: EditorCloseAllOptions, closingEditors?: readonly IEditorIdentifier[]): Promise<boolean>;
	moveActiveEditorTo(target: IEditorPart): Promise<boolean>;
	saveActiveEditor(): Promise<void>;
	setContent(content: Element): Promise<void>;
	splitActiveGroup(direction: Direction): Promise<void>;
	/** Copies the requested tabs beside their source group without activating a source tab. */
	splitEditors(groupId: EditorGroupId, inputs: readonly IResourceEditorInput[], direction: Direction): Promise<void>;
	splitActiveGroupHorizontal(): Promise<void>;
	splitActiveGroupVertical(): Promise<void>;
	getEditorPaneChoices(input?: IResourceEditorInput): readonly IEditorPaneDescriptor[];
	reopenActiveEditorWith(preferredEditorId: string): Promise<IEditorPane | undefined>;
	saveWorkingSet(id: string, excludedGroups?: readonly EditorGroupId[]): EditorWorkingSet;
	applyWorkingSet(workingSet: EditorWorkingSetTarget, options?: ApplyEditorWorkingSetOptions): Promise<void>;
	layout(dimension: IDimension): void;
	focus(): void;
}

export interface EditorCloseAllOptions {
	readonly excludeSticky?: boolean;
	readonly reason?: 'close' | 'reset';
	readonly skipConfirmation?: boolean;
}

export const IEditorPart =
	createServiceIdentifier<IEditorPart>('editorPart');

/** Named collaborators used to construct the editor region. */
export interface IEditorPartOptions {
	/** Waits for resource-owned save recovery before reading dirty state or releasing a pane. */
	readonly beforeCloseEditor?: (resource: URI) => Promise<boolean>;
	/** Ash extension: reuse the editor host for single-content groups without changing ordinary multi-tab editors. */
	readonly editorLimit?: 1;
	readonly configurationService?: IConfigurationService;
	readonly contextKeyService?: IContextKeyService;
	readonly keybindingService?: IKeybindingService;
	readonly keyboardLayoutService?: IKeyboardLayoutService;
	readonly fileService?: IFileService;
	readonly textFileService?: ITextFileService;
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
	private readonly groupOptions: Omit<EditorGroupOptions, 'onDidActivate' | 'dragAndDrop'>;
	private readonly _groups: EditorGroupHost[] = [];
	/** Grid retains hidden sizes; retain only the visibility and layout needed to restore this operation. */
	private maximizedGroup: { id: EditorGroupId; visible: readonly EditorGroupId[]; layout: EditorWorkingSetLayout; } | undefined;
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
	private readonly beforeCloseEditor: IEditorPartOptions['beforeCloseEditor'];
	private readonly editorsObserver: EditorsObserver;
	private readonly openingIdentities = new Map<string | EditorGroupId, AbortController>();

	override get minimumWidth(): number { return Math.max(120, this.editorGrid.minimumWidth); }
	override get minimumHeight(): number { return 119; }

	constructor(
		container: HTMLElement,
		options: IEditorPartOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IUriIdentityService private readonly uriIdentity: IUriIdentityService,
	) {
		super(container, 'editor', themeService, storageService, {
			borderWidth: () => this.getFloatingBorderWidth() * 2,
		});
		const ownerDocument = container.ownerDocument;
		this._register(toDisposable(() => {
			for (const controller of this.openingIdentities.values()) controller.abort();
			this.openingIdentities.clear();
		}));
		this.beforeCloseEditor = options.beforeCloseEditor;
		this.titleDomNode.remove();
		this.domNode.setAttribute('aria-label', localize({ bundle: 'ash.regions', key: 'editor' }, 'Editor'));
		this.groupOptions = {
			editorLimit: options.editorLimit,
			registry: options.registry ?? EditorPanes,
			resolveOpenError: (error, input, openOptions, open) => this.resolveEditorOpenError(error, input, openOptions, open),
			onWillOpenEditor: input => this.confirmLargeFileOpen(input),
			onOpenError: (error, input, openOptions) => this.showEditorOpenErrorDialog(error, input, openOptions),
			configurationService: options.configurationService,
			contextKeyService: options.contextKeyService ? this._register(options.contextKeyService.createScoped(this.domNode)) : undefined,
			keybindingService: options.keybindingService,
			keyboardLayoutService: options.keyboardLayoutService,
			fileService: options.fileService,
			textFileService: options.textFileService,
			languageResolver: options.languageResolver,
			diffService: options.diffService,
			accessibilityService: options.accessibilityService,
			languageDiagnosticsService: options.languageDiagnosticsService,
			documentCollaborationApi: options.documentCollaborationApi,
			serverEvents: options.serverEvents,
			workingCopyService: options.workingCopyService,
			onWillCloseEditor: (group, input, pane, closingGroups, closingEditors) => this.confirmEditorClose(group, input, pane, closingGroups, closingEditors),
			onOpenLocation: location => this.openEditor({ resource: location.resource }, { selection: location.selectionRange ?? location.range, selectionSource: TextEditorSelectionSource.JUMP }).then(() => undefined),
			onApplyWorkspaceEdit: options.bulkEditService ? (edit, bulkOptions) => options.bulkEditService!.apply(edit, bulkOptions).then(result => result.isApplied) : undefined,
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
			type: 'leaf',
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
				languageResolver: options.languageResolver,
				diffService: options.diffService,
				accessibilityService: options.accessibilityService,
				languageDiagnosticsService: options.languageDiagnosticsService,
				documentCollaborationApi: options.documentCollaborationApi,
				serverEvents: options.serverEvents,
				workingCopyService: options.workingCopyService,
				onOpenLocation: location => this.openEditor({ resource: location.resource }, { selection: location.selectionRange ?? location.range, selectionSource: TextEditorSelectionSource.JUMP }).then(() => undefined),
				onApplyWorkspaceEdit: options.bulkEditService ? (edit, bulkOptions) => options.bulkEditService!.apply(edit, bulkOptions).then(result => result.isApplied) : undefined,
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

	public addGroup(reference: EditorGroupId, direction: Direction): IEditorGroupView {
		return this.insertGroup(this.groupHosts.get(reference)!.group, direction).group;
	}

	public activateGroup(id: EditorGroupId): void {
		this.setActiveGroup(this.groupHosts.get(id)!.group);
	}

	public getSize(group: IEditorGroupView | EditorGroupId): IDimension {
		return this.editorGrid.getViewSize(this.groupHosts.get(typeof group === 'number' ? group : group.id)!.view);
	}

	public setSize(group: IEditorGroupView | EditorGroupId, size: IDimension): void {
		this.editorGrid.resizeView(this.groupHosts.get(typeof group === 'number' ? group : group.id)!.view, size);
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
		const extra: EditorWorkingSetLayout[] = missing.map(host => ({ type: 'leaf', data: { groupId: host.group.id }, size: this.editorGrid.getViewSize(host.view).width, visible: true, priority: LayoutPriority.Normal }));
		const rebound = remapWorkingSetLayout(retained, groupMapping);
		const combined: EditorWorkingSetLayout = extra.length ? {
			type: 'branch', orientation: Orientation.HORIZONTAL, size: this.dimension.width, priority: LayoutPriority.Normal,
			children: [...(rebound.type === 'branch' && rebound.orientation === Orientation.HORIZONTAL ? rebound.children : [rebound]), ...extra],
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
		const source = this.groupHosts.get(typeof group === 'number' ? group : group.id)!;
		const target = this.groupHosts.get(typeof location === 'number' ? location : location.id)!;
		if (source === target) return source.group;
		const directions = { [GroupDirection.LEFT]: Direction.Left, [GroupDirection.RIGHT]: Direction.Right, [GroupDirection.UP]: Direction.Up, [GroupDirection.DOWN]: Direction.Down };
		this.preserveFocus(() => this.editorGrid.moveView(source.view, Sizing.Split, target.view, directions[direction]));
		this._groups.splice(this._groups.indexOf(source), 1);
		this._groups.splice(this._groups.indexOf(target) + (direction === GroupDirection.LEFT || direction === GroupDirection.UP ? 0 : 1), 0, source);
		this.layoutEditorContent();
		return source.group;
	}

	public async removeGroup(group: IEditorGroupView | EditorGroupId): Promise<boolean> {
		const host = this.groupHosts.get(typeof group === 'number' ? group : group.id);
		if (!host || this._groups.length === 1) return true;
		// Layout-only owners can replace this group synchronously in the same turn.
		if (!this.beforeCloseEditor && host.group.editors.every(editor => !editor.isDirty && !editor.input.closeHandler?.showConfirm())) {
			this.removeGroupHost(host);
			return true;
		}
		const closingEditors = host.group.inputs.map(editor => ({ editor, groupId: host.group.id }));
		for (const { editor: input } of closingEditors) {
			if (!await host.group.confirmCloseEditor(input, [host.group.id], closingEditors)) return false;
		}
		for (const { editor: input } of closingEditors) {
			if (!await host.group.closeEditor(input, { skipConfirmation: true })) return false;
		}
		if (this.groupHosts.get(host.group.id) !== host) return true;
		if (host.group.inputs.length) return false;
		this.removeGroupHost(host);
		return true;
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
		if (this.maximizedGroup && visible !== (id === this.maximizedGroup.id)) this.restoreMaximizedGroup();
		const host = this.groupHosts.get(id)!;
		if (this.editorGrid.isViewVisible(host.view) === visible) return;
		host.group.setEditorContentVisible(visible);
		this.editorGrid.setViewVisible(host.view, visible);
		this.layoutEditorContent();
		this.notifyConstraintsChanged();
		this.editorChangeEmitter.fire({ kind: 'groupVisibilityChanged', groupId: id, visible });
	}

	hasMaximizedGroup(): boolean { return this.maximizedGroup !== undefined; }

	toggleMaximizeGroup(group: IEditorGroup | EditorGroupId = this.activeGroup): void {
		const id = typeof group === 'number' ? group : group.id;
		const host = this.groupHosts.get(id);
		if (!host) return;
		const restoring = this.maximizedGroup?.id === id;
		this.restoreMaximizedGroup();
		if (!restoring && this._groups.length > 1) {
			const visible = this._groups.filter(candidate => this.editorGrid.isViewVisible(candidate.view)).map(candidate => candidate.group.id);
			const layout = this.serializeLayout();
			this.setGroupVisible(id, true);
			this.maximizedGroup = { id, visible, layout };
			for (const candidate of this._groups) {
				if (candidate !== host) this.setGroupVisible(candidate.group.id, false);
			}
		}
		this.layoutEditorContent();
		this.setActiveGroup(host.group);
		host.group.focus();
	}

	private restoreMaximizedGroup(): void {
		const previous = this.maximizedGroup;
		if (!previous) return;
		this.maximizedGroup = undefined;
		for (const host of this._groups) this.setGroupVisible(host.group.id, previous.visible.includes(host.group.id));
		this.layoutEditorContent();
	}

	private get editorGrid(): SerializableGrid<EditorGroupGridView> {
		const grid = this.gridSlot.value;
		if (!grid) throw new Error('Editor Grid is unavailable');
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

	getEditorState(): EditorPartState {
		return Object.freeze({
			groups: Object.freeze(this._groups.map(({ group }) => group.getEditorState())),
			activeGroupId: this._activeGroup.id,
			activeEditor: this.activeEditorIdentifier(),
			isModalEditorVisible: this.modalEditor.isVisible,
		});
	}

	async openEditor(input: IResourceEditorInput, options: EditorOpenOptions = {}, target?: EditorOpenTarget): Promise<IEditorPane> {
		const sideGroup = target === 'sideGroup' ? this.findSideGroup(this._activeGroup)?.group : undefined;
		const destination = typeof target === 'object' ? target.groupId : target === 'modalGroup' ? 'modalGroup' : target === 'sideGroup' ? sideGroup?.id ?? `sideGroup:${this._activeGroup.id}` : this._activeGroup.id;
		const controller = new AbortController();
		this.openingIdentities.get(destination)?.abort();
		this.openingIdentities.set(destination, controller);
		using openingLifetime = toDisposable(() => {
			if (this.openingIdentities.get(destination) !== controller) { return; }
			this.openingIdentities.delete(destination);
			const group = this._groups.find(host => host.group.id === destination)?.group;
			if (group) { queueMicrotask(() => this.removeEmptyGroup(group)); }
		});
		try {
			const identity = this.uriIdentity.resolveCanonicalUri(input.resource, controller.signal);
			if (!(identity instanceof URI)) await identity;
			if (controller.signal.aborted) throw new EditorOpenSupersededError(input);
		} catch (error) {
			if (controller.signal.aborted) throw new EditorOpenSupersededError(input);
			throw error;
		}
		this.assertNotDisposed();
		if (target === 'modalGroup') {
			const modalInput = this.modalEditor.activeInput;
			if (modalInput && !this.isSameEditor(modalInput, input) && !await this.closeEditor(modalInput)) {
				throw new CancellationError('Opening the modal editor was cancelled');
			}
			const pane = await this.modalEditor.openEditor(input, options);
			this.editorChangeEmitter.fire(Object.freeze({ kind: 'modalEditorChanged', visible: true }));
			return pane;
		}
		if (!await this.closeActiveModalEditor()) throw new CancellationError('Opening the editor was cancelled');
		if ((target === undefined && options.revealIfOpened) || ((input.capabilities ?? EditorInputCapabilities.None) & EditorInputCapabilities.Singleton)) {
			const group = [this._activeGroup, ...this._groups.map(({ group }) => group)].find(group => group.inputs.some(candidate => this.isSameEditor(candidate, input)));
			if (group) {
				const pane = await group.openEditor(input, options);
				if (!options.preserveFocus) {
					this.setActiveGroup(group);
				}
				return pane;
			}
		}
		if (typeof target === 'object') {
			const group = this.groupHosts.get(target.groupId)?.group;
			if (!group) throw new RangeError(`Editor group is not open: ${target.groupId}`);
			const pane = await group.openEditor(input, options);
			if (!options.preserveFocus) this.setActiveGroup(group);
			return pane;
		}
		if (target === undefined && this._groups.length > 1 && this._activeGroup.isLocked && !this._activeGroup.inputs.some(candidate => this.isSameEditor(candidate, input))) {
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
		if (target === undefined || target === 'activeGroup') return await this._activeGroup.openEditor(input, options);
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

	private isSameEditor(left: IResourceEditorInput, right: IResourceEditorInput): boolean {
		return left.editorId === right.editorId && this.uriIdentity.extUri.isEqual(left.resource, right.resource);
	}

	private resolveEditorOpenError(error: unknown, input: IResourceEditorInput, options: EditorOpenOptions, open: (options: EditorOpenOptions) => Promise<IEditorPane>): unknown {
		console.error('Could not open editor', error);
		let displayError = error;
		if (error instanceof TextFileBinaryError) {
			const editorId = this.groupOptions.configurationService?.getValue<string>(DefaultBinaryEditorConfiguration) || 'ash.editor.binary';
			const binaryEditor = this.groupOptions.registry.getEditorPanesForInput(input).find(candidate => candidate.id === editorId);
			const actions: IAction[] = binaryEditor ? [{
				id: 'workbench.editor.openAsBinary',
				label: localize('workbench.editorOpenAsBinary', 'Open as Binary'),
				tooltip: '',
				enabled: true,
				run: () => open({ ...options, preferredEditorId: binaryEditor.id }),
			}] : [];
			displayError = createEditorOpenError(localize('workbench.editorOpenBinaryMessage', 'This file cannot be displayed as text because it is binary or uses an unsupported text encoding.'), actions, {
				forceMessage: true,
				forceSeverity: Severity.Warning,
			});
		} else if (error instanceof FileNotFoundError) {
			const files = this.groupOptions.fileService;
			const actions: IAction[] = files && input.readOnly !== true ? [{
				id: 'workbench.editor.createMissingFile',
				label: localize('workbench.editorOpenCreateFile', 'Create file'),
				tooltip: '',
				enabled: true,
				run: async () => {
					await files.createFile(input.resource, 'error');
					await open({ ...options, pinned: true });
				},
			}] : [];
			displayError = createEditorOpenError(localize('workbench.editorOpenNotFound', 'The file could not be opened because it was not found.'), actions, { forceMessage: true, allowDialog: true });
		} else if (error instanceof TextFileTooLargeError) {
			displayError = createEditorOpenError(localize('workbench.editorOpenTooLarge', 'This file is too large to open as text ({0} MiB).', (error.sizeBytes / 1024 / 1024).toFixed(1)), [], { forceMessage: true, forceSeverity: Severity.Warning });
		}
		return displayError;
	}

	private async showEditorOpenErrorDialog(error: unknown, input: IResourceEditorInput, options: EditorOpenOptions): Promise<void> {
		if (options.source !== EditorOpenSource.USER || !this.dialogService) return;
		if (this.groupOptions.configurationService?.getValue<boolean>(EditorOpenErrorDialogConfiguration) === false) return;
		const openError = isEditorOpenError(error) ? error : undefined;
		if (openError && !openError.allowDialog) return;
		const title = localize('workbench.editorOpenFailure', 'Unable to open {0}', input.label || basename(input.resource));
		const severity = openError?.forceSeverity === Severity.Warning ? DialogSeverity.Warning
			: openError?.forceSeverity === Severity.Info ? DialogSeverity.Info : DialogSeverity.Error;
		const actions = openError?.actions ?? [];
		const { result } = await this.dialogService.prompt({
			title,
			message: openError?.forceMessage ? openError.message : title,
			detail: openError?.forceMessage ? undefined : error instanceof Error ? error.message : String(error),
			severity,
			buttons: actions.filter(action => action.enabled).map(action => ({ label: action.label, run: () => action })),
			cancelButton: localize('workbench.editorOpenDismiss', 'Dismiss'),
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
		if (!fileService || !configuration || !dialogService || input.resource.scheme !== 'file' || this._groups.some(({ group }) => group.inputs.some(open => this.isSameEditor(open, input)))) return undefined;
		const thresholdMiB = configuration.getValue<number>(EditorLargeFileConfirmationConfiguration);
		return fileService.stat(input.resource).then(async stat => {
			if (stat.sizeBytes < thresholdMiB * 1024 * 1024) return;
			const confirmed = await dialogService.confirm({
				title: 'Open Large File',
				message: `Open ${input.label ?? (basename(input.resource) || input.resource.path)}?`,
				detail: `This file is ${(stat.sizeBytes / 1024 / 1024).toFixed(1)} MiB. Opening it may take time and use substantial memory.`,
				primaryButton: 'Open File',
				cancelButton: 'Cancel',
			});
			if (!confirmed.confirmed) throw new CancellationError('Opening the large file was cancelled');
		});
	}

	toggleActiveGroupLock(): boolean {
		const locked = !this._activeGroup.isLocked;
		this._activeGroup.setLocked(locked);
		return locked;
	}

	activateEditor(input: IResourceEditorInput): IEditorPane {
		if (this.modalEditor.activeInput && this.uriIdentity.extUri.isEqual(this.modalEditor.activeInput.resource, input.resource)) {
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
		if (!Number.isInteger(offset) || offset === 0) throw new TypeError('Editor MRU offset must be a non-zero integer');
		const editors = this.editorsMru;
		if (editors.length === 0) return undefined;
		const index = rot(offset, editors.length);
		return this.activateEditorIdentifier(editors[index]!);
	}

	async closeEditor(input: IResourceEditorInput): Promise<boolean> {
		if (this.modalEditor.activeInput && this.isSameEditor(this.modalEditor.activeInput, input)) {
			const pane = this.modalEditor.activePane;
			if (pane && !await this.confirmEditorClose(undefined, input, pane)) return false;
			if (!this.modalEditor.closeEditor(input)) return false;
			this.editorChangeEmitter.fire(Object.freeze({ kind: 'modalEditorChanged', visible: false, closedEditor: pane ? { input, paneId: pane.id } : undefined }));
			return true;
		}
		return await this._activeGroup.closeEditor(input);
	}

	async closeEditorIdentifier(identifier: EditorIdentifier): Promise<boolean> {
		const host = this._groups.find(candidate => candidate.group.id === identifier.groupId);
		const editor = host?.group.editors.find(candidate => candidate.instanceId === identifier.instanceId);
		return host && editor ? host.group.closeEditor(editor.input) : false;
	}

	async closeAllEditors(options: EditorCloseAllOptions = {}, closingEditors?: readonly IEditorIdentifier[]): Promise<boolean> {
		const modalInput = this.modalEditor.activeInput;
		const modalPane = this.modalEditor.activePane;
		const inputsByGroup = this._groups.map(({ group }) => ({
			group,
			inputs: [...group.inputs].filter(input => closingEditors
				? closingEditors.some(candidate => candidate.groupId === group.id && candidate.editor === input)
				: !options.excludeSticky || !group.isSticky(input)),
		}));
		closingEditors ??= [
			...(modalInput ? [{ editor: modalInput, groupId: -1 }] : []),
			...inputsByGroup.flatMap(({ group, inputs }) => inputs.map(editor => ({ editor, groupId: group.id }))),
		];
		if (!options.skipConfirmation && !await this.confirmCloseAllEditors(options, closingEditors)) return false;
		if (modalInput && closingEditors.some(candidate => candidate.groupId === -1 && candidate.editor === modalInput)) {
			this.modalEditor.closeEditor(modalInput);
			this.editorChangeEmitter.fire(Object.freeze({ kind: 'modalEditorChanged', visible: false, closedEditor: (options.reason ?? 'close') === 'close' && modalPane ? { input: modalInput, paneId: modalPane.id } : undefined }));
		}
		for (const { group, inputs } of inputsByGroup) {
			for (const input of inputs) {
				await group.closeEditor(input, { skipConfirmation: true, reason: options.reason ?? 'close' });
			}
			if ((options.reason ?? 'close') === 'close') this.removeEmptyGroup(group);
		}
		return true;
	}

	async confirmCloseAllEditors(options: EditorCloseAllOptions = {}, closingEditors?: readonly IEditorIdentifier[]): Promise<boolean> {
		const modalInput = this.modalEditor.activeInput;
		const modalPane = this.modalEditor.activePane;
		const inputsByGroup = this._groups.map(({ group }) => ({ group, inputs: [...group.inputs] }));
		const closingGroups = inputsByGroup.map(({ group }) => group.id);
		closingEditors ??= [
			...(modalInput ? [{ editor: modalInput, groupId: -1 }] : []),
			...inputsByGroup.flatMap(({ group, inputs }) => inputs.filter(input => !options.excludeSticky || !group.isSticky(input)).map(editor => ({ editor, groupId: group.id }))),
		];
		if (modalInput && modalPane && closingEditors.some(candidate => candidate.groupId === -1 && candidate.editor === modalInput) && !await this.confirmEditorClose(undefined, modalInput, modalPane, closingGroups, closingEditors)) return false;
		for (const { group, inputs } of inputsByGroup) {
			for (const input of inputs) {
				if (!closingEditors.some(candidate => candidate.groupId === group.id && candidate.editor === input)) { continue; }
				// A retained sticky view still owns the document even when its other views close.
				let confirmingGroups = closingGroups;
				if (options.excludeSticky) {
					const retainedGroups = inputsByGroup.filter(candidate => candidate.group.editors.some(editor =>
						editor.isSticky && editor.canRevert && this.uriIdentity.extUri.isEqual(editor.input.resource, input.resource),
					)).map(candidate => candidate.group.id);
					confirmingGroups = closingGroups.filter(id => !retainedGroups.includes(id));
				}
				if (!await group.confirmCloseEditor(input, confirmingGroups, closingEditors)) { return false; }
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
		this.openingIdentities.get(this._activeGroup.id)?.abort();
		this.openingIdentities.get('modalGroup')?.abort();
		if (!await this.closeActiveModalEditor() || !await this._activeGroup.setContent(content)) {
			throw new CancellationError('Replacing editor content was cancelled');
		}
	}

	async splitActiveGroupHorizontal(): Promise<void> {
		await this.splitActiveGroup(Direction.Right);
	}

	async splitActiveGroupVertical(): Promise<void> {
		await this.splitActiveGroup(Direction.Down);
	}

	async splitActiveGroup(direction: Direction): Promise<void> {
		await this.splitEditors(this._activeGroup.id, this._activeGroup.activeInput ? [this._activeGroup.activeInput] : [], direction);
	}

	async splitEditors(groupId: EditorGroupId, inputs: readonly IResourceEditorInput[], direction: Direction): Promise<void> {
		const splittable = inputs.filter(input => !((input.capabilities ?? EditorInputCapabilities.None) & EditorInputCapabilities.Singleton));
		if (inputs.length > 0 && splittable.length === 0) return;
		const source = this.groupHosts.get(groupId)!.group;
		const previousActive = this._activeGroup;
		const created = this.insertGroup(source, direction);
		this.setActiveGroup(created.group);
		try {
			for (const input of splittable) {
				const preferredEditorId = source.editors.find(editor => editor.input === input)?.paneId;
				const viewState = source.saveEditorViewState(input);
				await created.group.openEditor(input, { pinned: true, preferredEditorId });
				created.group.restoreEditorViewState(input, viewState);
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
		return await this.openEditor(input, { preferredEditorId, pinned: true }, this.modalEditor.isVisible ? 'modalGroup' : 'activeGroup');
	}

	protected getFloatingBorderWidth(): number {
		return this.groupOptions.configurationService?.getValue(WorkbenchConfiguration.layoutStyle) === 'modern'
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
		if (this.contentRightInset === inset) {
			return;
		}
		this.contentRightInset = inset;
		this.layoutEditorContent();
	}

	private layoutEditorContent(): void {
		this.groupOptions.contextKeyService?.bufferChangeEvents(() => {
			this.groupOptions.contextKeyService!.setContext(EditorPartMultipleEditorGroupsContext.key, this._groups.length > 1);
			this.groupOptions.contextKeyService!.setContext(EditorPartMaximizedEditorGroupContext.key, this.hasMaximizedGroup());
		});
		// A single group keeps its tabs across the shared column. Split groups reserve
		// Details once at the grid boundary, rather than subtracting it from every pane.
		const visibleGroups = this._groups.filter(host => this.editorGrid.isViewVisible(host.view));
		this.domNode.classList.toggle('single-group', visibleGroups.length === 1);
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

	private async confirmEditorClose(group: IEditorGroupView | undefined, input: IResourceEditorInput, pane: IEditorPane, closingGroups: readonly EditorGroupId[] = [], closingEditors: readonly IEditorIdentifier[] = [{ editor: input, groupId: group?.id ?? -1 }]): Promise<boolean> {
		if (input.closeHandler?.showConfirm()) {
			const matches = (other: IResourceEditorInput): boolean => other.editorId === input.editorId && this.uriIdentity.extUri.isEqual(other.resource, input.resource);
			// A custom resource remains live while any view is retained. Confirm once,
			// at its final closing view, with the exact batch (including sticky exclusions).
			if (this._groups.some(host => host.group.inputs.some(other => matches(other) && !closingEditors.some(candidate => candidate.groupId === host.group.id && candidate.editor === other)))) return true;
			if (this.modalEditor.activeInput && matches(this.modalEditor.activeInput) && !closingEditors.some(candidate => candidate.groupId === -1 && candidate.editor === this.modalEditor.activeInput)) return true;
			const last = [...closingEditors].reverse().find(candidate => matches(candidate.editor));
			if (last && last.groupId !== (group?.id ?? -1)) return true;
			return await input.closeHandler.confirm(closingEditors) !== ConfirmResult.CANCEL;
		}
		const copies = getEditorWorkingCopies(pane);
		if (this.beforeCloseEditor) {
			for (const resource of copies.length ? copies.map(copy => copy.resource) : [input.resource]) {
				if (!await this.beforeCloseEditor(resource)) return false;
			}
		}
		// Prompt only for files that lose their last retained editor, including files in other multi-diffs.
		const dirty = copies.filter(copy => copy.isDirty && !this._groups.some(host =>
			host.group.editors.some(other => {
				if (closingEditors.some(candidate => candidate.groupId === host.group.id && candidate.editor === other.input)) return false;
				const otherPane = host.group.getEditorPane(other.input);
				return otherPane && getEditorWorkingCopies(otherPane).some(candidate => this.uriIdentity.extUri.isEqual(candidate.resource, copy.resource));
			})));
		if (!dirty.length) return true;
		if (!this.fileDialogService) return false;
		const labels = [...new Set(dirty.map(copy => editorInputLabel({ resource: copy.resource, label: copy.backupLabel })))];
		const decision = await this.fileDialogService.showSaveConfirm(labels, dirty.some(copy => copy.hasExternalChange)
			? 'The file has also changed on disk. Saving may require resolving a conflict.' : undefined);
		if (decision === ConfirmResult.CANCEL) return false;
		const controller = new AbortController();
		if (decision === ConfirmResult.DONT_SAVE) {
			for (const copy of dirty) await copy.revert(controller.signal);
			return dirty.every(copy => !copy.isDirty);
		}
		if (input.resource.scheme === 'untitled' && pane.saveDraft) {
			const saved = await pane.saveDraft();
			if (!saved) return false;
			// Saving can replace the draft tab; finish the close against that saved resource.
			return group ? group.closeEditor(saved) : true;
		}
		if (group && input.resource.scheme === 'untitled') return !!await this.saveEditor(group, input, pane);
		for (const copy of dirty) await copy.save(controller.signal);
		if (group && !group.inputs.some(candidate => this.isSameEditor(candidate, input))) return true;
		return dirty.every(copy => !copy.isDirty);
	}

	private async saveEditor(group: IEditorGroupView, input: IResourceEditorInput, pane: IEditorPane): Promise<IResourceEditorInput | undefined> {
		if (!this.saveAsResource) throw new Error('Editor Save As is unavailable in this host');
		if (!pane.saveAs) throw new Error('The active editor cannot save this document');
		const target = await this.saveAsResource(editorInputLabel(input));
		if (!target || this.isDisposed || !group.inputs.includes(input)) return undefined;
		await pane.saveAs(target);
		if (this.isDisposed || !group.inputs.includes(input) || getEditorWorkingCopies(pane).some(copy => copy.isDirty)) return undefined;
		const replacement: IResourceEditorInput = {
			resource: target,
			label: editorInputLabel({ resource: target }),
		};
		await this.replaceEditorResource!(group, input, replacement);
		return replacement;
	}

	protected getGroupViewOptions(): IEditorGroupViewOptions {
		return {};
	}

	private createGroup(id?: EditorGroupId): EditorGroupHost {
		let group: EditorGroupView;
		group = this.instantiationService.createInstance(EditorGroupView, this.contentDomNode, {
			...this.groupOptions,
			...this.getGroupViewOptions(),
			...(id !== undefined ? { id } : {}),
			onDidActivate: () => {
				this.setActiveGroup(group);
			},
			onDidFinishOpenEditor: () => queueMicrotask(() => this.removeEmptyGroup(group)),
			dragAndDrop: {
				start: (source, input) => this.tabDragAndDrop.start(source, input),
				isDragging: () => this.tabDragAndDrop.isDragging(),
				drop: (target, targetInput, position, splitDirection) => this.tabDragAndDrop.drop(target, targetInput, position, splitDirection),
				end: () => this.tabDragAndDrop.end(),
			},
		} satisfies EditorGroupOptions);
		const listeners = new DisposableStore();
		listeners.add(group.onDidChangeEditors(event => {
			this.handleEditorGroupChange(event);
			this.editorChangeEmitter.fire(Object.freeze({ kind: 'groupChanged', groupId: group.id, event }));
		}));
		listeners.add(group.onDidChange(() => this.layoutEmitter.fire(this.dimension)));
		const host = new EditorGroupHost(group, listeners);
		if (this.groupHosts.has(group.id)) {
			host.dispose();
			throw new Error(`Duplicate editor group ID: ${group.id}`);
		}
		this.groupHosts.set(group.id, host);
		return host;
	}

	private findSideGroup(source: EditorGroupView): EditorGroupHost | undefined {
		// Locked and hidden hosts may retain product pages; implicit side opens belong to document groups.
		return this._groups.slice(this.groupIndex(source) + 1).find(host =>
			!host.group.isLocked && this.isGroupVisible(host.group.id));
	}

	private resolveSideGroup(source: EditorGroupView): { readonly host: EditorGroupHost; readonly created: boolean; } {
		const existing = this.findSideGroup(source);
		if (existing) return { host: existing, created: false };
		const direction = this.groupOptions.configurationService?.getValue<string>(EditorOpenSideBySideDirectionConfiguration) === 'down' ? Direction.Down : Direction.Right;
		return { host: this.insertGroup(source, direction), created: true };
	}

	protected insertGroup(source: IEditorGroupView, direction: Direction, id?: EditorGroupId): EditorGroupHost {
		this.restoreMaximizedGroup();
		const sourceIndex = this.groupIndex(source);
		const sourceHost = this._groups[sourceIndex]!;
		const created = this.createGroup(id);
		const targetIndex = sourceIndex + 1;
		this._groups.splice(targetIndex, 0, created);
		this.preserveFocus(() => this.editorGrid.addView(created.view, Sizing.Split, sourceHost.view, direction));
		this.layoutEditorContent();
		this.notifyConstraintsChanged();
		this.editorChangeEmitter.fire(Object.freeze({ kind: 'groupAdded', group: created.group.getEditorState() }));
		return created;
	}

	private removeGroupHost(host: EditorGroupHost): void {
		this.restoreMaximizedGroup();
		const index = this._groups.indexOf(host);
		if (index < 0) return;
		if (this._groups.length === 1) throw new Error('EditorPart cannot remove its last group');
		this.preserveFocus(() => this.editorGrid.removeView(host.view));
		this._groups.splice(index, 1);
		this.layoutEditorContent();
		this.notifyConstraintsChanged();
		if (this._activeGroup === host.group) {
			const recent = this.editorsMru.find(editor => editor.groupId !== host.group.id);
			this.setActiveGroup((this._groups.find(candidate => candidate.group.id === recent?.groupId) ?? this._groups[index] ?? this._groups[index - 1])!.group);
		}
		this.editorChangeEmitter.fire(Object.freeze({ kind: 'groupRemoved', groupId: host.group.id }));
		this.groupHosts.deleteAndDispose(host.group.id);
	}

	private groupIndex(group: IEditorGroupView): number {
		const index = this._groups.findIndex((host) => host.group === group);
		if (index < 0) throw new Error('EditorGroupView is not owned by EditorPart');
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
		if (event.splitDirection !== undefined) {
			if (this.groupOptions.editorLimit === 1 && this.groupHosts.get(event.source.id)?.group === event.source) {
				// A single-content tab represents its whole group. Move that group
				// to retain its pane and identity instead of leaving an empty source.
				const directions = { [Direction.Left]: GroupDirection.LEFT, [Direction.Right]: GroupDirection.RIGHT, [Direction.Up]: GroupDirection.UP, [Direction.Down]: GroupDirection.DOWN };
				this.moveGroup(event.source, event.target, directions[event.splitDirection]);
				this.setActiveGroup(event.source);
				event.source.focus();
				return;
			}
			const created = this.insertGroup(event.target, event.splitDirection);
			void event.source.moveEditorTo(event.input, created.group, 0)
				.then(() => {
					this.setActiveGroup(created.group);
					created.group.focus();
				})
				.catch(error => {
					if (this._groups.includes(created)) this.removeGroupHost(created);
					console.error('Failed to split Editor tab', error);
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
				console.error('Failed to move Editor tab', error);
			});
	}

	saveWorkingSet(id: string, excludedGroups: readonly EditorGroupId[] = []): EditorWorkingSet {
		if (!id.trim()) throw new TypeError('Editor working set requires a non-empty ID');
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
					const pane = group.getEditorPane(input)!;
					return Object.freeze({
						input: this.inputSerializers.serialize(input),
						...(pane instanceof ErrorPlaceholderEditor ? {} : { paneId: pane.id }),
						preview: group.isPreview(input),
						sticky: group.isSticky(input),
						...(viewState ? { viewState } : {}),
					});
				})),
				activeEditorIndex: group.activeInput ? group.inputs.indexOf(group.activeInput) : -1,
				size: totalArea > 0 ? areas[index]! / totalArea : 1 / this._groups.length,
			}))),
			layout: this.maximizedGroup?.layout ?? this.serializeLayout(),
		});
		if (excludedGroups.length === 0) return state;
		const groups = state.groups.filter(group => !excludedGroups.includes(group.id!));
		if (groups.length === 0) throw new Error('An editor working set must include a group');
		const active = state.groups[state.activeGroupIndex]!;
		return { ...state, groups, activeGroupIndex: Math.max(0, groups.indexOf(active)), layout: filterWorkingSetLayout(state.layout!, new Set(groups.map(group => group.id!)))! };
	}

	async applyWorkingSet(workingSet: EditorWorkingSetTarget, options: ApplyEditorWorkingSetOptions = {}): Promise<void> {
		const target = workingSet === 'empty' ? emptyWorkingSet() : validateWorkingSet(workingSet, Math.max(...this._groups.map(host => host.group.id)));
		this.restoreMaximizedGroup();
		const restoredGroups = target.groups.map(group => {
			const restored = group.editors.flatMap((editor, index) => {
				try { return [{ editor, index, input: this.inputSerializers.deserialize(editor.input) }]; }
				catch (error) {
					if (error instanceof UnknownEditorInputSerializerError) { return []; }
					throw error;
				}
			});
			return {
				...group,
				editors: restored.map(entry => entry.editor),
				inputs: restored.map(entry => entry.input),
				activeEditorIndex: restored.length === 0 ? -1 : Math.max(0, restored.findIndex(entry => entry.index === group.activeEditorIndex)),
			};
		});
		const savedActiveGroup = restoredGroups[target.activeGroupIndex]!;
		const groups = options.excludeEmptyGroups ? restoredGroups.filter(group => group.inputs.length > 0) : restoredGroups;
		if (groups.length === 0) {
			groups.push(savedActiveGroup);
		}
		const activeGroupIndex = Math.max(0, groups.indexOf(savedActiveGroup));
		const layout = target.layout && groups.length !== restoredGroups.length
			? filterWorkingSetLayout(target.layout, new Set(groups.map(group => group.id!)))
			: target.layout;
		const hadEditorFocus = this.domNode.contains(this.domNode.ownerDocument.activeElement);
		if (!await this.closeActiveModalEditor()) throw new CancellationError('Applying the editor working set was cancelled');
		const retained = (options.preserveGroups ?? []).map(id => this.groupHosts.get(id)!);
		const retainedLayout = retained.length ? filterWorkingSetLayout(this.editorGrid.serialize() as EditorWorkingSetLayout, new Set(retained.map(host => host.group.id))) : undefined;
		const closing = this._groups.filter(host => !retained.includes(host));
		const closingEditors = closing.flatMap(({ group }) => group.inputs.map(editor => ({ editor, groupId: group.id })));
		for (const { group } of closing) {
			for (const input of group.inputs) {
				if (!await group.confirmCloseEditor(input, closing.map(host => host.group.id), closingEditors)) throw new CancellationError('Applying the editor working set was cancelled');
			}
		}
		for (const { group } of closing) {
			for (const input of [...group.inputs]) await group.closeEditor(input, { reason: 'reset', skipConfirmation: true });
		}
		this.rebuildGroups(groups, layout, activeGroupIndex, retained, retainedLayout);
		for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
			const state = groups[groupIndex]!;
			const group = this._groups[retained.length + groupIndex]!.group;
			for (let inputIndex = 0; inputIndex < state.inputs.length; inputIndex += 1) {
				const input = state.inputs[inputIndex]!;
				await group.openEditor(input, {
					index: inputIndex,
					pinned: !state.editors[inputIndex]!.preview,
					preferredEditorId: state.editors[inputIndex]!.paneId,
					preserveFocus: true,
				});
				group.restoreEditorViewState(input, state.editors[inputIndex]!.viewState);
				if (state.editors[inputIndex]!.sticky) group.stickEditor(input);
			}
			const activeInput = state.inputs[state.activeEditorIndex];
			if (activeInput) group.activateEditor(activeInput);
			group.setLocked(state.locked === true);
		}
		const activeGroup = this._groups[retained.length + activeGroupIndex]!;
		this.setActiveGroup(activeGroup.group);
		this.layoutEditorContent();
		if (!options.preserveFocus && hadEditorFocus) this._activeGroup.focus();
	}

	private rebuildGroups(
		groups: readonly { readonly id?: EditorGroupId; readonly size: number; }[],
		layout: EditorWorkingSetLayout | undefined,
		activeGroupIndex: number,
		retained: readonly EditorGroupHost[] = [],
		retainedLayout?: EditorWorkingSetLayout,
	): void {
		const previous = this._groups.splice(0);
		this.gridSlot.clear();
		for (const host of previous) {
			if (retained.includes(host)) continue;
			this.editorChangeEmitter.fire(Object.freeze({ kind: 'groupRemoved', groupId: host.group.id }));
			this.groupHosts.deleteAndDispose(host.group.id);
		}
		const hosts = groups.map(group => {
			const id = group.id !== undefined && !this.groupHosts.has(group.id) ? group.id : undefined;
			return this.createGroup(id);
		});
		// A retained product group can already own an ID from a previous process's document snapshot.
		if (layout) {
			const mapping = new Map(groups.map((group, index) => [group.id!, hosts[index]!.group.id]));
			layout = remapWorkingSetLayout(layout, mapping);
		}
		this._groups.push(...retained, ...hosts);
		const hostById = new Map(this._groups.map(host => [host.group.id, host]));
		const documentLayout = layout ?? { type: 'branch' as const, orientation: Orientation.HORIZONTAL as const, priority: LayoutPriority.Normal as const, size: this.dimension.width, children: hosts.map((host, index) => ({ type: 'leaf' as const, data: { groupId: host.group.id }, size: groups[index]!.size * this.dimension.width, visible: true, priority: LayoutPriority.Normal as const })) };
		const combinedLayout = retainedLayout ? { type: 'branch' as const, orientation: Orientation.HORIZONTAL as const, priority: LayoutPriority.Normal as const, size: this.dimension.width, children: [retainedLayout, documentLayout].flatMap(child => child.type === 'branch' && child.orientation === Orientation.HORIZONTAL ? child.children : [child]) } : layout;
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
		this.setActiveGroup(hosts[activeGroupIndex]!.group);
		this.layoutEditorContent();
		this.notifyConstraintsChanged();
		for (const host of hosts) {
			this.editorChangeEmitter.fire(Object.freeze({ kind: 'groupAdded', group: host.group.getEditorState() }));
		}
	}

	private handleEditorGroupChange(event: EditorGroupChangeEvent): void {
		if (event.kind === 'editorOpened' && this._groups.length > 1) {
			const group = this._groups.find(host => host.group.id === event.editor.groupId)?.group;
			const autoLock = this.groupOptions.configurationService?.getValue<AutoLockGroups>(AutoLockGroupsConfiguration);
			if (group?.inputs.length === 1 && autoLock?.[event.editor.paneId]) group.setLocked(true);
		}
		if (event.kind === 'editorClosed' && (event.reason === 'close' || event.reason === 'move')) {
			const group = this._groups.find(host => host.group.id === event.editor.groupId)?.group;
			if (group && group.inputs.length === 0) {
				// Finish the group's close events and rendering before disposing their owner.
				queueMicrotask(() => this.removeEmptyGroup(group));
			}
		}
	}

	private removeEmptyGroup(group: EditorGroupView): void {
		// Sessions owns its fixed single-editor grid; only ordinary tab groups collapse.
		if (this.isDisposed || this.groupOptions.editorLimit === 1 || this._groups.length === 1 || group.inputs.length > 0 || group.isOpening || this.openingIdentities.has(group.id) || this.groupOptions.configurationService?.getValue<boolean>(EditorCloseEmptyGroupsConfiguration) === false) return;
		const host = this._groups.find(candidate => candidate.group === group);
		if (!host) return;
		const focused = this.domNode.ownerDocument.activeElement;
		const restoreFocus = this._activeGroup === group && (focused === this.domNode.ownerDocument.body || group.domNode.contains(focused));
		this.removeGroupHost(host);
		if (restoreFocus) this._activeGroup.focus();
	}

	private setActiveGroup(group: EditorGroupView): void {
		if (this.maximizedGroup && group.id !== this.maximizedGroup.id) this.restoreMaximizedGroup();
		if (this._activeGroup === group) return;
		this._activeGroup = group;
		this.editorChangeEmitter.fire(Object.freeze({ kind: 'activeGroupChanged', groupId: group.id }));
	}

	private activeEditorIdentifier(): EditorIdentifier | undefined {
		const editor = this._activeGroup.editors.find(candidate => candidate.isActive);
		if (!editor) return undefined;
		return Object.freeze({ groupId: editor.groupId, instanceId: editor.instanceId, paneId: editor.paneId, input: editor.input });
	}
}

/** Pruning a working set preserves the exact geometry of the selected group subtree. */
function filterWorkingSetLayout(layout: EditorWorkingSetLayout, groups: ReadonlySet<EditorGroupId>): EditorWorkingSetLayout | undefined {
	if (layout.type === 'leaf') return groups.has(layout.data.groupId) ? layout : undefined;
	const children = layout.children.map(child => filterWorkingSetLayout(child, groups)).filter((child): child is EditorWorkingSetLayout => child !== undefined).flatMap(child => child.type === 'branch' && child.orientation === layout.orientation ? child.children : [child]);
	if (children.length === 0) return undefined;
	if (children.length === 1) return { ...children[0]!, size: layout.size };
	return { ...layout, children };
}

function remapWorkingSetLayout(layout: EditorWorkingSetLayout, groups: ReadonlyMap<EditorGroupId, EditorGroupId>): EditorWorkingSetLayout {
	if (layout.type === 'leaf') return { ...layout, data: { groupId: groups.get(layout.data.groupId)! } };
	return { ...layout, children: layout.children.map(child => remapWorkingSetLayout(child, groups)) };
}

function emptyWorkingSet(): EditorWorkingSet {
	return Object.freeze({
		id: 'empty',
		activeGroupIndex: 0,
		groups: Object.freeze([Object.freeze({ editors: Object.freeze([]), activeEditorIndex: -1, size: 1 })]),
	});
}

function validateWorkingSet(value: EditorWorkingSet, lastGroupId: number): EditorWorkingSet {
	if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id.trim()) {
		throw new TypeError('Invalid editor working set');
	}
	if (!isNonEmptyArray(value.groups) || !Number.isInteger(value.activeGroupIndex) || value.activeGroupIndex < 0 || value.activeGroupIndex >= value.groups.length) {
		throw new TypeError('Invalid editor working set groups');
	}
	value = migrateWorkingSetGroupIds(value, lastGroupId);
	let sizeTotal = 0;
	const groupIds = new Set<EditorGroupId>();
	for (const group of value.groups) {
		if (!group || typeof group !== 'object' || !Array.isArray(group.editors) || !Number.isInteger(group.activeEditorIndex) || group.activeEditorIndex < -1 || group.activeEditorIndex >= group.editors.length || (group.locked !== undefined && typeof group.locked !== 'boolean') || !Number.isFinite(group.size) || group.size < 0) {
			throw new TypeError('Invalid editor group working set');
		}
		if (group.id !== undefined) {
			if (!isEditorGroupId(group.id) || groupIds.has(group.id)) throw new TypeError('Invalid editor working set group ID');
			groupIds.add(group.id);
		}
		for (const editor of group.editors) {
			if (!editor || typeof editor !== 'object' || typeof editor.preview !== 'boolean' || (editor.sticky !== undefined && typeof editor.sticky !== 'boolean') || (editor.sticky === true && editor.preview) || !isSerializedEditorInput(editor.input)) {
				throw new TypeError('Invalid editor working set entry');
			}
			if (editor.paneId !== undefined && (typeof editor.paneId !== 'string' || !editor.paneId.trim() || editor.paneId.length > 256)) {
				throw new TypeError('Invalid editor working set pane ID');
			}
			if (editor.viewState !== undefined) {
				if (!editor.viewState || typeof editor.viewState !== 'object' || typeof editor.viewState.typeId !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(editor.viewState.typeId) || !('value' in editor.viewState)) {
					throw new TypeError('Invalid editor working set view state');
				}
				validateJsonValue(editor.viewState.value, { path: 'editor working set view state' });
			}
		}
		sizeTotal += group.size;
	}
	if (sizeTotal <= 0) throw new TypeError('Invalid editor working set layout');
	if (value.layout !== undefined) {
		if (groupIds.size !== value.groups.length) throw new TypeError('Editor Grid layout requires an ID for every group');
		parseEditorWorkingSetLayout(value.layout, groupIds);
	}
	return value;
}

/** Old snapshots name groups with strings. Resolve those names once before restoring live groups. */
function migrateWorkingSetGroupIds(value: EditorWorkingSet, lastGroupId: number): EditorWorkingSet {
	if (!value.groups.some(group => group && typeof group.id === 'string')) return value;
	const ids = new Map<string, number>();
	let nextId = Math.max(lastGroupId, ...value.groups.map(group => isEditorGroupId(group?.id) ? group.id : 0));
	const groups = value.groups.map(group => {
		const id: unknown = group?.id;
		if (typeof id !== 'string') return group;
		if (!id.length || id.length > 128 || ids.has(id) || !Number.isSafeInteger(nextId + 1)) throw new TypeError('Invalid legacy editor group ID');
		ids.set(id, ++nextId);
		return { ...group, id: nextId };
	});
	const migrateLayout = (node: EditorWorkingSetLayout, depth = 0): EditorWorkingSetLayout => {
		if (!node || typeof node !== 'object' || depth > 64) throw new TypeError('Invalid Editor Grid layout node');
		if (node.type === 'leaf') {
			const id: unknown = node.data?.groupId;
			const groupId = typeof id === 'string' ? ids.get(id) : id;
			if (!isEditorGroupId(groupId)) throw new TypeError('Invalid Editor Grid group reference');
			return { ...node, data: { groupId } };
		}
		if (node.type !== 'branch' || !Array.isArray(node.children)) throw new TypeError('Invalid Editor Grid branch');
		return { ...node, children: node.children.map(child => migrateLayout(child, depth + 1)) };
	};
	return { ...value, groups, ...(value.layout ? { layout: migrateLayout(value.layout) } : {}) };
}

function isEditorGroupId(value: unknown): value is EditorGroupId {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function editorGroupIdFromGridData(value: unknown): EditorGroupId {
	if (!value || typeof value !== 'object' || Array.isArray(value) || !('groupId' in value) || !isEditorGroupId(value.groupId)) {
		throw new TypeError('Invalid Editor Grid group data');
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
		type: 'branch',
		orientation: Orientation.HORIZONTAL,
		size: width,
		children: hosts.map((host, index) => ({
			type: 'leaf',
			view: host.view,
			size: width * groups[index]!.size,
		})),
	};
}

function editorInputLabel(input: Pick<IResourceEditorInput, 'resource' | 'label'>): string {
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
	console.error('Failed to close editor', error);
}
