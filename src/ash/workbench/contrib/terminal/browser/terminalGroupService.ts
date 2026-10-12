import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { ITerminalService, type ITerminalGroup, type ITerminalGroupService, type ITerminalInstance } from '../../../services/terminal/browser/terminal.js';
import { TERMINAL_VIEW_ID } from '../common/terminal.js';
import { TerminalGroup } from './terminalGroup.js';

/** Owns panel membership, deriving active selection from the window's TerminalService. */
export class TerminalGroupService extends Disposable implements ITerminalGroupService {
	private readonly groupLifetimes = this._register(new DisposableMap<ITerminalGroup, DisposableStore>());
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChangeGroups = this.changed.event;

	constructor(
		@ITerminalService private readonly terminals: ITerminalService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IViewsService private readonly views: IViewsService,
	) {
		super();
		for (const instance of terminals.instances) this.createGroup(instance);
		this._register(terminals.onDidCreateInstance(instance => this.createGroup(instance)));
		this._register(terminals.onDidDisposeInstance(instance => {
			const group = this.getGroupForInstance(instance);
			if (group) group.removeInstance(instance);
		}));
	}

	get groups(): readonly ITerminalGroup[] { return [...this.groupLifetimes.keys()]; }
	get activeGroup(): ITerminalGroup | undefined {
		return this.terminals.activeInstance ? this.getGroupForInstance(this.terminals.activeInstance) : undefined;
	}

	createGroup(instance: ITerminalInstance): ITerminalGroup {
		const existing = this.getGroupForInstance(instance);
		if (existing) return existing;
		const lifetime = new DisposableStore();
		const group = lifetime.add(this.instantiation.createInstance(TerminalGroup, instance));
		this.groupLifetimes.set(group, lifetime);
		lifetime.add(group.onInstancesChanged(() => {
			if (!group.terminalInstances.length) this.groupLifetimes.deleteAndDispose(group);
			this.changed.fire();
		}));
		this.changed.fire();
		return group;
	}

	getGroupForInstance(instance: ITerminalInstance): ITerminalGroup | undefined {
		return this.groups.find(group => group.terminalInstances.includes(instance));
	}

	joinInstances(instances: readonly ITerminalInstance[]): void {
		const members = [...new Set(instances)].filter(instance => this.terminals.instances.includes(instance));
		const target = members[0] && this.getGroupForInstance(members[0]);
		if (!target) return;
		for (const instance of members.slice(1)) {
			const source = this.getGroupForInstance(instance);
			if (!source || source === target) continue;
			source.removeInstance(instance);
			target.addInstance(instance);
		}
	}

	unsplitInstance(instance: ITerminalInstance): void {
		const group = this.getGroupForInstance(instance);
		if (!group || group.terminalInstances.length < 2) return;
		group.removeInstance(instance);
		this.createGroup(instance);
	}

	instanceIsSplit(instance: ITerminalInstance): boolean {
		return (this.getGroupForInstance(instance)?.terminalInstances.length ?? 0) > 1;
	}

	setActiveInstanceByIndex(index: number): void {
		const instance = this.groups.flatMap(group => group.terminalInstances)[index];
		if (instance) this.terminals.setActiveInstance(instance);
	}

	async showPanel(focus = false): Promise<void> {
		await this.views.openView(TERMINAL_VIEW_ID, focus);
		if (focus) this.terminals.activeInstance?.xterm?.focus();
	}
}
