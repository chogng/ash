import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import { canceled, onUnexpectedError } from '../../../../base/common/errors.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorGroupsService, GroupDirection } from '../../../services/editor/common/editorGroupsService.js';
import { ITerminalService, type ITerminalEditorService, type ITerminalInstance, type ICreateTerminalOptions } from './terminal.js';
import { TerminalEditorInput } from './terminalEditorInput.js';
import { getInstanceFromResource } from './terminalUri.js';

/** Coordinates editor membership while leaving terminal state with its original owner. */
export class TerminalEditorService extends Disposable implements ITerminalEditorService {
	private readonly groups = this._register(new DisposableMap<number, DisposableStore>());
	private readonly backgroundOpens = new Map<ITerminalInstance, number>();

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
				const instance = (input.activeResource && this.getInstanceFromResource(input.activeResource))
					?? input.panes.get().map(pane => this.getInstanceFromResource(pane.resource)).find(Boolean);
				if (instance && !this.backgroundOpens.has(instance)) terminals.setActiveInstance(instance);
			}
		}));
		this._register(terminals.onDidDisposeInstance(instance => { void this.detachInstance(instance).catch(onUnexpectedError); }));
	}

	getInstanceFromResource(resource: URI): ITerminalInstance | undefined { return getInstanceFromResource(this.terminals.instances, resource); }

	async openEditor(instance: ITerminalInstance, editorOptions?: import('./terminal.js').TerminalEditorLocation): Promise<void> {
		if (!this.terminals.instances.includes(instance) || !instance.resource) return;
		const resource = instance.resource;
		const existing = this.editorGroups.groups.flatMap(group => group.inputs)
			.find((input): input is TerminalEditorInput => input instanceof TerminalEditorInput
				&& (input.contains(resource) || input.resource.path === resource.path));
		// The tab keeps its original identity even when that shell moves to the panel.
		const returningPane = existing && !existing.contains(resource) ? existing : undefined;
		const previousTarget = instance.target;
		instance.target = TerminalLocation.Editor;
		if (editorOptions?.preserveFocus) {
			// Opening in the current group can change its selected editor while the
			// keyboard remains in the panel. That notification must not redirect input.
			this.backgroundOpens.set(instance, (this.backgroundOpens.get(instance) ?? 0) + 1);
		}
		try {
			returningPane?.addPane(resource, returningPane.panes.get());
			if (existing && !editorOptions?.preserveFocus) existing.activeResource = resource;
			await this.editors.openEditor(existing ?? new TerminalEditorInput(resource, instance, this.terminals.onDidChangeInstances), { pinned: true, ignoreError: true, preserveFocus: editorOptions?.preserveFocus, ...(existing ? { revealIfOpened: true } : {}) }, editorOptions?.viewColumn === undefined ? undefined : { groupId: editorOptions.viewColumn });
			if (!editorOptions?.preserveFocus && this.terminals.instances.includes(instance)) this.terminals.setActiveInstance(instance);
		} catch (error) {
			returningPane?.removePane(resource);
			if (this.terminals.instances.includes(instance)) instance.target = previousTarget;
			throw error;
		} finally {
			if (editorOptions?.preserveFocus) {
				const pending = this.backgroundOpens.get(instance)! - 1;
				if (pending) this.backgroundOpens.set(instance, pending);
				else this.backgroundOpens.delete(instance);
			}
		}
	}

	async detachInstance(instance: ITerminalInstance): Promise<void> {
		const resource = instance.resource;
		if (!resource) return;
		for (const group of this.editorGroups.groups) {
			for (const input of [...group.inputs]) {
				if (!(input instanceof TerminalEditorInput) || !input.contains(resource)) continue;
				if (input.panes.get().some(pane => pane.resource.path !== resource.path && this.getInstanceFromResource(pane.resource))) {
					input.removePane(resource);
				} else {
					await group.closeEditor(input, { skipConfirmation: true, reason: 'move' });
				}
			}
		}
	}

	async splitPane(input: TerminalEditorInput, preserveFocus: boolean): Promise<void> {
		const instance = await this.terminals.createTerminal({
			location: TerminalLocation.Editor,
			deferEditorOpen: true,
			skipContributedProfileCheck: true,
		});
		if (this.isDisposed || !instance.resource || !this.terminals.instances.includes(instance)
			|| !this.editorGroups.groups.some(group => group.inputs.includes(input))) {
			await this.terminals.closeTerminal(instance);
			throw canceled();
		}
		const resource = instance.resource;
		const livePanes = input.panes.get().filter(pane => this.getInstanceFromResource(pane.resource));
		input.addPane(resource, livePanes);
		const active = this.editors.activeEditorPane;
		if (!preserveFocus && this.editors.activeEditor === input && active) {
			input.activeResource = resource;
			active.focus();
		}
	}

	async splitInstance(instanceToSplit: ITerminalInstance, shellLaunchConfig?: ICreateTerminalOptions['config']): Promise<ITerminalInstance> {
		const resource = instanceToSplit.resource;
		const source = resource && this.editorGroups.groups.find(group => group.inputs.some(input => input instanceof TerminalEditorInput && input.contains(resource)));
		if (!source || instanceToSplit.target !== TerminalLocation.Editor || instanceToSplit.state !== 'running' || instanceToSplit.isReadOnly || !this.terminals.instances.includes(instanceToSplit)) throw canceled();
		using lifetime = new DisposableStore();
		let retired = false;
		lifetime.add(instanceToSplit.onDidChangeState(() => retired = true));
		if (instanceToSplit.onDidChangeTarget) lifetime.add(instanceToSplit.onDidChangeTarget(() => retired = true));
		// Capture the source group before profile resolution can activate another editor.
		const destination = this.editorGroups.addGroup(source, GroupDirection.RIGHT);
		let created: ITerminalInstance | undefined;
		try {
			created = await this.terminals.createTerminal({
				config: shellLaunchConfig ?? instanceToSplit.shellLaunchConfig,
				location: { parentTerminal: instanceToSplit, viewColumn: destination.id },
			});
			if (this.isDisposed || retired || !this.terminals.instances.includes(instanceToSplit) || !this.editorGroups.getGroup(source.id)?.inputs.some(input => input instanceof TerminalEditorInput && input.contains(resource))) throw canceled();
			return created;
		} catch (error) {
			if (created && this.terminals.instances.includes(created)) await this.terminals.closeTerminal(created);
			if (this.editorGroups.getGroup(destination.id)?.inputs.length === 0) await this.editorGroups.removeGroup(destination);
			throw error;
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
		for (const { resource } of input.panes.get()) {
			const instance = this.getInstanceFromResource(resource);
			if (instance?.target !== TerminalLocation.Editor) continue;
			if (this.editorGroups.groups.some(group => group.inputs.some(other => other instanceof TerminalEditorInput && other.contains(resource)))) continue;
			void this.terminals.closeTerminal(instance).catch(onUnexpectedError);
		}
	}
}
