import "./media/auxiliaryEditorPart.css";
import { addDisposableListener } from "../../../../base/browser/dom.js";
import { Dimension, type IDimension } from "../../../../base/browser/dom.js";
import type { Direction as GridDirection } from "../../../../base/browser/ui/grid/grid.js";
import { Emitter, type Event } from "../../../../base/common/event.js";
import { DisposableMap, Disposable, DisposableStore, type IDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { rot } from "../../../../base/common/numbers.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";
import type { EditorInput, EditorOpenOptions, EditorOpenTarget } from "../../../services/editor/common/editorService.js";
import type { ApplyEditorWorkingSetOptions, EditorWorkingSet, EditorWorkingSetTarget } from "../../../services/editor/common/editorWorkingSet.js";
import type { EditorIdentifier, EditorPartChangeEvent, EditorPartState } from "../../../services/editor/common/editorState.js";
import type { IAuxiliaryWindow, IAuxiliaryWindowService } from "../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js";
import { StatusbarService } from "../../../services/statusbar/browser/statusbar.js";
import { StatusbarHeight } from "../workbenchPartDimensions.js";
import { StatusbarPart } from "../statusbar/statusbarPart.js";
import type { IEditorPane, IEditorPaneDescriptor } from "./editorPane.js";
import { editorInputKey } from "./editorTabsControl.js";
import { EditorStatusContribution } from "./editorStatus.js";
import type { EditorCloseAllOptions, IEditorPart, RecentlyClosedEditor } from "./editorPart.js";
import type { IEditorGroup } from "./editorGroup.js";

export interface AuxiliaryEditorPartCreation {
	readonly part: IEditorPart;
	readonly resources?: readonly IDisposable[];
}

export type AuxiliaryEditorPartFactory = (container: HTMLElement) => AuxiliaryEditorPartCreation;

/** Multi-window coordinator exposed to commands and editor services. */
export interface IEditorPartsService extends IEditorPart {
	readonly mainPart: IEditorPart;
	readonly parts: readonly IEditorPart[];
	readonly activePart: IEditorPart;
	readonly onDidCreateAuxiliaryEditorPart: Event<IEditorPart>;
	createAuxiliaryEditorPart(): Promise<IEditorPart>;
	moveActiveEditorToNewWindow(): Promise<IEditorPart | undefined>;
	closeAuxiliaryEditorPart(part: IEditorPart): Promise<boolean>;
}

export const IEditorPartsService = createServiceIdentifier<IEditorPartsService>("editorPartsService");

/** Coordinates one primary EditorPart and zero or more auxiliary-window parts. */
export class EditorParts extends Disposable implements IEditorPartsService {
	private readonly editorChangeEmitter = this._register(new Emitter<EditorPartChangeEvent>());
	private readonly auxiliaryCreatedEmitter = this._register(new Emitter<IEditorPart>());
	private readonly auxiliary = this._register(new DisposableMap<IEditorPart, AuxiliaryEditorPartHandle>());
	private readonly partListeners = this._register(new DisposableMap<IEditorPart, DisposableStore>());
	private _activePart: IEditorPart;
	readonly onDidChangeEditors = this.editorChangeEmitter.event;
	readonly onDidCreateAuxiliaryEditorPart = this.auxiliaryCreatedEmitter.event;

	constructor(
		readonly mainPart: IEditorPart,
		private readonly windows: IAuxiliaryWindowService,
		private readonly createPart: AuxiliaryEditorPartFactory,
	) {
		super();
		this._activePart = mainPart;
		this.registerPart(mainPart);
	}

	get parts(): readonly IEditorPart[] { return [this.mainPart, ...this.auxiliary.keys()]; }
	get activePart(): IEditorPart { return this._activePart; }
	get domNode(): HTMLElement { return this._activePart.domNode; }
	get groups(): readonly IEditorGroup[] { return this.parts.flatMap(part => part.groups); }
	get activeGroup(): IEditorGroup { return this._activePart.activeGroup; }
	get activeInput(): EditorInput | undefined { return this._activePart.activeInput; }
	get activePane(): IEditorPane | undefined { return this._activePart.activePane; }
	get isModalEditorVisible(): boolean { return this._activePart.isModalEditorVisible; }
	get editorsMru(): readonly EditorIdentifier[] {
		return uniqueEditors([this._activePart, ...this.parts.filter(part => part !== this._activePart)].flatMap(part => part.editorsMru));
	}
	get recentlyClosedEditors(): readonly RecentlyClosedEditor[] {
		return [this._activePart, ...this.parts.filter(part => part !== this._activePart)].flatMap(part => part.recentlyClosedEditors);
	}

	getEditorState(): EditorPartState { return this._activePart.getEditorState(); }

	async createAuxiliaryEditorPart(): Promise<IEditorPart> {
		const auxiliaryWindow = await this.windows.open({ title: "Editor" });
		let creation: AuxiliaryEditorPartCreation;
		try {
			creation = this.createPart(auxiliaryWindow.container);
		} catch (error) {
			auxiliaryWindow[Symbol.dispose]();
			throw error;
		}
		const handle = new AuxiliaryEditorPartHandle(auxiliaryWindow, creation);
		this.auxiliary.set(creation.part, handle);
		this.registerPart(creation.part, auxiliaryWindow);
		this.setActivePart(creation.part);
		this.auxiliaryCreatedEmitter.fire(creation.part);
		return creation.part;
	}

	async moveActiveEditorToNewWindow(): Promise<IEditorPart | undefined> {
		const source = this._activePart;
		if (!source.activeInput) return undefined;
		const target = await this.createAuxiliaryEditorPart();
		try {
			if (!await source.moveActiveEditorTo(target)) throw new Error("The active editor could not be moved");
			this.setActivePart(target);
			target.focus();
			return target;
		} catch (error) {
			await this.closeAuxiliaryEditorPart(target);
			this.setActivePart(source);
			throw error;
		}
	}

	async closeAuxiliaryEditorPart(part: IEditorPart): Promise<boolean> {
		if (!this.auxiliary.has(part)) return false;
		if (!await part.closeAllEditors()) return false;
		this.removeAuxiliaryPart(part);
		return true;
	}

	openEditor(input: EditorInput, options?: EditorOpenOptions, target?: EditorOpenTarget): Promise<IEditorPane> {
		return this._activePart.openEditor(input, options, target);
	}

	activateEditor(input: EditorInput): IEditorPane {
		const part = this.findPartForInput(input) ?? this._activePart;
		this.setActivePart(part);
		return part.activateEditor(input);
	}

	activateEditorIdentifier(identifier: EditorIdentifier): IEditorPane | undefined {
		const part = this.parts.find(candidate => candidate.groups.some(group => group.id === identifier.groupId));
		if (!part) return undefined;
		this.setActivePart(part);
		return part.activateEditorIdentifier(identifier);
	}

	activateEditorMru(offset: number): IEditorPane | undefined {
		if (!Number.isInteger(offset) || offset === 0) throw new TypeError("Editor MRU offset must be a non-zero integer");
		const editors = this.editorsMru;
		if (editors.length === 0) return undefined;
		const index = rot(offset, editors.length);
		return this.activateEditorIdentifier(editors[index]!);
	}

	async closeEditor(input: EditorInput): Promise<boolean> {
		const part = this.findPartForInput(input) ?? this._activePart;
		return part.closeEditor(input);
	}

	async confirmCloseAllEditors(): Promise<boolean> {
		for (const part of this.parts) if (!await part.confirmCloseAllEditors()) return false;
		return true;
	}

	async closeAllEditors(options: EditorCloseAllOptions = {}): Promise<boolean> {
		if (!options.skipConfirmation && !await this.confirmCloseAllEditors()) return false;
		for (const part of this.parts) {
			if (!await part.closeAllEditors({ ...options, skipConfirmation: true })) return false;
		}
		if (options.reason === "reset") {
			for (const part of [...this.auxiliary.keys()]) this.removeAuxiliaryPart(part);
			this.setActivePart(this.mainPart);
		}
		return true;
	}

	moveActiveEditorTo(target: IEditorPart): Promise<boolean> {
		return this._activePart.moveActiveEditorTo(target === this ? this._activePart : target);
	}

	setWelcomeRecentProjects(projects: readonly import("../../../contrib/files/browser/editorWelcome.js").IEditorWelcomeProject[]): void {
		for (const part of this.parts) part.setWelcomeRecentProjects(projects);
	}

	setWelcomeVisible(visible: boolean): void { this.mainPart.setWelcomeVisible(visible); }
	saveActiveEditor(): Promise<void> { return this._activePart.saveActiveEditor(); }
	setContent(content: Element): Promise<void> { return this._activePart.setContent(content); }
	splitActiveGroup(direction: GridDirection): Promise<void> { return this._activePart.splitActiveGroup(direction); }
	splitActiveGroupHorizontal(): Promise<void> { return this._activePart.splitActiveGroupHorizontal(); }
	splitActiveGroupVertical(): Promise<void> { return this._activePart.splitActiveGroupVertical(); }
	getEditorPaneChoices(input?: EditorInput): readonly IEditorPaneDescriptor[] { return this._activePart.getEditorPaneChoices(input); }
	reopenActiveEditorWith(preferredEditorId: string): Promise<IEditorPane | undefined> { return this._activePart.reopenActiveEditorWith(preferredEditorId); }
	reopenClosedEditor(): Promise<boolean> { return this._activePart.reopenClosedEditor(); }
	saveWorkingSet(id: string): EditorWorkingSet { return this._activePart.saveWorkingSet(id); }
	applyWorkingSet(workingSet: EditorWorkingSetTarget, options?: ApplyEditorWorkingSetOptions): Promise<void> { return this._activePart.applyWorkingSet(workingSet, options); }
	layout(dimension: IDimension): void { this.mainPart.layout(dimension); }
	focus(): void { this._activePart.focus(); }

	private registerPart(part: IEditorPart, auxiliaryWindow?: IAuxiliaryWindow): void {
		const listeners = new DisposableStore();
		listeners.add(part.onDidChangeEditors(event => {
			if (isActivationEvent(event)) this.setActivePart(part, false);
			this.editorChangeEmitter.fire(event);
		}));
		listeners.add(addDisposableListener(part.domNode, "focusin", () => this.setActivePart(part)));
		if (auxiliaryWindow) listeners.add(auxiliaryWindow.onDidClose(() => this.removeAuxiliaryPart(part)));
		this.partListeners.set(part, listeners);
	}

	private removeAuxiliaryPart(part: IEditorPart): void {
		if (!this.auxiliary.has(part)) return;
		this.partListeners.deleteAndDispose(part);
		this.auxiliary.deleteAndDispose(part);
		if (this._activePart === part) this.setActivePart(this.mainPart);
	}

	private setActivePart(part: IEditorPart, publish = true): void {
		if (this._activePart === part) return;
		this._activePart = part;
		if (publish) this.editorChangeEmitter.fire(Object.freeze({ kind: "activeGroupChanged", groupId: part.activeGroup.id }));
	}

	private findPartForInput(input: EditorInput): IEditorPart | undefined {
		const key = editorInputKey(input);
		return this.parts.find(part => part.groups.some(group => group.inputs.some(candidate => editorInputKey(candidate) === key)));
	}
}

class AuxiliaryEditorPartHandle extends Disposable {
	constructor(window: IAuxiliaryWindow, creation: AuxiliaryEditorPartCreation) {
		super();
		// The window service owns registry lifetime; this handle only requests close.
		this._register(toDisposable(() => window[Symbol.dispose]()));
		const resources = this._register(new DisposableStore());
		for (const resource of creation.resources ?? []) resources.add(resource);
		this._register(creation.part);
		const statusbarService = this._register(new StatusbarService());
		const statusbarPart = this._register(new StatusbarPart(window.container, statusbarService));
		this._register(new EditorStatusContribution(creation.part, statusbarService));
		this._register(window.onBeforeUnload(event => {
			if (creation.part.getEditorState().groups.some(group => group.editors.some(editor => editor.isDirty))) {
				event.veto("The auxiliary editor window contains unsaved changes.");
			}
		}));
		this._register(window.onDidLayout(dimension => {
			creation.part.layout(new Dimension(dimension.width, Math.max(0, dimension.height - StatusbarHeight)));
			statusbarPart.layout(new Dimension(dimension.width, StatusbarHeight));
		}));
		window.layout();
	}
}

function isActivationEvent(event: EditorPartChangeEvent): boolean {
	return event.kind === "activeGroupChanged" || (event.kind === "groupChanged" && event.event.kind === "activeEditorChanged");
}

function uniqueEditors(editors: readonly EditorIdentifier[]): readonly EditorIdentifier[] {
	const ids = new Set<string>();
	return editors.filter(editor => {
		if (ids.has(editor.instanceId)) return false;
		ids.add(editor.instanceId);
		return true;
	});
}
