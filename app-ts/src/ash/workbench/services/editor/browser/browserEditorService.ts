import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { IEditorPart } from "../../../browser/parts/editor/editorPart.js";
import type { EditorInput, EditorOpenOptions, EditorOpenTarget, IEditorService } from "../common/editorService.js";
import type { IEditorGroupsService } from '../common/editorGroupsService.js';
import type { EditorGroupId, EditorGroupState, EditorPartChangeEvent, EditorPartState } from "../common/editorState.js";

/** Projects the Editor Part into the resource-oriented Workbench editor contract. */
export class BrowserEditorService extends Disposable implements IEditorService, IEditorGroupsService {
	private readonly activeEditorChangeEmitter = this._register(new Emitter<void>());
	private readonly visibleEditorsChangeEmitter = this._register(new Emitter<void>());
	private readonly groupsChangeEmitter = this._register(new Emitter<void>());
	private readonly groupAddEmitter = this._register(new Emitter<EditorGroupState>());
	private readonly groupRemoveEmitter = this._register(new Emitter<EditorGroupId>());
	private readonly groupActivateEmitter = this._register(new Emitter<EditorGroupState>());
	private activeEditorSignature: string;
	private visibleEditorSignature: string;

	readonly onDidActiveEditorChange = this.activeEditorChangeEmitter.event;
	readonly onDidVisibleEditorsChange = this.visibleEditorsChangeEmitter.event;
	readonly onDidChangeGroups = this.groupsChangeEmitter.event;
	readonly onDidAddGroup = this.groupAddEmitter.event;
	readonly onDidRemoveGroup = this.groupRemoveEmitter.event;
	readonly onDidActivateGroup = this.groupActivateEmitter.event;
	readonly whenReady = Promise.resolve();

	constructor(private readonly editorPart: IEditorPart) {
		super();
		this.activeEditorSignature = this.getActiveEditorSignature();
		this.visibleEditorSignature = this.getVisibleEditorSignature();
		this._register(editorPart.onDidChangeEditors(event => this.publishState(event)));
	}

	get onDidChangeEditors(): Event<EditorPartChangeEvent> {
		return this.editorPart.onDidChangeEditors;
	}

	getEditorState(): EditorPartState {
		return this.editorPart.getEditorState();
	}

	get activeEditor(): EditorInput | undefined {
		return this.editorPart.activeInput;
	}

	get visibleEditors(): readonly EditorInput[] {
		const state = this.editorPart.getEditorState();
		const editors = this.editorPart.groups.flatMap(group => group.activeInput ? [group.activeInput] : []);
		if (state.isModalEditorVisible && this.editorPart.activeInput) editors.unshift(this.editorPart.activeInput);
		return Object.freeze(editors);
	}

	get groups(): readonly EditorGroupState[] {
		return Object.freeze(this.editorPart.groups.map(group => group.getEditorState()));
	}

	get activeGroup(): EditorGroupState {
		return this.editorPart.activeGroup.getEditorState();
	}

	get count(): number {
		return this.groups.length;
	}

	async openEditor(input: EditorInput, options?: EditorOpenOptions, target?: EditorOpenTarget): Promise<void> {
		await this.editorPart.openEditor(input, options, target);
		if (options?.preserveFocus !== true) this.editorPart.focus();
	}

	focusActiveEditor(): void {
		this.editorPart.focus();
	}

	private publishState(event: EditorPartChangeEvent): void {
		if (event.kind === 'groupAdded') this.groupAddEmitter.fire(event.group);
		else if (event.kind === 'groupRemoved') this.groupRemoveEmitter.fire(event.groupId);
		else if (event.kind === 'activeGroupChanged') this.groupActivateEmitter.fire(this.activeGroup);
		this.groupsChangeEmitter.fire();

		const activeEditorSignature = this.getActiveEditorSignature();
		if (activeEditorSignature !== this.activeEditorSignature) {
			this.activeEditorSignature = activeEditorSignature;
			this.activeEditorChangeEmitter.fire();
		}
		const visibleEditorSignature = this.getVisibleEditorSignature();
		if (visibleEditorSignature !== this.visibleEditorSignature) {
			this.visibleEditorSignature = visibleEditorSignature;
			this.visibleEditorsChangeEmitter.fire();
		}
	}

	private getActiveEditorSignature(): string {
		const state = this.editorPart.getEditorState();
		if (state.isModalEditorVisible) return `modal:${editorInputSignature(this.editorPart.activeInput)}`;
		return state.activeEditor ? `${state.activeEditor.instanceId}:${state.activeEditor.paneId}` : '';
	}

	private getVisibleEditorSignature(): string {
		const state = this.editorPart.getEditorState();
		const visible = this.editorPart.groups.flatMap(group => {
			const groupState = group.getEditorState();
			const active = groupState.editors.find(editor => editor.instanceId === groupState.activeEditorInstanceId);
			return active ? [`${active.instanceId}:${active.paneId}`] : [];
		});
		if (state.isModalEditorVisible) visible.unshift(`modal:${editorInputSignature(this.editorPart.activeInput)}`);
		return visible.join('\0');
	}
}

function editorInputSignature(input: EditorInput | undefined): string {
	return input ? `${input.resource.toString()}\0${input.contentType ?? ''}\0${input.languageId ?? ''}` : '';
}
