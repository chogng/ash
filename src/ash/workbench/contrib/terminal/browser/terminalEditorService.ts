import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { ITerminalService, type ITerminalEditorService, type ITerminalInstance } from '../../../services/terminal/browser/terminal.js';
import { TerminalEditorInput } from './terminalEditorInput.js';
import { getInstanceFromResource } from './terminalUri.js';

/** Coordinates editor membership while leaving terminal state with its original owner. */
export class TerminalEditorService extends Disposable implements ITerminalEditorService {
	private readonly groups = this._register(new DisposableMap<string, DisposableStore>());

	constructor(
		@ITerminalService private readonly terminals: ITerminalService,
		@IEditorService private readonly editors: IEditorService,
		@IEditorGroupsService private readonly editorGroups: IEditorGroupsService,
	) {
		super();
		this.observeGroups();
		this._register(editorGroups.onDidChangeGroups(() => this.observeGroups()));
		this._register(editors.onDidActiveEditorChange(() => {
			const input = editors.activeEditor;
			if (input instanceof TerminalEditorInput) {
				const instance = this.getInstanceFromResource(input.resource);
				if (instance) terminals.setActiveInstance(instance);
			}
		}));
		this._register(terminals.onDidDisposeInstance(instance => { void this.detachInstance(instance).catch(onUnexpectedError); }));
	}

	getInstanceFromResource(resource: URI): ITerminalInstance | undefined { return getInstanceFromResource(this.terminals.instances, resource); }

	async openEditor(instance: ITerminalInstance): Promise<void> {
		if (!this.terminals.instances.includes(instance) || !instance.resource) return;
		const previousTarget = instance.target;
		instance.target = TerminalLocation.Editor;
		try {
			await this.editors.openEditor(new TerminalEditorInput(instance.resource, instance, this.terminals.onDidChangeInstances), { pinned: true, ignoreError: true });
			if (this.terminals.instances.includes(instance)) this.terminals.setActiveInstance(instance);
		} catch (error) {
			if (this.terminals.instances.includes(instance)) instance.target = previousTarget;
			throw error;
		}
	}

	async detachInstance(instance: ITerminalInstance): Promise<void> {
		for (const group of this.editorGroups.groups) {
			for (const input of [...group.inputs]) {
				if (input instanceof TerminalEditorInput && input.resource.path === instance.resource?.path) {
					await group.closeEditor(input, { skipConfirmation: true, reason: 'move' });
				}
			}
		}
	}

	private observeGroups(): void {
		for (const id of this.groups.keys()) {
			if (!this.editorGroups.getGroup(id)) this.groups.deleteAndDispose(id);
		}
		for (const group of this.editorGroups.groups) {
			if (!this.groups.has(group.id)) {
				const lifetime = new DisposableStore();
				lifetime.add(group.onDidChangeEditors(event => {
					if (event.kind === 'editorClosed' && event.reason !== 'move' && event.editor.input instanceof TerminalEditorInput) {
						this.closeTerminalIfUnhosted(event.editor.input);
					}
				}));
				this.groups.set(group.id, lifetime);
			}
		}
	}

	private closeTerminalIfUnhosted(input: TerminalEditorInput): void {
		const instance = this.getInstanceFromResource(input.resource);
		if (!instance || instance.target !== TerminalLocation.Editor) return;
		if (this.editorGroups.groups.some(group => group.inputs.some(other => other.resource.path === input.resource.path && other.editorId === TerminalEditorInput.ID))) return;
		void this.terminals.closeTerminal(instance).catch(onUnexpectedError);
	}
}
