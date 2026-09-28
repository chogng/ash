import { addDisposableListener } from "../../../../base/browser/dom.js";
import type { IDimension } from "../../../../base/browser/dom.js";
import type { Direction as GridDirection } from "../../../../base/browser/ui/grid/grid.js";
import { Emitter, type Event } from "../../../../base/common/event.js";
import { onUnexpectedError } from "../../../../base/common/errors.js";
import { DisposableMap, Disposable, DisposableStore, toDisposable, type IDisposable } from "../../../../base/common/lifecycle.js";
import { rot } from "../../../../base/common/numbers.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";
import { type IStorageService, StorageScope, StorageTarget } from "../../../../platform/storage/common/storage.js";
import type { IAccessibilityService } from "../../../../platform/accessibility/common/accessibility.js";
import type { EditorInput, EditorOpenOptions, EditorOpenTarget } from "../../../services/editor/common/editorService.js";
import type { ApplyEditorWorkingSetOptions, EditorWorkingSet, EditorWorkingSetTarget } from "../../../services/editor/common/editorWorkingSet.js";
import type { EditorIdentifier, EditorPartChangeEvent, EditorPartState } from "../../../services/editor/common/editorState.js";
import type { IAuxiliaryWindow, IAuxiliaryWindowService } from "../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js";
import type { IEditorPane, IEditorPaneDescriptor } from "./editorPane.js";
import { editorInputKey } from "./editorTabsControl.js";
import type { EditorCloseAllOptions, IEditorPart, RecentlyClosedEditor } from "./editorPart.js";
import type { IEditorGroup } from "./editorGroup.js";
import {
	AuxiliaryEditorPart,
	type AuxiliaryEditorPartCreation,
	type AuxiliaryEditorPartFactory,
} from "./auxiliaryEditorPart.js";

export interface EditorPartsState {
	readonly version: 1;
	readonly active: number;
	readonly parts: readonly EditorWorkingSet[];
}

/** Multi-window coordinator exposed to commands and editor services. */
export interface IEditorPartsService extends IEditorPart {
	readonly mainPart: IEditorPart;
	readonly parts: readonly IEditorPart[];
	readonly activePart: IEditorPart;
	readonly onDidCreateAuxiliaryEditorPart: Event<IEditorPart>;
	createAuxiliaryEditorPart(): Promise<IEditorPart>;
	moveActiveEditorToNewWindow(): Promise<IEditorPart | undefined>;
	closeAuxiliaryEditorPart(part: IEditorPart): Promise<boolean>;
	replaceEditorResource(source: IEditorGroup, input: EditorInput, replacement: EditorInput): Promise<void>;
	savePartsState(): EditorPartsState;
	restorePartsState(state: EditorPartsState): Promise<void>;
	restoreSavedState(shouldRestore: boolean): Promise<void>;
	pauseStatePersistence(): IDisposable;
}

export const IEditorPartsService = createServiceIdentifier<IEditorPartsService>("editorPartsService");

/** Coordinates one primary EditorPart and zero or more auxiliary-window parts. */
export class EditorParts extends Disposable implements IEditorPartsService {
	private static readonly stateStorageKey = 'editorparts.state';
	private readonly editorChangeEmitter = this._register(new Emitter<EditorPartChangeEvent>());
	private readonly auxiliaryCreatedEmitter = this._register(new Emitter<IEditorPart>());
	private readonly auxiliary = this._register(new DisposableMap<IEditorPart, AuxiliaryEditorPart>());
	private readonly partListeners = this._register(new DisposableMap<IEditorPart, DisposableStore>());
	private _activePart: IEditorPart;
	private hasRestoredState = false;
	private statePersistencePauses = 0;
	readonly onDidChangeEditors = this.editorChangeEmitter.event;
	readonly onDidCreateAuxiliaryEditorPart = this.auxiliaryCreatedEmitter.event;

	constructor(
		readonly mainPart: IEditorPart,
		private readonly windows: IAuxiliaryWindowService,
		private readonly createPart: AuxiliaryEditorPartFactory,
		private readonly accessibility: IAccessibilityService,
		private readonly storage: IStorageService,
	) {
		super();
		this._activePart = mainPart;
		this.registerPart(mainPart);
		this._register(storage.onWillSaveState(() => {
			if (this.hasRestoredState && this.statePersistencePauses === 0) {
				storage.store(EditorParts.stateStorageKey, JSON.stringify(this.savePartsState()), StorageScope.WORKSPACE, StorageTarget.MACHINE);
			}
		}));
	}

