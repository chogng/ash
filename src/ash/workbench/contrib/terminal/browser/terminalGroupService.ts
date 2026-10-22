import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { ITerminalService, type ITerminalGroup, type ITerminalGroupService, type ITerminalInstance, type ITerminalView } from './terminal.js';
import { TERMINAL_VIEW_ID } from '../common/terminal.js';
import { TerminalGroup } from './terminalGroup.js';

/** Owns panel membership and retains panel selection while an editor terminal has focus. */
export class TerminalGroupService extends Disposable implements ITerminalGroupService {
	private readonly instanceLifetimes = this._register(new DisposableMap<ITerminalInstance, DisposableStore>());
	private readonly groupLifetimes = this._register(new DisposableMap<ITerminalGroup, DisposableStore>());
	private readonly recentGroups: ITerminalGroup[] = [];
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChangeGroups = this.changed.event;

	constructor(
		@ITerminalService private readonly terminals: ITerminalService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IViewsService private readonly views: IViewsService,
	) {
		super();
		this._register(toDisposable(() => { this.recentGroups.length = 0; }));
		for (const instance of terminals.instances) this.observeInstance(instance);
		this.rememberActiveGroup();
		this._register(terminals.onDidChangeActiveInstance(() => this.rememberActiveGroup()));
		this._register(terminals.onDidCreateInstance(instance => this.observeInstance(instance)));
		this._register(terminals.onDidDisposeInstance(instance => {
			this.instanceLifetimes.deleteAndDispose(instance);
			const group = this.getGroupForInstance(instance);
			if (group) group.removeInstance(instance);
		}));
	}

	private observeInstance(instance: ITerminalInstance): void {
		const lifetime = new DisposableStore();
		const update = (): void => {
			if (instance.target === TerminalLocation.Editor) this.getGroupForInstance(instance)?.removeInstance(instance);
			else this.createGroup(instance);
		};
		if (instance.onDidChangeTarget) lifetime.add(instance.onDidChangeTarget(update));
		this.instanceLifetimes.set(instance, lifetime);
		update();
	}

	get groups(): readonly ITerminalGroup[] { return [...this.groupLifetimes.keys()]; }
	get activeGroup(): ITerminalGroup | undefined {
		const active = this.terminals.activeInstance;
		return (active && this.getGroupForInstance(active)) ?? this.recentGroups[0] ?? this.groups[0];
	}

	createGroup(instance: ITerminalInstance): ITerminalGroup {
		if (instance.target === TerminalLocation.Editor) throw new Error('Editor terminals do not belong to a panel group');
		const existing = this.getGroupForInstance(instance);
		if (existing) return existing;
		const lifetime = new DisposableStore();
		const group = lifetime.add(this.instantiation.createInstance(TerminalGroup, instance));
		this.groupLifetimes.set(group, lifetime);
		lifetime.add(group.onInstancesChanged(() => {
			if (!group.terminalInstances.length) {
				const index = this.recentGroups.indexOf(group);
				if (index >= 0) this.recentGroups.splice(index, 1);
				this.groupLifetimes.deleteAndDispose(group);
			}
			this.rememberActiveGroup();
			this.changed.fire();
		}));
		this.changed.fire();
		return group;
	}

	private rememberActiveGroup(): void {
		const active = this.terminals.activeInstance;
		const group = active && this.getGroupForInstance(active);
		if (!group) return;
		const index = this.recentGroups.indexOf(group);
		if (index >= 0) this.recentGroups.splice(index, 1);
		this.recentGroups.unshift(group);
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

	moveInstance(source: ITerminalInstance, target: ITerminalInstance, side: 'before' | 'after'): void {
		if (source === target || !this.terminals.instances.includes(source) || !this.terminals.instances.includes(target)) return;
		const sourceGroup = this.getGroupForInstance(source);
		const targetGroup = this.getGroupForInstance(target);
		if (!sourceGroup || !targetGroup) return;
		if (sourceGroup !== targetGroup) {
			sourceGroup.removeInstance(source);
			targetGroup.addInstance(source);
		}
		targetGroup.moveInstance(source, targetGroup.terminalInstances.indexOf(target), side);
		const sourceIndex = this.terminals.instances.indexOf(source);
		const insertion = this.terminals.instances.indexOf(target) + (side === 'after' ? 1 : 0);
		this.terminals.moveTerminal(source, insertion > sourceIndex ? insertion - 1 : insertion);
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

	async focusHover(): Promise<void> {
		if (!this.activeGroup?.activeInstance) return;
		const view = await this.views.openView<ITerminalView>(TERMINAL_VIEW_ID, false);
		view?.focusHover();
	}
}
