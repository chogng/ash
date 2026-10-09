import type { IResourceEditorInput } from '../../../common/editor.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import type { IEditorPart } from "../../../browser/parts/editor/editorPart.js";
import type { EditorOpenOptions, EditorOpenTarget, IEditorService } from "../common/editorService.js";
import type { IEditorGroup, IEditorGroupsService, IFindGroupScope } from '../common/editorGroupsService.js';
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

	get activeEditor(): IResourceEditorInput | undefined {
		return this.editorPart.activeInput;
	}

	get visibleEditors(): readonly IResourceEditorInput[] {
		const state = this.editorPart.getEditorState();
		const editors = this.editorPart.groups.flatMap(group => this.editorPart.isGroupVisible(group.id) && group.activeInput ? [group.activeInput] : []);
		if (state.isModalEditorVisible && this.editorPart.activeInput) editors.unshift(this.editorPart.activeInput);
		return Object.freeze(editors);
	}

	get groups(): readonly IEditorGroup[] {
		return this.editorPart.groups;
	}

	get activeGroup(): IEditorGroup {
		return this.editorPart.activeGroup;
	}

	getGroup(id: EditorGroupId): IEditorGroup | undefined {
		return this.editorPart.groups.find(group => group.id === id);
	}

	public findGroup(scope: IFindGroupScope, source?: IEditorGroup): IEditorGroup | undefined {
		return this.editorPart.findGroup(scope, source);
	}

	get count(): number {
		return this.groups.length;
	}

	async openEditor(input: IResourceEditorInput, options?: EditorOpenOptions, target?: EditorOpenTarget): Promise<void> {
		try {
			await this.editorPart.openEditor(input, options, target);
		} catch (error) {
			// Resource navigation can be replaced or closed while its pane loads.
			// The part retains its rejection contract; UI callers need no error or focus change.
			if (isCancellationError(error) && !options?.ignoreError) return;
			throw error;
		}
		if (options?.preserveFocus !== true) this.editorPart.focus();
	}

	focusActiveEditor(): void {
		this.editorPart.focus();
	}

	private publishState(event: EditorPartChangeEvent): void {
		if (event.kind === 'groupAdded') this.groupAddEmitter.fire(event.group);
		else if (event.kind === 'groupRemoved') this.groupRemoveEmitter.fire(event.groupId);
		else if (event.kind === 'activeGroupChanged') this.groupActivateEmitter.fire(this.activeGroup.getEditorState());
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
			if (!this.editorPart.isGroupVisible(group.id)) return [];
			const groupState = group.getEditorState();
			const active = groupState.editors.find(editor => editor.instanceId === groupState.activeEditorInstanceId);
			return active ? [`${active.instanceId}:${active.paneId}`] : [];
		});
		if (state.isModalEditorVisible) visible.unshift(`modal:${editorInputSignature(this.editorPart.activeInput)}`);
		return visible.join('\0');
	}
}

function editorInputSignature(input: IResourceEditorInput | undefined): string {
	return input ? `${input.resource.toString()}\0${input.contentType ?? ''}\0${input.languageId ?? ''}` : '';
}