	get parts(): readonly IEditorPart[] { return [this.mainPart, ...this.auxiliary.keys()]; }
	get activePart(): IEditorPart { return this._activePart; }
	get domNode(): HTMLElement { return this._activePart.domNode; }
	get groups(): readonly IEditorGroup[] { return this.parts.flatMap(part => part.groups); }
	get activeGroup(): IEditorGroup { return this._activePart.activeGroup; }
	toggleActiveGroupLock(): boolean { return this._activePart.toggleActiveGroupLock(); }
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

	savePartsState(): EditorPartsState {
		const parts = this.parts;
		return { version: 1, active: parts.indexOf(this._activePart), parts: parts.map(part => part.saveWorkingSet('lastSession')) };
	}

	async restoreSavedState(shouldRestore: boolean): Promise<void> {
		try {
			if (!shouldRestore) return;
			const saved = this.storage.get(EditorParts.stateStorageKey, StorageScope.WORKSPACE);
			if (saved !== undefined) {
				try {
					await this.restorePartsState(JSON.parse(saved));
				} catch (error) {
					this.storage.remove(EditorParts.stateStorageKey, StorageScope.WORKSPACE);
					throw error;
				}
			}
		} finally {
			this.hasRestoredState = true;
		}
	}

	pauseStatePersistence(): IDisposable {
		this.statePersistencePauses++;
		return toDisposable(() => { this.statePersistencePauses--; });
	}

	async restorePartsState(state: EditorPartsState): Promise<void> {
		if (state?.version !== 1 || !Array.isArray(state.parts) || state.parts.length === 0 || !Number.isInteger(state.active) || state.active < 0 || state.active >= state.parts.length) {
			throw new TypeError('Invalid saved editor parts state');
		}
		await this.mainPart.applyWorkingSet(state.parts[0]!, { preserveFocus: true });
		for (const workingSet of state.parts.slice(1)) {
			const part = await this.createAuxiliaryEditorPart();
			await part.applyWorkingSet(workingSet, { preserveFocus: true });
		}
		this.setActivePart(this.parts[state.active]!);
	}

	async createAuxiliaryEditorPart(): Promise<IEditorPart> {
		const auxiliaryWindow = await this.windows.open({ title: "Editor" });
		let creation: AuxiliaryEditorPartCreation;
		try {
			creation = this.createPart(auxiliaryWindow.container);
		} catch (error) {
			auxiliaryWindow[Symbol.dispose]();
			throw error;
		}
		const handle = new AuxiliaryEditorPart(auxiliaryWindow, creation, this.accessibility);
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

	async replaceEditorResource(source: IEditorGroup, input: EditorInput, replacement: EditorInput): Promise<void> {
		const key = editorInputKey(input);
		const groups = this.groups.filter(group => group.inputs.some(candidate => editorInputKey(candidate) === key));
		if (!groups.includes(source)) throw new RangeError(`Editor is not open in its source group: ${input.resource}`);
		const activePart = this._activePart;
		for (const group of groups) {
			if (group !== source) await group.replaceEditor(input, replacement);
		}
		await source.replaceEditor(input, replacement);
		this.setActivePart(activePart);
	}

	closeEditorIdentifier(identifier: EditorIdentifier): Promise<boolean> {
		const part = this.parts.find(candidate => candidate.groups.some(group => group.id === identifier.groupId));
		return part?.closeEditorIdentifier(identifier) ?? Promise.resolve(false);
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
		if (auxiliaryWindow) listeners.add(auxiliaryWindow.onDidClose(() => {
			void this.returnEditorsToMainPart(part);
		}));
		this.partListeners.set(part, listeners);
	}

	private async returnEditorsToMainPart(part: IEditorPart): Promise<void> {
		const activeGroup = part.activeGroup;
		const activeInput = activeGroup.activeInput;
		const editors = part.groups.flatMap(group => group.inputs.map(input => ({ group, input })));
		const active = editors.find(editor => editor.group === activeGroup && editor.input === activeInput);
		try {
			for (const editor of editors) {
				if (editor === active) continue;
				await editor.group.moveEditorTo(editor.input, this.mainPart.activeGroup, this.mainPart.activeGroup.inputs.length);
			}
			if (active) await active.group.moveEditorTo(active.input, this.mainPart.activeGroup, this.mainPart.activeGroup.inputs.length);
		} catch (error) {
			onUnexpectedError(error);
		} finally {
			this.removeAuxiliaryPart(part);
			this.mainPart.focus();
		}
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
