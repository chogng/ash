import { isEditorPaneWithSelection } from '../../../workbench/common/editor.js';
import { isEditorPaneWithViewState } from '../../../workbench/browser/parts/editor/editorWithViewState.js';
import { TextEditorSelectionSource } from '../../../platform/editor/common/editor.js';
import { SessionSideChatEditorInput } from '../../contrib/chat/browser/sessionSideChatEditorInput.js';
import { Emitter } from '../../../base/common/event.js';
import { isCancellationError } from '../../../base/common/errors.js';
import { DisposableStore, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import type { IObservable } from '../../../base/common/observable.js';
import type { SerializedGridDescriptor } from '../../../base/browser/ui/grid/grid.js';
import type { IDimension } from '../../../base/browser/dom.js';
import { isRecord } from '../../../base/common/types.js';
import { EditorParts as WorkbenchEditorParts } from '../../../workbench/browser/parts/editor/editorParts.js';
import { IEditorPart, type EditorPart, type IEditorPartOptions } from '../../../workbench/browser/parts/editor/editorPart.js';
import type { IEditorGroupView } from '../../../workbench/browser/parts/editor/editor.js';
import type { IResourceEditorInput, IEditorPane } from '../../../workbench/common/editor.js';
import type { EditorOpenOptions, EditorOpenTarget } from '../../../workbench/services/editor/common/editorService.js';
import { parseEditorWorkingSet, parseEditorWorkingSetLayout, type ApplyEditorWorkingSetOptions, type EditorWorkingSet, type EditorWorkingSetLayout, type EditorWorkingSetTarget, type EditorGroupWorkingSet } from '../../../workbench/services/editor/common/editorWorkingSet.js';
import { TerminalEditorInput } from '../../../workbench/contrib/terminal/browser/terminalEditorInput.js';
import { isSearchEditorInput, SearchEditorID } from '../../../workbench/contrib/searchEditor/browser/constants.js';
import { URI } from '../../../base/common/uri.js';
import { BrowserViewUri } from '../../../platform/browserView/common/browserViewUri.js';
import type { Constructor } from '../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IAccessibilityService } from '../../../platform/accessibility/common/accessibility.js';
import { IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { IAuxiliaryWindowService } from '../../../workbench/services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { DesktopMainEditorPart } from './desktopEditorPart.js';
import { DesktopToolEditorPart } from './desktopToolEditorPart.js';
import { DesktopEditorArea, desktopEditorTools, type DesktopEditorTool, type ToolSlot } from './desktopEditorArea.js';

/** Documents are serialized once. Sessions adds only their Part membership and geometry. */
export interface DesktopEditorWorkingSet extends EditorWorkingSet {
	readonly toolParts?: {
		readonly version: 1;
		readonly layout: SerializedGridDescriptor;
		readonly positioned?: readonly DesktopEditorTool[];
		readonly manuallyArranged?: boolean;
		readonly closedSlots?: Readonly<Partial<Record<DesktopEditorTool, ToolSlot>>>;
		readonly widthWeight?: number;
		readonly parts: Readonly<Record<DesktopEditorTool, {
			readonly groups: readonly number[];
			readonly layout?: EditorWorkingSetLayout;
		}>>;
	};
}

function editorTool(input: IResourceEditorInput): DesktopEditorTool {
	if (input instanceof SessionSideChatEditorInput) { return 'chat'; }
	if (input instanceof TerminalEditorInput) { return 'terminal'; }
	if (input.resource.scheme === BrowserViewUri.scheme) { return 'browser'; }
	if (input.resource.scheme === 'ash-session-changes') { return 'changes'; }
	if (isSearchEditorInput(input)) { return 'search'; }
	return 'files';
}

function serializedTool(entry: EditorGroupWorkingSet['editors'][number]): DesktopEditorTool {
	if (entry.input.typeId === SessionSideChatEditorInput.ID) { return 'chat'; }
	if (entry.input.typeId === TerminalEditorInput.ID) { return 'terminal'; }
	if (entry.input.typeId === 'workbench.editorInput.browser') { return 'browser'; }
	if (entry.input.typeId === 'sessions.editorInput.changes') { return 'changes'; }
	if (entry.paneId === SearchEditorID) { return 'search'; }
	const resourceInput = entry.input.value;
	if (entry.input.typeId === 'workbench.editorInput.resource' && isRecord(resourceInput) && typeof resourceInput.resource === 'string'
		&& isSearchEditorInput({ resource: URI.parse(resourceInput.resource), editorId: typeof resourceInput.editorId === 'string' ? resourceInput.editorId : undefined })) {
		return 'search';
	}
	return 'files';
}

function projectLayout(layout: EditorWorkingSetLayout, ids: ReadonlySet<number>, groupIds?: ReadonlyMap<number, number>): EditorWorkingSetLayout | undefined {
	if (layout.type === 'leaf') {
		if (!ids.has(layout.data.groupId)) return undefined;
		const groupId = groupIds?.get(layout.data.groupId);
		return groupId === undefined ? layout : { ...layout, data: { groupId } };
	}
	const children = layout.children.map(child => projectLayout(child, ids, groupIds))
		.filter((child): child is EditorWorkingSetLayout => !!child)
		.flatMap(child => child.type === 'branch' && child.orientation === layout.orientation ? child.children : [child]);
	if (!children.length) { return undefined; }
	return children.length === 1 ? { ...children[0]!, size: layout.size } : { ...layout, children };
}

/** Fold the former group grid into tool positions; each Part keeps its own projected group layout. */
function legacyToolLayout(saved: EditorWorkingSet): SerializedGridDescriptor | undefined {
	if (!saved.layout) return undefined;
	const seen = new Set<DesktopEditorTool>();
	const groups = new Map(saved.groups.map(group => [group.id, group]));
	const project = (node: EditorWorkingSetLayout, parentOrientation?: number): SerializedGridDescriptor | undefined => {
		if (node.type === 'leaf') {
			const group = groups.get(node.data.groupId);
			if (!group) return undefined;
			const tools = group.editors.length ? [...new Set(group.editors.map(serializedTool))] : ['files' as const];
			const children = tools.filter(tool => !seen.has(tool)).map(tool => {
				seen.add(tool);
				return { ...node, data: tool, size: node.size / tools.length };
			});
			if (!children.length) return undefined;
			return children.length === 1 ? children[0] : {
				type: 'branch', orientation: parentOrientation === 1 ? 0 : 1,
				size: node.size, priority: node.priority, children,
			};
		}
		const children = node.children.map(child => project(child, node.orientation))
			.filter((child): child is SerializedGridDescriptor => !!child)
			.flatMap(child => child.type === 'branch' && child.orientation === node.orientation ? child.children : [child]);
		if (!children.length) return undefined;
		return children.length === 1 ? { ...children[0]!, size: node.size } : { ...node, children };
	};
	const projected = project(saved.layout);
	const missing: SerializedGridDescriptor[] = desktopEditorTools.filter(tool => !seen.has(tool))
		.map(tool => ({ type: 'leaf', data: tool, size: 300, priority: 0, visible: false }));
	if (projected && !missing.length) return projected;
	return {
		type: 'branch', orientation: 1, size: saved.layout.size, priority: 0,
		children: [...(projected?.type === 'branch' && projected.orientation === 1 ? projected.children : projected ? [projected] : []), ...missing],
	};
}

function restorePartLayout(part: EditorPart, layout: EditorWorkingSetLayout, groupIds: ReadonlyMap<number, number>): void {
	const ids = new Set<number>();
	const collect = (node: EditorWorkingSetLayout): void => {
		if (node.type === 'leaf') { ids.add(node.data.groupId); }
		else { node.children.forEach(collect); }
	};
	collect(layout);
	const mapping = new Map([...groupIds].filter(([saved, id]) => ids.has(saved) && part.groups.some(group => group.id === id)));
	const projected = projectLayout(layout, new Set(mapping.keys()));
	if (projected) { part.restoreLayout(projected, mapping); }
}

function hasVisibleGroup(layout: EditorWorkingSetLayout): boolean {
	return layout.type === 'leaf' ? layout.visible : layout.children.some(hasVisibleGroup);
}

/** Owns the Sessions tool Parts and their scoped contexts. */
export class EditorParts extends WorkbenchEditorParts {
	private readonly revealed = this._register(new Emitter<void>());
	public readonly onDidRevealActiveEditor = this.revealed.event;
	private inWorkingSet: (id: number) => boolean = () => true;
	private applying = false;
	private waitForWorkingSet = () => Promise.resolve();
	private readonly hosts: ReadonlyMap<DesktopEditorTool, EditorPart>;
	public readonly filesPart: DesktopMainEditorPart;

	constructor(
		public readonly area: DesktopEditorArea,
		options: IEditorPartOptions,
		flatLayout: IObservable<boolean>,
		@IAuxiliaryWindowService windows: IAuxiliaryWindowService,
		@IAccessibilityService accessibility: IAccessibilityService,
		@IStorageService storage: IStorageService,
		@IInstantiationService services: IInstantiationService,
		@IConfigurationService configuration: IConfigurationService,
		@IContextKeyService contextKeys: IContextKeyService,
	) {
		// The base coordinator needs the main Part at construction time.
		using pending = new DisposableStore();
		const resources = pending.add(new DisposableStore());
		const createTool = <T extends EditorPart>(
			ctor: Constructor<T>,
			tool: DesktopEditorTool,
			partOptions: IEditorPartOptions,
		): T => {
			const container = area.domNode.ownerDocument.createElement('div');
			area.domNode.append(container);
			resources.add(toDisposable(() => container.remove()));
			const context = resources.add(contextKeys.createScoped(container));
			context.createKey('sessions.editorTool', tool);
			const scope = services.createChild(undefined, resources);
			scope.registerInstance(IContextKeyService, context);
			const part = resources.add(scope.createInstance(ctor, container, { ...partOptions, contextKeyService: context }));
			scope.registerInstance(IEditorPart, part);
			return part;
		};
		const { modalContainer, titleActions, ...toolOptions } = options;
		const filesPart = createTool(DesktopMainEditorPart, 'files', {
			...toolOptions,
			modalContainer,
			titleActions,
			canDropEditor: input => !isSearchEditorInput(input),
		});
		super(filesPart, windows, undefined, accessibility, storage, services, configuration);
		this.filesPart = filesPart;
		pending.delete(resources);
		this._register(resources);
		const hosts = new Map<DesktopEditorTool, EditorPart>([['files', filesPart]]);
		this.hosts = hosts;
		try {
			for (const tool of desktopEditorTools) {
				if (tool === 'files') continue;
				const toolTitleActions: IEditorPartOptions['titleActions'] = titleActions && (tool === 'changes' || tool === 'terminal') ? {
					menuService: titleActions.menuService,
					contextMenuProvider: {
						showContextMenu: delegate =>
							titleActions.contextMenuProvider.showContextMenu(
								tool === 'changes' || flatLayout.get() ? { ...delegate, iconPlacement: 'trailing' } : delegate,
							),
					},
				} : titleActions;
				hosts.set(tool, createTool(DesktopToolEditorPart, tool, {
					...toolOptions,
					canDropEditor: input => (tool === 'search') === isSearchEditorInput(input),
					hideTabs: tool === 'changes',
					titleActions: toolTitleActions,
				}));
			}
			for (const [tool, part] of hosts) {
				area.addTool(tool, part, part.domNode.parentElement!);
				for (const group of part.groups) {
					if (!group.inputs.length) { part.setGroupVisible(group.id, false); }
				}
				if (tool !== 'files') {
					this._register(this.registerEditorPart(part, input => editorTool(input) === tool, () => this.syncArea()));
				}
			}
			this._register(this.onDidChangeEditors(event => {
				if (this.applying) { return; }
				if (event.kind === 'groupChanged' && event.event.kind === 'editorClosed') {
					const host = [...this.hosts.values()].find(part => part.groups.some(group => group.id === event.groupId));
					const group = host?.groups.find(candidate => candidate.id === event.groupId);
					if (host && host !== filesPart && group && group.inputs.length === 0) { host.setGroupVisible(group.id, false); }
				}
				this.syncArea();
			}));
			this.syncArea();
		} catch (error) {
			this.dispose();
			throw error;
		}
	}

	public get pageGroupId(): number { return this.filesPart.pageGroupId; }
	public createRetainedGroup(tool: DesktopEditorTool): IEditorGroupView {
		const host = this.hosts.get(tool)!;
		if (!(host instanceof DesktopToolEditorPart)) throw new Error('Retained conversation editors require a tool host');
		return host.createRetainedGroup();
	}
	public async restoreRetainedGroup(tool: DesktopEditorTool, saved: EditorWorkingSet): Promise<IEditorGroupView> {
		if (saved.groups.length !== 1 || saved.groups[0]!.editors.some(editor => serializedTool(editor) !== tool)) {
			throw new TypeError('Retained editor state must contain one group for its tool');
		}
		const host = this.hosts.get(tool)!;
		const previous = host.groups.map(group => group.id);
		const active = this.activeGroup;
		await host.applyWorkingSet({ ...saved, layout: undefined, groups: saved.groups.map(group => ({ ...group, id: undefined })) }, {
			preserveGroups: previous, preserveFocus: true,
		});
		const restored = host.groups.find(group => !previous.includes(group.id))!;
		host.setGroupVisible(restored.id, false);
		if (this.groups.includes(active)) this.activateGroup(active.id);
		this.syncArea();
		return restored;
	}
	public get mainWindowGroups(): readonly IEditorGroupView[] { return [...this.hosts.values()].flatMap(part => part.groups); }
	public get filesDetailsOpen(): boolean { return this.filesPart.detailsOpen; }
	public get filesDetailsVisible(): boolean { return this.filesPart.detailsVisible; }
	public get fileEditorsVisible(): boolean {
		return this.filesPart.fileGroups.some(group => this.filesPart.isGroupVisible(group.id));
	}

	public setGroupScope(contains: (id: number) => boolean): IDisposable {
		this.inWorkingSet = contains;
		const filesScope = this.filesPart.setGroupScope(contains);
		for (const part of this.hosts.values()) {
			if (part instanceof DesktopToolEditorPart) { part.setGroupScope(contains); }
		}
		return toDisposable(() => {
			filesScope.dispose();
			this.inWorkingSet = () => true;
			for (const part of this.hosts.values()) {
				if (part instanceof DesktopToolEditorPart) { part.setGroupScope(() => true); }
			}
		});
	}

	private owner(groupId: number): EditorPart {
		const part = [...this.hosts.values()].find(part => part.groups.some(group => group.id === groupId));
		if (!part) { throw new RangeError(`Editor group is not in a tool workspace: ${groupId}`); }
		return part;
	}

	private syncArea(): void {
		if (this.applying) { return; }
		const productPage = this.filesPart.isGroupVisible(this.pageGroupId);
		this.area.syncVisible([...this.hosts]
			.filter(([tool, part]) => (!productPage || tool === 'files') && part.groups.some(group => part.isGroupVisible(group.id)))
			.map(([tool]) => tool), this.isWindowEditorPart(this.activePart) ? undefined : this.toolForGroup(this.activeGroup.id), productPage);
	}

	private toolForGroup(groupId: number): DesktopEditorTool {
		const host = this.owner(groupId);
		return [...this.hosts].find(([, part]) => part === host)![0];
	}

	public override setGroupVisible(id: number, visible: boolean): void {
		super.setGroupVisible(id, visible);
		this.syncArea();
	}

	public override layout(dimension: IDimension): void { this.area.layout(dimension); }

	public override getEditorState() {
		return { ...super.getEditorState(), groups: this.groups.map(group => group.getEditorState()) };
	}

	public override getWindowEditorReturnGroup(input: IResourceEditorInput): IEditorGroupView {
		const part = this.hosts.get(editorTool(input))!;
		return part instanceof DesktopToolEditorPart ? part.resolveDefaultGroup(input) : this.filesPart.resolveDefaultGroup(input);
	}

	public override revealReturnedEditors(group: IEditorGroupView): void {
		this.activateGroup(group.id);
		this.syncArea();
		this.area.revealTool(this.toolForGroup(group.id));
		this.revealed.fire();
	}

	public bindWindowEditorReturn(whenReady: () => Promise<void>): IDisposable {
		this.waitForWorkingSet = whenReady;
		return toDisposable(() => { this.waitForWorkingSet = () => Promise.resolve(); });
	}

	public override whenReadyForWindowEditorReturn(): Promise<void> { return this.waitForWorkingSet(); }

	public override async openEditor(input: IResourceEditorInput, options: EditorOpenOptions = {}, target?: EditorOpenTarget): Promise<IEditorPane> {
		const targetGroupId = typeof target === 'object' ? target.groupId : undefined;
		const targetPart = targetGroupId !== undefined
			? this.parts.find(part => part.groups.some(group => group.id === targetGroupId))
			: this.activePart;
		if (targetPart && this.isWindowEditorPart(targetPart)) return super.openEditor(input, options, target);
		const tool = editorTool(input);
		const host = this.hosts.get(tool)!;
		const groupId = typeof target === 'object' ? target.groupId : undefined;
		if (groupId !== undefined && !host.groups.some(group => group.id === groupId)) {
			target = undefined;
		}
		const pane = await super.openEditor(input, options, target);
		this.syncArea();
		if (!options.inactive && !options.preserveFocus) {
			const group = host.groups.find(group => group.activePane === pane);
			const restored = group && this.area.revealTool(tool);
			// Reopening a tool's selected tab may leave another tool active.
			if (restored) { this.activateGroup(group.id); }
			this.revealed.fire();
			if (restored) pane.focus();
		}
		return pane;
	}

	public async moveModalEditorToMain(): Promise<void> {
		const source = this.activePart;
		const input = source.activeInput;
		if (!source.isModalEditorVisible || !input
			|| !(source instanceof DesktopMainEditorPart || source instanceof DesktopToolEditorPart)) return;
		const host = this.hosts.get(editorTool(input));
		if (!(host instanceof DesktopMainEditorPart || host instanceof DesktopToolEditorPart)) return;
		const target = host.resolveDefaultGroup(input);
		const moved = await source.moveModalEditorTo(target, () => {
			this.setGroupVisible(target.id, true);
			this.activateGroup(target.id);
			this.revealed.fire();
		});
		if (!moved) return;
		target.focus();
	}

	public async openActiveEditorInModal(): Promise<void> {
		const source = this.activePart;
		const input = source.activeInput;
		const pane = source.activePane;
		if (source.isModalEditorVisible || !input || !pane) return;
		if (!isEditorPaneWithSelection(pane) && input.resource.scheme !== 'ash-session-changes') return;
		const viewState = isEditorPaneWithViewState(pane) ? pane.saveViewState() : undefined;
		const selection = isEditorPaneWithSelection(pane) ? pane.getSelection() : undefined;
		const modal = await source.openEditor(input, { preferredEditorId: pane.id, ignoreError: true }, 'modalGroup');
		if (viewState !== undefined && isEditorPaneWithViewState(pane) && isEditorPaneWithViewState(modal)
			&& pane.viewStateTypeId === modal.viewStateTypeId) {
			modal.restoreViewState(viewState);
		} else if (selection && isEditorPaneWithSelection(modal)) {
			modal.restoreSelection(selection, TextEditorSelectionSource.PROGRAMMATIC);
		}
	}

	public async openFiles(): Promise<void> {
		await this.filesPart.openFiles();
		this.syncArea();
	}

	public toggleFileEditors(): Promise<boolean> {
		return this.toggleToolEditors(input => editorTool(input) === 'files', {
			emptyGroupId: this.filesDetailsOpen ? this.filesPart.fileGroups[0]?.id : undefined,
		});
	}

	public getToolGroups(accepts: (input: IResourceEditorInput) => boolean, options: { readonly emptyGroupId?: number; } = {}): readonly IEditorGroupView[] {
		return this.mainWindowGroups.filter(group => group.id !== this.pageGroupId && this.inWorkingSet(group.id)
			&& (group.inputs.some(accepts) || group.id === options.emptyGroupId));
	}

	public async toggleToolEditors(accepts: (input: IResourceEditorInput) => boolean, options: { readonly emptyGroupId?: number; } = {}): Promise<boolean> {
		const groups = this.getToolGroups(accepts, options);
		if (!groups.length) { return false; }
		const visible = groups.some(group => this.isGroupVisible(group.id) && this.area.isToolVisible(this.toolForGroup(group.id)));
		for (const group of groups) { this.setGroupVisible(group.id, !visible); }
		if (!visible) {
			this.activateGroup(groups[0]!.id);
			this.syncArea();
			if (this.area.domNode.hidden) this.revealed.fire();
			else this.focus();
		}
		return true;
	}

	public hideTool(groupId: number = this.activeGroup.id): void {
		const part = this.owner(groupId);
		const focused = part.domNode.ownerDocument.activeElement;
		const hadFocus = part.domNode.contains(focused) || part.groups.some(group => group.headerElement.contains(focused));
		for (const group of part.groups) {
			if (group.id !== this.pageGroupId && this.inWorkingSet(group.id)) { this.setGroupVisible(group.id, false); }
		}
		const next = this.groups.find(group => this.inWorkingSet(group.id) && this.isGroupVisible(group.id));
		if (hadFocus && next) {
			this.activateGroup(next.id);
			this.focus();
		}
	}

	public toggleMaximizeTool(groupId: number = this.activeGroup.id): void {
		const host = this.owner(groupId);
		this.area.toggleMaximize([...this.hosts].find(([, part]) => part === host)![0]);
	}

	public override saveWorkingSet(id: string, excludedGroups: readonly number[] = []): DesktopEditorWorkingSet {
		const parts = {} as Record<DesktopEditorTool, { groups: readonly number[]; layout?: EditorWorkingSetLayout; }>;
		const groups: EditorGroupWorkingSet[] = [];
		for (const [tool, part] of this.hosts) {
			const excluded = [...excludedGroups, this.pageGroupId];
			if (part.groups.every(group => excluded.includes(group.id))) {
				parts[tool] = { groups: [] };
				continue;
			}
			const state = part.saveWorkingSet(id, excluded);
			groups.push(...state.groups);
			parts[tool] = { groups: state.groups.map(group => group.id!), layout: state.layout };
		}
		return {
			id, groups, activeGroupIndex: Math.max(0, groups.findIndex(group => group.id === this.activeGroup.id)),
			toolParts: {
				version: 1, layout: this.area.saveLayout(), positioned: this.area.positionedTools,
				manuallyArranged: this.area.hasManualArrangement, closedSlots: this.area.closedSlots,
				widthWeight: this.area.preferredWidthWeight, parts,
			},
		};
	}

	private readParts(saved: EditorWorkingSet): DesktopEditorWorkingSet['toolParts'] {
		const metadata = (saved as DesktopEditorWorkingSet).toolParts;
		if (metadata === undefined) { return undefined; }
		if (!isRecord(metadata) || metadata.version !== 1 || !isRecord(metadata.parts)) { throw new TypeError('Invalid tool editor working set'); }
		const missing: readonly DesktopEditorTool[] = (['chat', 'search'] as const).filter(tool => metadata.parts[tool] === undefined);
		const layout = missing.length ? this.area.addMissingToolsToLayout(metadata.layout, missing) : metadata.layout;
		this.area.validateLayout(layout);
		if (metadata.positioned !== undefined && (!Array.isArray(metadata.positioned) ||
			metadata.positioned.some(tool => !desktopEditorTools.includes(tool)) ||
			new Set(metadata.positioned).size !== metadata.positioned.length)) { throw new TypeError('Invalid positioned tools'); }
		if (metadata.manuallyArranged !== undefined && typeof metadata.manuallyArranged !== 'boolean') { throw new TypeError('Invalid manual tool arrangement'); }
		if (metadata.widthWeight !== undefined && (typeof metadata.widthWeight !== 'number' || !Number.isFinite(metadata.widthWeight) || metadata.widthWeight <= 0)) {
			throw new TypeError('Invalid tool workspace width weight');
		}
		if (metadata.closedSlots !== undefined && (!isRecord(metadata.closedSlots) || Object.entries(metadata.closedSlots).some(([tool, slot]) =>
			!desktopEditorTools.includes(tool as DesktopEditorTool) || !isRecord(slot) ||
			!Array.isArray(slot.anchors) || !slot.anchors.length || new Set(slot.anchors).size !== slot.anchors.length ||
			slot.anchors.some(anchor => anchor === tool || !desktopEditorTools.includes(anchor)) ||
			!Array.isArray(slot.opposite) || slot.opposite.some(anchor => anchor === tool || !desktopEditorTools.includes(anchor)) ||
			(slot.orientation !== 0 && slot.orientation !== 1) || typeof slot.after !== 'boolean' ||
			typeof slot.ratio !== 'number' || !Number.isFinite(slot.ratio) || slot.ratio < 0.001 || slot.ratio > 1000))) {
			throw new TypeError('Invalid closed tool slot');
		}
		const unassigned = new Set(saved.groups.map(group => group.id));
		for (const tool of desktopEditorTools) {
			const state = missing.includes(tool) ? { groups: [] } : metadata.parts[tool];
			if (!isRecord(state) || !Array.isArray(state.groups)) { throw new TypeError(`Invalid tool editor membership for '${tool}'`); }
			for (const id of state.groups) {
				if (!Number.isSafeInteger(id) || !unassigned.delete(id)) { throw new TypeError(`Invalid tool editor group identity for '${tool}'`); }
			}
			if (state.layout !== undefined) {
				try {
					parseEditorWorkingSetLayout(state.layout, new Set(state.groups));
				} catch (error) {
					throw new TypeError(`Invalid editor grid for tool '${tool}': ${String(error)}`, { cause: error });
				}
			}
		}
		if (unassigned.size) { throw new TypeError('Unassigned tool editor group'); }
		return missing.length ? {
			...metadata, layout, parts: {
				...metadata.parts,
				...Object.fromEntries(missing.map(tool => [tool, { groups: [] }])),
			}
		} : metadata;
	}

	/** Repair Files membership for Search tabs even if the saved layout already has a Search tool. */
	public migrateWorkingSet(saved: EditorWorkingSet): DesktopEditorWorkingSet {
		const toolParts = this.readParts(saved);
		if (!toolParts) return saved;
		const files = toolParts.parts.files;
		const search = toolParts.parts.search;
		const existingSearchIndex = saved.groups.findIndex(group => group.id !== undefined && search.groups.includes(group.id));
		const existingSearch = saved.groups[existingSearchIndex];
		const movedEditors: EditorGroupWorkingSet['editors'][number][] = [];
		let movedActiveIndex: number | undefined;
		let revealMovedSearch = false;
		const searchGroupIds = new Map<number, number>();
		const searchGroups: EditorGroupWorkingSet[] = [];
		let nextId = Math.max(0, ...saved.groups.map(group => group.id ?? 0));
		let activeGroupIndex = saved.activeGroupIndex;
		const groups = saved.groups.map((group, index) => {
			if (group.id === undefined || !files.groups.includes(group.id)) return group;
			const searchEditors = group.editors.filter(entry => serializedTool(entry) === 'search');
			if (!searchEditors.length) return group;
			const editors = group.editors.filter(entry => !searchEditors.includes(entry));
			const active = group.editors[group.activeEditorIndex];
			const activeSearch = active ? searchEditors.indexOf(active) : -1;
			if (existingSearch) {
				if (index === saved.activeGroupIndex && activeSearch >= 0) {
					activeGroupIndex = existingSearchIndex;
					movedActiveIndex = existingSearch.editors.length + movedEditors.length + activeSearch;
					const sourceLayout = files.layout && projectLayout(files.layout, new Set([group.id]));
					revealMovedSearch = !sourceLayout || hasVisibleGroup(sourceLayout);
				}
				movedEditors.push(...searchEditors);
			} else {
				const searchId = ++nextId;
				if (!Number.isSafeInteger(searchId)) throw new TypeError('Invalid migrated Search group ID');
				searchGroupIds.set(group.id, searchId);
				if (index === saved.activeGroupIndex && activeSearch >= 0) activeGroupIndex = saved.groups.length + searchGroups.length;
				searchGroups.push({ ...group, id: searchId, editors: searchEditors, activeEditorIndex: Math.max(0, activeSearch) });
			}
			return { ...group, editors, activeEditorIndex: editors.length ? Math.max(0, active ? editors.indexOf(active) : -1) : -1 };
		});
		if (existingSearch && movedEditors.length) {
			groups[existingSearchIndex] = {
				...existingSearch,
				editors: [...existingSearch.editors, ...movedEditors],
				activeEditorIndex: movedActiveIndex ?? Math.max(0, existingSearch.activeEditorIndex),
			};
			// A selected Search tab moved out of a visible Files group must stay visible.
			const layout = revealMovedSearch && search.layout && !hasVisibleGroup(search.layout) ? undefined : search.layout;
			return { ...saved, groups, activeGroupIndex, toolParts: { ...toolParts, parts: { ...toolParts.parts, search: { ...search, layout } } } };
		}
		if (!searchGroups.length) return saved;
		return {
			...saved,
			layout: undefined,
			groups: [...groups, ...searchGroups],
			activeGroupIndex,
			toolParts: {
				...toolParts,
				parts: {
					...toolParts.parts,
					search: {
						groups: [...searchGroupIds.values()],
						layout: files.layout && projectLayout(files.layout, new Set(searchGroupIds.keys()), searchGroupIds),
					},
				},
			},
		};
	}

	public override async applyWorkingSet(saved: EditorWorkingSetTarget, options: ApplyEditorWorkingSetOptions = {}): Promise<void> {
		if (saved !== 'empty') saved = this.migrateWorkingSet(parseEditorWorkingSet(saved, Math.max(...this.groups.map(group => group.id))));
		const metadata = saved === 'empty' ? undefined : this.readParts(saved);
		const restored = new Map<number, number>();
		const activeGroup = saved === 'empty' ? undefined : saved.groups[saved.activeGroupIndex];
		const activeEntry = activeGroup?.editors[activeGroup.activeEditorIndex];
		const activeTool = activeEntry ? serializedTool(activeEntry) : 'files';
		let restoringTool: DesktopEditorTool | undefined;
		this.applying = true;
		try {
			for (const [tool, part] of this.hosts) {
				restoringTool = tool;
				let groups: readonly EditorGroupWorkingSet[] = [];
				let layout: EditorWorkingSetLayout | undefined;
				if (saved !== 'empty') {
					groups = metadata ? saved.groups.filter(group => metadata.parts[tool].groups.includes(group.id!))
						: saved.groups.flatMap(group => {
							const editors = group.editors.filter(entry => serializedTool(entry) === tool);
							if (!editors.length && (group.editors.length || tool !== 'files')) { return []; }
							const active = group.editors[group.activeEditorIndex];
							return [{ ...group, editors, activeEditorIndex: editors.length ? Math.max(0, editors.indexOf(active!)) : -1 }];
						});
					layout = metadata ? metadata.parts[tool].layout : saved.layout && projectLayout(saved.layout, new Set(groups.map(group => group.id!)));
				}
				const originalGroups = groups;
				// Agent Window shows a single tab group per tool in the active working
				// set. Legacy splits keep their tabs, selection and tool visibility.
				if (groups.length > 1) {
					const selected = groups.find(group => group.id === activeGroup?.id)
						?? groups.find(group => group.editors.length) ?? groups[0]!;
					const editors = groups.flatMap(group => group.editors);
					groups = [{ ...selected, editors, activeEditorIndex: editors.length ? Math.max(0, editors.indexOf(selected.editors[selected.activeEditorIndex]!)) : -1 }];
					if (layout) {
						layout = { type: 'leaf', data: { groupId: selected.id! }, size: layout.size, priority: layout.priority, visible: hasVisibleGroup(layout) };
					}
				}
				const previous = new Set(part.groups.map(group => group.id));
				// Saved IDs can overlap another live Part or session. New groups always use the window allocator.
				const state: EditorWorkingSetTarget = groups.length ? {
					id: saved === 'empty' ? 'empty' : saved.id, activeGroupIndex: 0,
					groups: groups.map(group => ({ ...group, id: undefined })),
				} : 'empty';
				await part.applyWorkingSet(state, {
					...options, preserveGroups: [...new Set([...(options.preserveGroups ?? []), this.pageGroupId])].filter(id => previous.has(id)),
				});
				const created = part.groups.filter(group => !previous.has(group.id));
				const included = options.excludeEmptyGroups && groups.some(group => group.editors.length) ? groups.filter(group => group.editors.length) : groups;
				const mapping = new Map(included.flatMap((group, index) => group.id === undefined || !created[index] ? [] : [[group.id, created[index]!.id] as const]));
				if (layout) { restorePartLayout(part, layout, mapping); }
				const restoredGroups = originalGroups.length > 1 && created[0]
					? originalGroups.map(group => [group.id!, created[0]!.id] as const)
					: mapping;
				for (const [from, to] of restoredGroups) {
					// A legacy mixed group becomes several tool groups. Its selected tab chooses the active Part.
					if (metadata || tool === activeTool || !restored.has(from)) { restored.set(from, to); }
				}
				if (tool !== 'files' || !this.filesDetailsOpen) {
					for (const group of created) { if (!group.inputs.length) { part.setGroupVisible(group.id, false); } }
				}
			}
			restoringTool = undefined;
			const layout = metadata?.layout ?? (saved === 'empty' ? undefined : legacyToolLayout(saved));
			if (layout) {
				this.area.restoreLayout(layout, metadata ? metadata.positioned : desktopEditorTools, metadata ? metadata.manuallyArranged : true, metadata?.closedSlots, metadata?.widthWeight);
			}
			if (saved !== 'empty') {
				const activeId = restored.get(saved.groups[saved.activeGroupIndex]?.id ?? -1);
				if (activeId !== undefined) { this.activateGroup(activeId); }
			}
		} catch (error) {
			if (!restoringTool || isCancellationError(error)) { throw error; }
			throw new Error(`Could not restore editor groups for tool '${restoringTool}': ${String(error)}`, { cause: error });
		} finally {
			this.applying = false;
			this.syncArea();
		}
	}

	public restoreWorkingSetLayout(saved: EditorWorkingSet, groupIds: ReadonlyMap<number, number>): void {
		const metadata = this.readParts(saved);
		if (!metadata) {
			if (saved.layout) { this.restoreLayout(saved.layout, groupIds); }
			return;
		}
		this.applying = true;
		try {
			for (const [tool, part] of this.hosts) {
				const layout = metadata.parts[tool].layout;
				if (layout) { restorePartLayout(part, layout, groupIds); }
			}
			this.area.restoreLayout(metadata.layout, metadata.positioned, metadata.manuallyArranged, metadata.closedSlots, metadata.widthWeight);
		} finally {
			this.applying = false;
			this.syncArea();
		}
	}

	public withWorkingSetLayout(saved: EditorWorkingSet, geometry: EditorWorkingSet, activeId: number | undefined): DesktopEditorWorkingSet {
		const current = saved as DesktopEditorWorkingSet;
		const previous = this.readParts(geometry);
		const index = saved.groups.findIndex(group => group.id === activeId);
		const activeGroupIndex = index < 0 ? saved.activeGroupIndex : index;
		if (!current.toolParts || !previous) { return { ...saved, layout: geometry.layout ?? saved.layout, activeGroupIndex }; }
		const parts = Object.fromEntries(desktopEditorTools.map(tool => {
			const state = current.toolParts!.parts[tool];
			const layout = previous.parts[tool].layout;
			return [tool, { ...state, layout: layout ? projectLayout(layout, new Set(state.groups)) : state.layout }];
		})) as NonNullable<DesktopEditorWorkingSet['toolParts']>['parts'];
		return { ...saved, activeGroupIndex, toolParts: { ...previous, parts } };
	}

	private restoreLayout(layout: EditorWorkingSetLayout, groupIds: ReadonlyMap<number, number>): void {
		for (const part of this.hosts.values()) { restorePartLayout(part, layout, groupIds); }
		const originalIds = new Map([...groupIds].map(([saved, current]) => [current, saved]));
		const groups = this.saveWorkingSet('legacy-tool-layout').groups.flatMap(group => {
			const id = originalIds.get(group.id!);
			return id === undefined ? [] : [{ ...group, id }];
		});
		const tools = legacyToolLayout({ id: 'legacy-tool-layout', groups, activeGroupIndex: 0, layout });
		if (tools) { this.area.restoreLayout(tools, desktopEditorTools, true); }
		this.syncArea();
	}
}
