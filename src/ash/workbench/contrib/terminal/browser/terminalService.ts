import { CancellationError, onUnexpectedError } from '../../../../base/common/errors.js';
import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { ITerminalProcessService, type TerminalProcessConnectionState } from "../../../../platform/terminal/common/terminal.js";
import { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import type { ITerminalCreateOptions, ITerminalDimensions, ITerminalInstance, ITerminalProfile, ITerminalService } from "../../../services/terminal/browser/terminal.js";
import { TerminalInstance } from './terminalInstance.js';
import { TerminalInstanceService } from './terminalInstanceService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ProcessPropertyType, TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { localize } from '../../../../nls.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { parseTerminalReloadCredentials, parseTerminalReloadState, TerminalStorageKeys } from '../common/terminalStorageKeys.js';
import { terminalExecutionScope, terminalExecutionScopesEqual } from '../common/remote/terminal.js';
import { parseTerminalUri } from './terminalUri.js';
import { URI } from '../../../../base/common/uri.js';

/** Browser Workbench owner of terminal instances and their process lifecycle. */
export class TerminalService extends Disposable implements ITerminalService {
	readonly whenConnected: Promise<void>;
	private connected = false;
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

	constructor(@ITerminalProcessService processService: ITerminalProcessService, @IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService, @IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IDialogService private readonly dialogs: IDialogService,
		@ISecretStorageService private readonly secrets: ISecretStorageService,
		@IStorageService private readonly storage: IStorageService,
	) {
		super();
		this.processService = processService;
		this.instanceFactory = this._register(instantiationService.createInstance(TerminalInstanceService));
		this._register(this.instanceFactory.backend.onDidChangeConnectionState(state => this.setConnectionState(state)));
		this.whenConnected = this.restoreTerminals().catch(error => {
			console.error('Terminal reload recovery failed', error);
			onUnexpectedError(new Error(localize('terminal.reload.failed', 'Could not restore terminal sessions after reload.'), { cause: error }));
		}).finally(() => { this.connected = true; });
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
		if (!this.connected) {
			const scope = terminalExecutionScope(this.workspaceContext.getWorkspace());
			await this.whenConnected;
			if (!terminalExecutionScopesEqual(scope, terminalExecutionScope(this.workspaceContext.getWorkspace()))) throw new CancellationError();
		}
		return this.createTerminalCore(options);
	}

	private async restoreTerminals(): Promise<void> {
		const encoded = await this.secrets.get(TerminalStorageKeys.Reload);
		if (!encoded || this.isDisposed) return;
		const credentials = parseTerminalReloadCredentials(encoded);
		if (credentials.expiresAt < Date.now()) return;
		const text = this.storage.get(credentials.stateKey, StorageScope.WORKSPACE);
		if (!text) throw new Error('Terminal checkpoint is missing');
		const state = parseTerminalReloadState(text);
		const scope = terminalExecutionScope(this.workspaceContext.getWorkspace());
		if (scope.workspaceId !== state.workspaceId || scope.remoteAuthority !== state.remoteAuthority) throw new Error('Terminal checkpoint belongs to another workspace or host');
		// Validate the complete checkpoint before any bearer credential attaches a process.
		for (const snapshot of state.instances) {
			if (parseTerminalUri(URI.parse(snapshot.resource)).instanceId !== snapshot.instanceId || !this.workspaceContext.getWorkspace().folders.some(folder => folder.id === snapshot.dirId)) throw new TypeError('Invalid terminal checkpoint identity');
		}
		if (!this.processService.attach) throw new Error('Terminal attachment is unavailable');
		const screens: Promise<unknown>[] = [];
		for (const snapshot of state.instances) {
			if (this.isDisposed) throw new CancellationError();
			const lease = credentials.leases.find(candidate => candidate.terminalId === snapshot.process.terminalId && candidate.dirId === snapshot.processDirId);
			if (!lease) throw new Error('Terminal recovery credential is missing');
			const dimensions = { rows: snapshot.rows, cols: snapshot.cols };
			const process = await this.processService.attach(lease, dimensions, snapshot.process.profile);
			if (process.ready.pid !== snapshot.process.ready.pid) throw new Error('Terminal process identity changed');
			const instance = await this.createTerminalCore({
				dirId: snapshot.dirId, dimensions, profile: { type: 'profile', profileId: snapshot.process.profile.profileId }, title: snapshot.customTitle ?? snapshot.title,
				attachPersistentProcess: { state: snapshot, process }, deferStart: true
			});
			screens.push(instance.xtermReadyPromise);
		}
		await Promise.all(screens);
		this.setActiveInstance(this._instances.find(instance => instance.instanceId === state.activeId));
	}

	private async createTerminalCore(options: ITerminalCreateOptions): Promise<ITerminalInstance> {
		if (this.isDisposed) throw new CancellationError();
		const instance = await this.instanceFactory.createInstance(options, {
			getConnectionState: () => this.connectionState,
			onClosed: instance => this.removeInstance(instance),
			onTitleChanged: () => { this.refreshInstanceTitles(); this._onDidChangeInstances.fire(); },
		});
		if (this.isDisposed) { await instance.close(); throw new CancellationError(); }
		this.ownedInstances.set(instance.id, instance);
		this._instances.push(instance);
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

	async safeDisposeTerminal(instance: ITerminalInstance): Promise<void> {
		if (!this._instances.includes(instance as TerminalInstance)) return;
		const policy = this.configuration.getValue<string>('terminal.integrated.confirmOnKill') ?? 'editor';
		const confirm = policy === 'always' || policy === (instance.target === TerminalLocation.Editor ? 'editor' : 'panel');
		if (confirm && await instance.refreshProperty(ProcessPropertyType.HasChildProcesses).catch(() => true)) {
			const result = await this.dialogs.confirm({
				message: localize('terminal.confirmKill', 'Terminate the running processes in “{0}”?', instance.title),
				detail: localize('terminal.confirmKillDetail', 'Closing this terminal will stop its shell and child processes.'),
				primaryButton: localize('terminal.terminate', 'Terminate'),
			});
			if (!result.confirmed) return;
		}
		await this.closeTerminal(instance);
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
	if (['zsh', 'bash', 'fish', 'sh'].includes(profile.profileId)) return profile.profileId;
	if (profile.profileId === 'powershell') return 'pwsh';
	if (profile.profileId === 'windows-powershell') return 'powershell';
	if (profile.profileId === 'git-bash') return 'bash';
	if (profile.profileId === "cmd" || profile.profileId === "command-prompt") {
		return "cmd";
	}
	return profile.title;
}
