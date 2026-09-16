import "./media/editorpart.css";
import { isNonEmptyArray } from "../../../../base/common/arrays.js";
import type { IContextMenuProvider } from "../../../../base/browser/contextmenu.js";
import type { URI } from "../../../../base/common/uri.js";
import { Emitter, type Event } from "../../../../base/common/event.js";
import { CancellationError } from "../../../../base/common/errors.js";
import { validateJsonValue } from "../../../../base/common/jsonValue.js";
import { Dimension, type IDimension } from "../../../../base/browser/dom.js";
import { type IPositionedRectangle } from "../../../../base/browser/geometry.js";
import { observeElementSize } from "../../../../base/browser/observer.js";
import { Direction, SerializableGrid, Sizing, type Direction as GridDirection, type GridDescriptor, type ISerializableView as ISerializableGridView } from "../../../../base/browser/ui/grid/grid.js";
import { DisposableMap, Disposable, MutableDisposable, type IDisposable } from "../../../../base/common/lifecycle.js";
import { rot } from "../../../../base/common/numbers.js";
import type { IMenuService } from "../../../../platform/actions/common/menuService.js";
import type { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";
import type { IKeybindingService } from "../../../../platform/keybinding/common/keybinding.js";
import type { IKeybindingsResourceService } from "../../../../platform/keybinding/common/keybindingsResource.js";
import type { IKeyboardLayoutService } from "../../../../platform/keyboardLayout/common/keyboardLayout.js";
import type { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { DialogResult, type IDialogService } from "../../../../platform/dialogs/common/dialogs.js";
import { type ITextFileService } from "../../../services/textfile/common/textFileService.js";
import type { IFileService } from "../../../../platform/files/common/files.js";
import { type ITextMateService } from "../../../services/textMate/common/textMateService.js";
import type { IDiffService } from "../../../services/diff/common/diffService.js";
import type { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import type { IAccessibilityService } from "../../../../platform/accessibility/common/accessibility.js";
import type { IDocumentCollaborationApi } from "../../../../platform/collaboration/common/documentCollaborationApi.js";
import type { IServerEventApi } from "../../../../platform/app-server/common/appServerApi.js";
import { WorkbenchPart } from "../../part.js";
import { EditorGroup, type EditorGroupOptions, type IEditorGroup } from "./editorGroup.js";
import { EditorTabDragAndDropController, type EditorTabDropEvent } from "./editorTabDragAndDrop.js";
import type { EditorInput, EditorOpenOptions, EditorOpenTarget } from "../../../services/editor/common/editorService.js";
import type { TextResourceLanguageResolver } from "../../../../platform/language/common/textResourceLanguage.js";
import type { IWorkingCopyService } from "../../../services/workingCopy/common/workingCopyService.js";
import type { IEditorPane } from "./editorPane.js";
import { EditorPaneRegistry, EditorPanes } from "./editorRegistry.js";
import type { IBulkEditService } from "../../../../editor/browser/services/bulkEditService.js";
import type { ILanguageDiagnosticsService } from "../../../../editor/common/services/languageDiagnosticsService.js";
import type { EditorWelcomeOptions, IEditorWelcomeProject } from "../../../contrib/files/browser/editorWelcome.js";
import { EditorInputSerializers, type EditorInputSerializerRegistry, isSerializedEditorInput } from "../../../services/editor/common/editorInputSerializer.js";
import type { ApplyEditorWorkingSetOptions, EditorWorkingSet, EditorWorkingSetLayout, EditorWorkingSetTarget } from "../../../services/editor/common/editorWorkingSet.js";
import { ModalEditorPart } from "./modalEditorPart.js";
import type { EditorGroupChangeEvent, EditorGroupId, EditorIdentifier, EditorInstanceId, EditorPartChangeEvent, EditorPartState, IEditorStateSource } from "../../../services/editor/common/editorState.js";
import { editorInputKey } from "./editorTabsControl.js";
import type { IEditorPaneDescriptor } from "./editorPane.js";

export { EditorOpenSupersededError } from "./editorGroup.js";

/** Editor-region operations available to Workbench contributions. */
export interface IEditorPart extends IEditorStateSource, IDisposable {
	readonly domNode: HTMLElement;
	readonly onDidChangeEditors: Event<EditorPartChangeEvent>;
	readonly groups: readonly IEditorGroup[];
	readonly activeGroup: IEditorGroup;
	readonly activeInput: EditorInput | undefined;
	readonly activePane: IEditorPane | undefined;
	readonly isModalEditorVisible: boolean;
	readonly editorsMru: readonly EditorIdentifier[];
	readonly recentlyClosedEditors: readonly RecentlyClosedEditor[];

	openEditor(input: EditorInput, options?: EditorOpenOptions, target?: EditorOpenTarget): Promise<IEditorPane>;
	activateEditor(input: EditorInput): IEditorPane;
	activateEditorIdentifier(identifier: EditorIdentifier): IEditorPane | undefined;
	activateEditorMru(offset: number): IEditorPane | undefined;
	closeEditor(input: EditorInput): Promise<boolean>;
	confirmCloseAllEditors(): Promise<boolean>;
	closeAllEditors(options?: EditorCloseAllOptions): Promise<boolean>;
	moveActiveEditorTo(target: IEditorPart): Promise<boolean>;
	setWelcomeRecentProjects(projects: readonly IEditorWelcomeProject[]): void;
	setWelcomeVisible(visible: boolean): void;
	saveActiveEditor(): Promise<void>;
	setContent(content: Element): Promise<void>;
	splitActiveGroup(direction: GridDirection): Promise<void>;
	splitActiveGroupHorizontal(): Promise<void>;
	splitActiveGroupVertical(): Promise<void>;
	getEditorPaneChoices(input?: EditorInput): readonly IEditorPaneDescriptor[];
	reopenActiveEditorWith(preferredEditorId: string): Promise<IEditorPane | undefined>;
	reopenClosedEditor(): Promise<boolean>;
	saveWorkingSet(id: string): EditorWorkingSet;
	applyWorkingSet(workingSet: EditorWorkingSetTarget, options?: ApplyEditorWorkingSetOptions): Promise<void>;
	layout(dimension: IDimension): void;
	focus(): void;
}

export interface RecentlyClosedEditor {
	readonly input: EditorInput;
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
	readonly instantiationService?: IInstantiationService;
	readonly accessibilityService?: IAccessibilityService;
	readonly languageDiagnosticsService?: ILanguageDiagnosticsService;
	readonly documentCollaborationApi?: IDocumentCollaborationApi;
	readonly serverEvents?: IServerEventApi;
	readonly workingCopyService?: IWorkingCopyService;
	readonly dialogService?: IDialogService;
	readonly bulkEditService?: IBulkEditService;
	readonly registry?: EditorPaneRegistry;
	readonly titleActions?: {
		readonly menuService: IMenuService;
		readonly contextMenuProvider: IContextMenuProvider;
	};
	readonly welcome?: EditorWelcomeOptions;
	readonly welcomeVisible?: boolean;
	readonly saveAsResource?: (defaultName: string) => Promise<URI | undefined>;
	readonly inputSerializers?: EditorInputSerializerRegistry;
}

/** Owns EditorGroup layout and delegates editor behavior to the active group. */
export class EditorPart extends WorkbenchPart implements IEditorPart {
	private readonly editorChangeEmitter = this._register(new Emitter<EditorPartChangeEvent>());
	readonly onDidChangeEditors: Event<EditorPartChangeEvent> = this.editorChangeEmitter.event;
	private readonly gridSlot = this._register(new MutableDisposable<SerializableGrid<EditorGroupGridView>>());
	private readonly groupHosts = this._register(new DisposableMap<EditorGroupId, EditorGroupHost>());
	private readonly modalEditor: ModalEditorPart;
	private readonly groupOptions: Omit<EditorGroupOptions, "onDidActivate" | "dragAndDrop">;
	private readonly _groups: EditorGroupHost[] = [];
	private _activeGroup: EditorGroup;
	private readonly tabDragAndDrop: EditorTabDragAndDropController;
	private welcomeRecentProjects: readonly IEditorWelcomeProject[];
	private dimension = Dimension.Zero;
	private readonly saveAsResource: ((defaultName: string) => Promise<URI | undefined>) | undefined;
	private readonly inputSerializers: EditorInputSerializerRegistry;
	private readonly dialogService: IDialogService | undefined;
	private readonly mruEditorIds: EditorInstanceId[] = [];
	private readonly recentlyClosed: RecentlyClosedEditor[] = [];

	override get minimumWidth(): number { return 120; }
	override get minimumHeight(): number { return 119; }

	constructor(
		container: HTMLElement,
		options: IEditorPartOptions = {},
	) {
		super(container, "editor");
		const ownerDocument = container.ownerDocument;
		this.titleDomNode.remove();
		this.domNode.setAttribute("aria-label", "Editor");
		this.groupOptions = {
			registry: options.registry ?? EditorPanes,
			configurationService: options.configurationService,
			contextKeyService: options.contextKeyService,
			keybindingService: options.keybindingService,
			keybindingsResourceService: options.keybindingsResourceService,
			keyboardLayoutService: options.keyboardLayoutService,
			fileService: options.fileService,
			textFileService: options.textFileService,
			textMateService: options.textMateService,
			languageResolver: options.languageResolver,
			diffService: options.diffService,
			instantiationService: options.instantiationService,
			accessibilityService: options.accessibilityService,
			languageDiagnosticsService: options.languageDiagnosticsService,
			documentCollaborationApi: options.documentCollaborationApi,
			serverEvents: options.serverEvents,
			workingCopyService: options.workingCopyService,
			onWillCloseEditor: (group, input, pane) => this.confirmEditorClose(group, input, pane),
			onOpenLocation: location => this.openEditor({ resource: location.resource }, { selection: location.selectionRange ?? location.range }).then(() => undefined),
			onApplyWorkspaceEdit: options.bulkEditService ? edit => options.bulkEditService!.apply(edit).then(() => undefined) : undefined,
			titleActions: options.titleActions,
			welcome: options.welcome,
			welcomeVisible: options.welcomeVisible,
			...(options.saveAsResource ? {
				onSave: (group: IEditorGroup, input: EditorInput, pane: IEditorPane) => this.saveEditor(group, input, pane),
			} : {}),
		};
		this.welcomeRecentProjects = options.welcome?.recentProjects ?? [];
		this.saveAsResource = options.saveAsResource;
		this.inputSerializers = options.inputSerializers ?? EditorInputSerializers;
		this.dialogService = options.dialogService;
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
		});
		this.modalEditor = this._register(new ModalEditorPart({
			container,
			registry: this.groupOptions.registry,
			paneCreationOptions: {
				configurationService: options.configurationService,
				contextKeyService: options.contextKeyService,
				keybindingService: options.keybindingService,
				keybindingsResourceService: options.keybindingsResourceService,
				keyboardLayoutService: options.keyboardLayoutService,
				fileService: options.fileService,
				textFileService: options.textFileService,
				textMateService: options.textMateService,
				languageResolver: options.languageResolver,
				diffService: options.diffService,
				instantiationService: options.instantiationService,
				accessibilityService: options.accessibilityService,
				languageDiagnosticsService: options.languageDiagnosticsService,
				documentCollaborationApi: options.documentCollaborationApi,
				serverEvents: options.serverEvents,
				workingCopyService: options.workingCopyService,
				onOpenLocation: location => this.openEditor({ resource: location.resource }, { selection: location.selectionRange ?? location.range }).then(() => undefined),
				onApplyWorkspaceEdit: options.bulkEditService ? edit => options.bulkEditService!.apply(edit).then(() => undefined) : undefined,
				...(options.titleActions ? {
					actionServices: {
						menuService: options.titleActions.menuService,
						contextMenuProvider: options.titleActions.contextMenuProvider,
						contextKeyService: options.contextKeyService,
					},
				} : {}),
			},
		}));
		this._register(this.modalEditor.onDidRequestClose(input => {
			void this.closeEditor(input).catch(reportEditorCloseError);
		}));
		this._register(observeElementSize(this.contentDomNode, size => this.layout(size)));
	}

	get groups(): readonly IEditorGroup[] {
		return this._groups.map(({ group }) => group);
	}

	get activeGroup(): IEditorGroup {
		return this._activeGroup;
	}

	private get editorGrid(): SerializableGrid<EditorGroupGridView> {
		const grid = this.gridSlot.value;
		if (!grid) throw new Error("Editor Grid is unavailable");
		return grid;
	}

	get activeInput(): EditorInput | undefined {
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
		const byId = new Map(this.getEditorState().groups.flatMap(group => group.editors).map(editor => [editor.instanceId, editor]));
		return Object.freeze(this.mruEditorIds.flatMap(instanceId => {
			const editor = byId.get(instanceId);
			return editor ? [Object.freeze({ groupId: editor.groupId, instanceId: editor.instanceId, paneId: editor.paneId, input: editor.input })] : [];
		}));
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

	async openEditor(input: EditorInput, options: EditorOpenOptions = {}, target: EditorOpenTarget = "activeGroup"): Promise<IEditorPane> {
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
		if (target === "activeGroup") return this._activeGroup.openEditor(input, options);
		const source = this._activeGroup;
		const { host, created } = this.resolveSideGroup(source);
		try {
			const pane = await host.group.openEditor(input, options);
			if (!options.preserveFocus) {
				this.setActiveGroup(host.group);
			}
			return pane;
		} catch (error) {
			if (created) this.removeGroup(host);
			this.setActiveGroup(source);
			throw error;
		}
	}

	activateEditor(input: EditorInput): IEditorPane {
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

	async closeEditor(input: EditorInput): Promise<boolean> {
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
		if (modalInput && modalPane && !await this.confirmEditorClose(undefined, modalInput, modalPane)) return false;
		const inputsByGroup = this._groups.map(({ group }) => ({ group, inputs: [...group.inputs] }));
		for (const { group, inputs } of inputsByGroup) {
			for (const input of inputs) {
				if (!await group.confirmCloseEditor(input)) return false;
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

	setWelcomeRecentProjects(projects: readonly IEditorWelcomeProject[]): void {
		this.welcomeRecentProjects = projects;
		for (const { group } of this._groups) group.setWelcomeRecentProjects(projects);
	}

	setWelcomeVisible(visible: boolean): void {
		for (const { group } of this._groups) group.setWelcomeVisible(visible);
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
		const source = this._activeGroup;
		const created = this.insertGroup(source, direction);
		this.setActiveGroup(created.group);
		try {
			if (source.activeInput) {
				await created.group.openEditor(source.activeInput);
			}
			created.group.focus();
		} catch (error) {
			this.removeGroup(created);
			this.setActiveGroup(source);
			throw error;
		}
	}

	getEditorPaneChoices(input: EditorInput | undefined = this.activeInput): readonly IEditorPaneDescriptor[] {
		return input ? this.groupOptions.registry.getEditors(input) : [];
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
			const choices = this.groupOptions.registry.getEditors(closed.input);
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

	override layout(dimension: IDimension): void {
		this.dimension = new Dimension(dimension.width, dimension.height);
		this.editorGrid.layout(
			this.dimension.width,
			this.dimension.height,
		);
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

	private async confirmEditorClose(group: IEditorGroup | undefined, input: EditorInput, pane: IEditorPane): Promise<boolean> {
		const workingCopy = pane.workingCopy;
		if (!workingCopy?.isDirty) return true;
		if (!this.dialogService) return false;
		const label = editorInputLabel(input);
		const result = await this.dialogService.prompt({
			title: "Save Changes",
			message: `Do you want to save the changes you made to ${label}?`,
			...(workingCopy.hasExternalChange ? { detail: "The file has also changed on disk. Saving may require resolving a conflict." } : {}),
			primaryButton: "Save",
			secondaryButton: "Don't Save",
			cancelButton: "Cancel",
		});
		if (result === DialogResult.Cancel) return false;
		const controller = new AbortController();
		if (result === DialogResult.Secondary) {
			await workingCopy.revert(controller.signal);
			return !workingCopy.isDirty;
		}
		await workingCopy.save(controller.signal);
		if (group && !group.inputs.some(candidate => editorInputKey(candidate) === editorInputKey(input))) return true;
		return !workingCopy.isDirty;
	}

	private async saveEditor(group: IEditorGroup, input: EditorInput, pane: IEditorPane): Promise<boolean> {
		if (input.resource.scheme !== "untitled") throw new Error("Save As is only available for untitled editors");
		if (!this.saveAsResource) throw new Error("Editor Save As is unavailable in this host");
		if (!pane.saveAs) throw new Error("The active editor cannot save this document");
		const target = await this.saveAsResource(editorInputLabel(input));
		if (!target) return false;
		await pane.saveAs(target);
		await group.replaceEditor(input, {
			resource: target,
			label: editorInputLabel({ resource: target }),
		});
		return true;
	}

	private createGroup(id?: EditorGroupId): EditorGroupHost {
		let group: EditorGroup;
		group = new EditorGroup(this.contentDomNode, {
			...this.groupOptions,
			...(id ? { id } : {}),
			...(this.groupOptions.welcome ? {
				welcome: { ...this.groupOptions.welcome, recentProjects: this.welcomeRecentProjects },
			} : {}),
			onDidActivate: () => {
				this.setActiveGroup(group);
			},
			dragAndDrop: {
				start: (source, input) => this.tabDragAndDrop.start(source, input),
				isDragging: () => this.tabDragAndDrop.isDragging(),
				drop: (target, targetInput, position, splitDirection) => this.tabDragAndDrop.drop(target, targetInput, position, splitDirection),
				end: () => this.tabDragAndDrop.end(),
			},
		});
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

	private resolveSideGroup(source: EditorGroup): { readonly host: EditorGroupHost; readonly created: boolean } {
		const sourceIndex = this.groupIndex(source);
		const existing = this._groups[sourceIndex + 1];
		if (existing) return { host: existing, created: false };
		return { host: this.insertGroup(source, Direction.Right), created: true };
	}

	private insertGroup(source: EditorGroup, direction: GridDirection): EditorGroupHost {
		const sourceIndex = this.groupIndex(source);
		const sourceHost = this._groups[sourceIndex]!;
		const created = this.createGroup();
		const targetIndex = sourceIndex + 1;
		this._groups.splice(targetIndex, 0, created);
		this.editorGrid.addView(created.view, Sizing.Split, sourceHost.view, direction);
		this.editorChangeEmitter.fire(Object.freeze({ kind: "groupAdded", group: created.group.getEditorState() }));
		return created;
	}

	private removeGroup(host: EditorGroupHost): void {
		const index = this._groups.indexOf(host);
		if (index < 0) return;
		if (this._groups.length === 1) throw new Error("EditorPart cannot remove its last group");
		this.editorGrid.removeView(host.view);
		this._groups.splice(index, 1);
		if (this._activeGroup === host.group) {
			this.setActiveGroup((this._groups[index] ?? this._groups[index - 1])!.group);
		}
		this.editorChangeEmitter.fire(Object.freeze({ kind: "groupRemoved", groupId: host.group.id }));
		this.groupHosts.deleteAndDispose(host.group.id);
	}

	private groupIndex(group: EditorGroup): number {
		const index = this._groups.findIndex((host) => host.group === group);
		if (index < 0) throw new Error("EditorGroup is not owned by EditorPart");
		return index;
	}

	private dropEditor(event: EditorTabDropEvent): void {
		if (event.splitDirection) {
			const created = this.insertGroup(event.target, event.splitDirection);
			void event.source.moveEditorTo(event.input, created.group, 0)
				.then(() => {
					const sourceHost = this._groups.find(host => host.group === event.source);
					if (sourceHost && sourceHost.group.inputs.length === 0 && this._groups.length > 1) this.removeGroup(sourceHost);
					this.setActiveGroup(created.group);
					created.group.focus();
				})
				.catch(error => {
					if (this._groups.includes(created)) this.removeGroup(created);
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

	saveWorkingSet(id: string): EditorWorkingSet {
		if (!id.trim()) throw new TypeError("Editor working set requires a non-empty ID");
		const areas = this._groups.map(({ view }) => {
			const size = this.editorGrid.getViewSize(view);
			return size.width * size.height;
		});
		const totalArea = areas.reduce((sum, area) => sum + area, 0);
		return Object.freeze({
			id,
			activeGroupIndex: this._groups.findIndex(({ group }) => group === this._activeGroup),
			groups: Object.freeze(this._groups.map(({ group }, index) => Object.freeze({
				id: group.id,
				editors: Object.freeze(group.inputs.map(input => {
					const viewState = group.saveEditorViewState(input);
					return Object.freeze({
						input: this.inputSerializers.serialize(input),
						preview: group.isPreview(input),
						...(viewState ? { viewState } : {}),
					});
				})),
				activeEditorIndex: group.activeInput ? group.inputs.indexOf(group.activeInput) : -1,
				size: totalArea > 0 ? areas[index]! / totalArea : 1 / this._groups.length,
			}))),
			layout: this.editorGrid.serialize() as EditorWorkingSetLayout,
		});
	}

	async applyWorkingSet(workingSet: EditorWorkingSetTarget, options: ApplyEditorWorkingSetOptions = {}): Promise<void> {
		const target = workingSet === "empty" ? emptyWorkingSet() : validateWorkingSet(workingSet);
		const groups = target.groups.map(group => ({
			...group,
			inputs: group.editors.map(editor => this.inputSerializers.deserialize(editor.input)),
		}));
		const hadEditorFocus = this.domNode.contains(this.domNode.ownerDocument.activeElement);
		if (!await this.closeAllEditors({ reason: "reset" })) throw new CancellationError("Applying the editor working set was cancelled");
		this.rebuildGroups(groups, target.layout, target.activeGroupIndex);
		for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
			const state = groups[groupIndex]!;
			const group = this._groups[groupIndex]!.group;
			for (let inputIndex = 0; inputIndex < state.inputs.length; inputIndex += 1) {
				const input = state.inputs[inputIndex]!;
				await group.openEditor(input, {
					index: inputIndex,
					pinned: !state.editors[inputIndex]!.preview,
					preserveFocus: true,
				});
				group.restoreEditorViewState(input, state.editors[inputIndex]!.viewState);
			}
			const activeInput = state.inputs[state.activeEditorIndex];
			if (activeInput) group.activateEditor(activeInput);
		}
		const activeGroup = this._groups[target.activeGroupIndex] ?? this._groups[0]!;
		this.setActiveGroup(activeGroup.group);
		this.editorGrid.layout(this.dimension.width, this.dimension.height);
		if (!options.preserveFocus && hadEditorFocus) this._activeGroup.focus();
	}

	private rebuildGroups(
		groups: readonly { readonly id?: string; readonly size: number }[],
		layout: EditorWorkingSetLayout | undefined,
		activeGroupIndex: number,
	): void {
		const previous = this._groups.splice(0);
		this.gridSlot.clear();
		for (const host of previous) {
			this.editorChangeEmitter.fire(Object.freeze({ kind: "groupRemoved", groupId: host.group.id }));
			this.groupHosts.deleteAndDispose(host.group.id);
		}
		const hosts = groups.map(group => this.createGroup(group.id));
		this._groups.push(...hosts);
		const hostById = new Map(hosts.map(host => [host.group.id, host]));
		const grid = layout
			? SerializableGrid.deserialize<EditorGroupGridView>(this.contentDomNode, layout, {
				fromJSON: data => {
					const groupId = editorGroupIdFromGridData(data);
					const host = hostById.get(groupId);
					if (!host) throw new Error(`Editor Grid references unknown group '${groupId}'`);
					return host.view;
				},
			})
			: new SerializableGrid(this.contentDomNode, legacyGridDescriptor(hosts, groups, this.dimension));
		this.gridSlot.value = grid;
		this._activeGroup = hosts[activeGroupIndex]?.group ?? hosts[0]!.group;
		for (const host of hosts) {
			this.editorChangeEmitter.fire(Object.freeze({ kind: "groupAdded", group: host.group.getEditorState() }));
		}
	}

	private handleEditorGroupChange(event: EditorGroupChangeEvent): void {
		if (event.kind === "activeEditorChanged" && event.editor) {
			this.touchEditorMru(event.editor.instanceId);
			return;
		}
		if (event.kind !== "editorClosed") return;
		if (!this._groups.some(({ group }) => group.editors.some(editor => editor.instanceId === event.editor.instanceId))) {
			const index = this.mruEditorIds.indexOf(event.editor.instanceId);
			if (index >= 0) this.mruEditorIds.splice(index, 1);
		}
		if (event.reason === "close") this.addRecentlyClosed(event.editor.input, event.editor.paneId);
	}

	private addRecentlyClosed(input: EditorInput, preferredEditorId: string): void {
		const closed = Object.freeze({ input, preferredEditorId });
		const duplicate = this.recentlyClosed.findIndex(candidate => editorInputKey(candidate.input) === editorInputKey(closed.input) && candidate.preferredEditorId === closed.preferredEditorId);
		if (duplicate >= 0) this.recentlyClosed.splice(duplicate, 1);
		this.recentlyClosed.unshift(closed);
		if (this.recentlyClosed.length > 20) this.recentlyClosed.length = 20;
	}

	private touchEditorMru(instanceId: EditorInstanceId): void {
		const index = this.mruEditorIds.indexOf(instanceId);
		if (index >= 0) this.mruEditorIds.splice(index, 1);
		this.mruEditorIds.unshift(instanceId);
	}

	private setActiveGroup(group: EditorGroup): void {
		if (this._activeGroup === group) return;
		this._activeGroup = group;
		const editor = group.editors.find(candidate => candidate.isActive);
		if (editor) this.touchEditorMru(editor.instanceId);
		this.editorChangeEmitter.fire(Object.freeze({ kind: "activeGroupChanged", groupId: group.id }));
	}

	private activeEditorIdentifier(): EditorIdentifier | undefined {
		const editor = this._activeGroup.editors.find(candidate => candidate.isActive);
		if (!editor) return undefined;
		return Object.freeze({ groupId: editor.groupId, instanceId: editor.instanceId, paneId: editor.paneId, input: editor.input });
	}
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
		if (!group || typeof group !== "object" || !Array.isArray(group.editors) || !Number.isInteger(group.activeEditorIndex) || group.activeEditorIndex < -1 || group.activeEditorIndex >= group.editors.length || !Number.isFinite(group.size) || group.size < 0) {
			throw new TypeError("Invalid editor group working set");
		}
		if (group.id !== undefined) {
			if (!isEditorGroupId(group.id) || groupIds.has(group.id)) throw new TypeError("Invalid editor working set group ID");
			groupIds.add(group.id);
		}
		for (const editor of group.editors) {
			if (!editor || typeof editor !== "object" || typeof editor.preview !== "boolean" || !isSerializedEditorInput(editor.input)) {
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
	if (value.layout !== undefined) validateWorkingSetLayout(value.layout, groupIds, value.groups.length);
	return value;
}

function validateWorkingSetLayout(value: unknown, groupIds: ReadonlySet<string>, expectedLeaves: number): void {
	if (groupIds.size !== expectedLeaves) throw new TypeError("Editor Grid layout requires an ID for every group");
	const seen = new Set<string>();
	const visit = (candidate: unknown, parentOrientation: "horizontal" | "vertical" | undefined): void => {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new TypeError("Invalid Editor Grid layout node");
		const node = candidate as Record<string, unknown>;
		if (!Number.isFinite(node.size) || (node.size as number) < 0 || (node.priority !== "low" && node.priority !== "normal" && node.priority !== "high")) {
			throw new TypeError("Invalid Editor Grid layout geometry");
		}
		if (node.type === "leaf") {
			if (typeof node.visible !== "boolean") throw new TypeError("Invalid Editor Grid leaf visibility");
			const groupId = editorGroupIdFromGridData(node.data);
			if (!groupIds.has(groupId) || seen.has(groupId)) throw new TypeError("Invalid Editor Grid group reference");
			seen.add(groupId);
			return;
		}
		if (node.type !== "branch" || (node.orientation !== "horizontal" && node.orientation !== "vertical") || node.orientation === parentOrientation || !Array.isArray(node.children) || node.children.length === 0) {
			throw new TypeError("Invalid Editor Grid branch");
		}
		for (const child of node.children) visit(child, node.orientation);
	};
	visit(value, undefined);
	if (seen.size !== expectedLeaves) throw new TypeError("Editor Grid layout does not contain every group");
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
	groups: readonly { readonly size: number }[],
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

function editorInputLabel(input: Pick<EditorInput, "resource" | "label">): string {
	if (input.label?.trim()) return input.label;
	const path = decodeURIComponent(input.resource.path).replace(/\/+$/, "");
	const separator = path.lastIndexOf("/");
	return path.slice(separator + 1) || input.resource.toString();
}

class EditorGroupHost extends Disposable {
	readonly view: EditorGroupGridView;

	constructor(readonly group: EditorGroup, listener: IDisposable) {
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

	constructor(readonly group: EditorGroup) {}

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
