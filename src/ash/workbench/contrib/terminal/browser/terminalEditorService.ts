import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import { canceled, onUnexpectedError } from '../../../../base/common/errors.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorGroupsService, GroupDirection } from '../../../services/editor/common/editorGroupsService.js';
import {
	ITerminalService,
	type ITerminalEditorService,
	type ITerminalInstance,
	type ICreateTerminalOptions,
} from './terminal.js';
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
		this._register(
			editors.onDidActiveEditorChange(() => {
				const input = editors.activeEditor;
				if (input instanceof TerminalEditorInput) {
					const instance = this.getInstanceFromResource(input.resource);
					if (instance && !this.backgroundOpens.has(instance)) terminals.setActiveInstance(instance);
				}
			}),
		);
		this._register(
			terminals.onDidDisposeInstance(instance => {
				void this.detachInstance(instance).catch(onUnexpectedError);
			}),
		);
	}

	getInstanceFromResource(resource: URI): ITerminalInstance | undefined {
		return getInstanceFromResource(this.terminals.instances, resource);
	}

	async openEditor(
		instance: ITerminalInstance,
		editorOptions?: import('./terminal.js').TerminalEditorLocation,
	): Promise<void> {
		if (!this.terminals.instances.includes(instance) || !instance.resource) return;
		const previousTarget = instance.target;
		instance.target = TerminalLocation.Editor;
		if (editorOptions?.preserveFocus) {
			// Opening in the current group can change its selected editor while the
			// keyboard remains in the panel. That notification must not redirect input.
			this.backgroundOpens.set(instance, (this.backgroundOpens.get(instance) ?? 0) + 1);
		}
		try {
			await this.editors.openEditor(
				new TerminalEditorInput(instance.resource, instance, this.terminals.onDidChangeInstances),
				{ pinned: true, ignoreError: true, preserveFocus: editorOptions?.preserveFocus },
				editorOptions?.viewColumn === undefined ? undefined : { groupId: editorOptions.viewColumn },
			);
			if (!editorOptions?.preserveFocus && this.terminals.instances.includes(instance))
				this.terminals.setActiveInstance(instance);
		} catch (error) {
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
		for (const group of this.editorGroups.groups) {
			for (const input of [...group.inputs]) {
				if (input instanceof TerminalEditorInput && input.resource.path === instance.resource?.path) {
					await group.closeEditor(input, { skipConfirmation: true, reason: 'move' });
				}
			}
		}
	}

	async splitInstance(
		instanceToSplit: ITerminalInstance,
		shellLaunchConfig?: ICreateTerminalOptions['config'],
	): Promise<ITerminalInstance> {
		const source = this.editorGroups.groups.find(group =>
			group.inputs.some(
				input => input instanceof TerminalEditorInput && input.resource.path === instanceToSplit.resource?.path,
			),
		);
		if (
			!source ||
			instanceToSplit.target !== TerminalLocation.Editor ||
			instanceToSplit.state !== 'running' ||
			instanceToSplit.isReadOnly ||
			!this.terminals.instances.includes(instanceToSplit)
		)
			throw canceled();
		using lifetime = new DisposableStore();
		let retired = false;
		lifetime.add(instanceToSplit.onDidChangeState(() => (retired = true)));
		if (instanceToSplit.onDidChangeTarget) lifetime.add(instanceToSplit.onDidChangeTarget(() => (retired = true)));
		// Capture the source group before profile resolution can activate another editor.
		const destination = this.editorGroups.addGroup(source, GroupDirection.RIGHT);
		let created: ITerminalInstance | undefined;
		try {
			created = await this.terminals.createTerminal({
				config: shellLaunchConfig ?? instanceToSplit.shellLaunchConfig,
				location: { parentTerminal: instanceToSplit, viewColumn: destination.id },
			});
			if (
				this.isDisposed ||
				retired ||
				!this.terminals.instances.includes(instanceToSplit) ||
				!this.editorGroups
					.getGroup(source.id)
					?.inputs.some(
						input =>
							input instanceof TerminalEditorInput &&
							input.resource.path === instanceToSplit.resource?.path,
					)
			)
				throw canceled();
			return created;
		} catch (error) {
			if (created && this.terminals.instances.includes(created)) await this.terminals.closeTerminal(created);
			if (this.editorGroups.getGroup(destination.id)?.inputs.length === 0)
				await this.editorGroups.removeGroup(destination);
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
				lifetime.add(
					group.onDidChangeEditors(event => {
						if (
							event.kind === 'editorClosed' &&
							event.reason !== 'move' &&
							event.editor.input instanceof TerminalEditorInput
						) {
							this.closeTerminalIfUnhosted(event.editor.input);
						}
					}),
				);
				this.groups.set(group.id, lifetime);
			}
		}
	}

	private closeTerminalIfUnhosted(input: TerminalEditorInput): void {
		const instance = this.getInstanceFromResource(input.resource);
		if (!instance || instance.target !== TerminalLocation.Editor) return;
		if (
			this.editorGroups.groups.some(group =>
				group.inputs.some(
					other => other.resource.path === input.resource.path && other.editorId === TerminalEditorInput.ID,
				),
			)
		)
			return;
		void this.terminals.closeTerminal(instance).catch(onUnexpectedError);
	}
}
