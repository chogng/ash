import { CancellationError } from '../../../../base/common/errors.js';
import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { ITerminalProcessService, type TerminalProcessConnectionState } from "../../../../platform/terminal/common/terminal.js";
import { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import type { ITerminalCreateOptions, ITerminalDimensions, ITerminalInstance, ITerminalProfile, ITerminalService } from "../../../services/terminal/browser/terminal.js";
import { TerminalInstance } from './terminalInstance.js';
import { TerminalInstanceService } from './terminalInstanceService.js';

/** Browser Workbench owner of terminal instances and their process lifecycle. */
export class TerminalService extends Disposable implements ITerminalService {
	private readonly processService: ITerminalProcessService;
	private readonly _instances: TerminalInstance[] = [];
	private readonly _onDidCreateInstance = this._register(new Emitter<ITerminalInstance>());
	private readonly _onDidDisposeInstance = this._register(new Emitter<ITerminalInstance>());
	private readonly _onDidChangeInstances = this._register(new Emitter<void>());
	private readonly _onDidChangeActiveInstance = this._register(new Emitter<ITerminalInstance | undefined>());
	private readonly ownedInstances = this._register(new DisposableMap<string, TerminalInstance>());
	private _activeInstance: TerminalInstance | undefined;
	private readonly instanceFactory: TerminalInstanceService;
	private get connectionState(): TerminalProcessConnectionState { return this.instanceFactory.backend.connectionState; }

	readonly onDidCreateInstance: Event<ITerminalInstance> = this._onDidCreateInstance.event;
	readonly onDidDisposeInstance: Event<ITerminalInstance> = this._onDidDisposeInstance.event;
	readonly onDidChangeInstances: Event<void> = this._onDidChangeInstances.event;
	readonly onDidChangeActiveInstance: Event<ITerminalInstance | undefined> = this._onDidChangeActiveInstance.event;

	constructor(@ITerminalProcessService processService: ITerminalProcessService, @IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService, @IInstantiationService private readonly instantiationService: IInstantiationService) {
		super();
		this.processService = processService;
		this.instanceFactory = this._register(instantiationService.createInstance(TerminalInstanceService));
		this._register(this.instanceFactory.backend.onDidChangeConnectionState(state => this.setConnectionState(state)));
	}

	protected override disposeCore(): void {
		this._instances.length = 0;
		this._activeInstance = undefined;
		super.disposeCore();
	}

	get instances(): readonly ITerminalInstance[] {
		return this._instances;
	}

	get activeInstance(): ITerminalInstance | undefined {
		return this._activeInstance;
	}

	async getProfiles(): Promise<readonly ITerminalProfile[]> {
		const folder = this.requireWorkspaceFolder();
		return this.processService.listProfiles(this.workspaceContext.getWorkspace().folders.length > 1 || folder.id.startsWith('session:') ? folder.id : undefined);
	}

	async createTerminal(options: ITerminalCreateOptions): Promise<ITerminalInstance> {
		if (this.isDisposed) throw new CancellationError();
		const instance = await this.instanceFactory.createInstance(options, {
			getConnectionState: () => this.connectionState,
			onClosed: instance => this.removeInstance(instance),
			onTitleChanged: () => { this.refreshInstanceTitles(); this._onDidChangeInstances.fire(); },
		});
		if (this.isDisposed) { await instance.close(); throw new CancellationError(); }
		this.ownedInstances.set(instance.id, instance);
		this._instances.push(instance);
		try { instance.prepareCustomProcess(); }
		catch (error) { instance.dispose(); throw error; }
		this.refreshInstanceTitles();
		if (options.deferStart && this.connectionState !== 'ready') instance.loseConnection();
		this._onDidCreateInstance.fire(instance);
		if (this.isDisposed || !this._instances.includes(instance)) throw new CancellationError();
		this.setActiveInstance(instance);
		if (!options.deferStart) instance.start();
		this._onDidChangeInstances.fire();
		return instance;
	}

	async relaunchTerminal(instance: ITerminalInstance, dimensions: ITerminalDimensions): Promise<void> {
		if (!instance.isReadOnly) {
			this.requireWorkspaceFolder();
		}
		if (!this._instances.includes(instance as TerminalInstance)) {
			throw new Error("Terminal must belong to this TerminalService");
		}
		await (instance as TerminalInstance).relaunch(dimensions);
	}

	setActiveInstance(instance: ITerminalInstance | undefined): void {
		if (instance !== undefined && !this._instances.includes(instance as TerminalInstance)) {
			throw new Error("Active terminal must belong to this TerminalService");
		}
		if (this._activeInstance === instance) return;
		this._activeInstance = instance as TerminalInstance | undefined;
		this._onDidChangeActiveInstance.fire(instance);
	}

	moveTerminal(instance: ITerminalInstance, targetIndex: number): void {
		const currentIndex = this._instances.indexOf(instance as TerminalInstance);
		if (currentIndex < 0) {
			throw new Error("Terminal must belong to this TerminalService");
		}
		this._instances.splice(currentIndex, 1);
		const insertionIndex = Math.min(Math.max(0, targetIndex), this._instances.length);
		this._instances.splice(insertionIndex, 0, instance as TerminalInstance);
		this.refreshInstanceTitles();
		this._onDidChangeInstances.fire();
	}

	async closeTerminal(instance: ITerminalInstance): Promise<void> {
		if (!this._instances.includes(instance as TerminalInstance)) return;
		await instance.close();
	}

	private removeInstance(instance: TerminalInstance): void {
		const index = this._instances.indexOf(instance);
		if (index < 0) return;
		const activeChanged = this._activeInstance === instance;
		this._instances.splice(index, 1);
		// The instance is already disposing; remove the window's reference to it.
		this.ownedInstances.deleteAndLeak(instance.id);
		if (activeChanged) {
			this._activeInstance = this._instances.at(-1);
		}
		this.refreshInstanceTitles();
		this._onDidDisposeInstance.fire(instance);
		if (activeChanged) {
			this._onDidChangeActiveInstance.fire(this._activeInstance);
		}
		this._onDidChangeInstances.fire();
	}

	private refreshInstanceTitles(): void {
		const instancesByProfile = new Map<string, TerminalInstance[]>();
		for (const instance of this._instances) {
			if (instance.isReadOnly) {
				continue;
			}
			const profileInstances = instancesByProfile.get(instance.profile.profileId) ?? [];
			profileInstances.push(instance);
			instancesByProfile.set(instance.profile.profileId, profileInstances);
		}
		for (const profileInstances of instancesByProfile.values()) {
			const baseTitle = terminalProfileTitle(profileInstances[0].profile);
			for (const [index, instance] of profileInstances.entries()) {
				instance.setTitle(instance.customTitle ?? (profileInstances.length === 1 ? baseTitle : `${baseTitle} ${index + 1}`));
			}
		}
	}

	private setConnectionState(state: TerminalProcessConnectionState): void {
		if (state === "ready") {
			for (const instance of this._instances) instance.restoreConnection();
			return;
		}
		for (const instance of this._instances) {
			instance.loseConnection();
		}
	}

	private requireWorkspaceFolder(dirId?: string) {
		const folders = this.workspaceContext.getWorkspace().folders;
		const folder = dirId ? folders.find(folder => folder.id === dirId) : folders[0];
		if (!folder) throw new Error("TerminalUnavailable: Terminal requires an open workspace folder");
		return folder;
	}
}

function terminalProfileTitle(profile: ITerminalProfile): string {
	if (profile.profileId === "cmd" || profile.profileId === "command-prompt") {
		return "cmd";
	}
	return profile.title;
}
