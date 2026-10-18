import { CancellationError, onUnexpectedError } from '../../../../base/common/errors.js';
import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { ITerminalProcessService, type TerminalProcessConnectionState } from "../../../../platform/terminal/common/terminal.js";
import { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { ITerminalEditorService, ITerminalGroupService, type ICreateTerminalOptions, type ITerminalCreateOptions, type ITerminalDimensions, type ITerminalInstance, type ITerminalProfile, type ITerminalService, type ITerminalLocationOptions } from './terminal.js';
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
import { ITerminalProfileResolverService, ITerminalProfileService } from '../common/terminal.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { PICK_WORKSPACE_FOLDER_COMMAND_ID } from '../../../browser/actions/workspaceCommands.js';
import type { IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import type { IShellLaunchConfig } from '../../../../platform/terminal/common/terminal.js';
import { TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { getRemoteAuthority } from '../../../../platform/remote/common/remoteHosts.js';

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
		@ITerminalProfileService private readonly profiles: ITerminalProfileService,
		@ITerminalProfileResolverService private readonly profileResolver: ITerminalProfileResolverService,
		@IEditorService private readonly editors: IEditorService,
		@ICommandService private readonly commands: ICommandService,
		@ITerminalGroupService private readonly groups: ITerminalGroupService,
		@ITerminalEditorService private readonly terminalEditors: ITerminalEditorService,
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

	async createTerminal(options: ICreateTerminalOptions = {}): Promise<ITerminalInstance> {
		const scope = terminalExecutionScope(this.workspaceContext.getWorkspace());
		if (!this.connected) {
			await this.whenConnected;
		}
		const location = options.location;
		const parent = typeof location === 'object' && 'parentTerminal' in location ? await location.parentTerminal
			: typeof location === 'object' && 'splitActiveTerminal' in location && location.splitActiveTerminal ? this.activeInstance : undefined;
		const assertCurrent = (): void => {
			if (this.isDisposed || !terminalExecutionScopesEqual(scope, terminalExecutionScope(this.workspaceContext.getWorkspace()))
				|| parent && (!this.instances.includes(parent) || parent.state !== 'running')) throw new CancellationError();
		};
		assertCurrent();
		const dimensions = options.dimensions ?? parent?.xterm?.dimensions() ?? { rows: 24, cols: 80 };
		const cwd = options.cwd ?? (options.config && 'cwd' in options.config ? options.config.cwd : undefined);
		const cwdResource = URI.isUri(cwd) ? cwd : typeof cwd === 'string' && /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(cwd) ? URI.file(cwd) : undefined;
		let launch: ITerminalCreateOptions;
		if (options.config && 'customPtyImplementation' in options.config && options.config.customPtyImplementation) {
			launch = {
				...options, dimensions,
				dirId: options.dirId ?? (cwdResource ? this.workspaceContext.getWorkspaceFolder(cwdResource)?.id : undefined),
				cwd: typeof options.cwd === 'string' ? options.cwd : options.cwd?.fsPath,
				config: { ...options.config, customPtyImplementation: options.config.customPtyImplementation },
				profile: undefined,
			};
		} else if (options.profile) {
			// Tasks, Debug and extension execution already carry resolved host launch data.
			launch = { ...options, dimensions, cwd: typeof options.cwd === 'string' ? options.cwd : options.cwd?.fsPath, config: undefined, profile: options.profile };
		} else {
			const folders = this.workspaceContext.getWorkspace().folders;
			const namedRoot = typeof cwd === 'string' ? cwd.match(/^\$\{workspaceFolder:([^}]+)\}/)?.[1] : undefined;
			const namedFolders = namedRoot ? folders.filter(folder => folder.name === namedRoot) : [];
			const cwdFolder = (cwdResource && this.workspaceContext.getWorkspaceFolder(cwdResource))
				|| (namedFolders.length === 1 ? namedFolders[0] : undefined);
			const resource = this.editors.activeEditor?.resource;
			const folder = parent ? folders.find(folder => folder.id === parent.dirId)
				: options.dirId ? folders.find(folder => folder.id === options.dirId)
					: cwdFolder || (resource && this.workspaceContext.getWorkspaceFolder(resource)) || (folders.length === 1 ? folders[0]
						: folders.length ? await this.commands.executeCommand<IWorkspaceFolder | undefined>(PICK_WORKSPACE_FOLDER_COMMAND_ID, [{ placeHolder: localize('terminal.selectFolder', 'Select a workspace folder for the terminal.') }]) : undefined);
			if (!folder) {
				if (folders.length) throw new CancellationError();
				this.requireWorkspaceFolder();
				throw new CancellationError();
			}
			if (!this.profiles.getAvailableProfiles(folder.id).length) await this.profiles.refreshAvailableProfiles(folder.id);
			assertCurrent();
			const config = options.config;
			const contributed = config && 'extensionIdentifier' in config ? config
				: !config && !options.skipContributedProfileCheck ? await this.profiles.getContributedDefaultProfile({}) : undefined;
			if (contributed) {
				const provider = this.profiles.getContributedProfileProvider(contributed.extensionIdentifier, contributed.id);
				if (!provider) throw new Error(localize('terminal.profile.providerUnavailable', 'Terminal profile provider is unavailable: {0}', contributed.title));
				const previous = new Set(this.instances);
				await provider.createContributedTerminalProfile({ ...contributed.options, cwd: options.cwd ?? parent?.cwd ?? parent?.initialCwd ?? folder.uri });
				const created = this.activeInstance;
				if (!created || previous.has(created) || created.dirId !== folder.id) throw new CancellationError();
				return this.placeCreatedTerminal(created, location, parent, assertCurrent);
			}
			const profile = config && 'profileName' in config ? config : !config && !parent?.shellLaunchConfig?.executable ? this.profiles.getDefaultProfile(undefined, folder.id) : undefined;
			const shell: IShellLaunchConfig = profile ? { name: profile.profileName, executable: profile.path, args: profile.args, env: profile.env, icon: profile.icon, color: profile.color }
				: { ...(config as IShellLaunchConfig | undefined ?? parent?.shellLaunchConfig) };
			if (options.cwd !== undefined) shell.cwd = typeof options.cwd === 'string' ? options.cwd : options.cwd.fsPath;
			else if (parent) {
				shell.cwd = parent.cwd;
				if (!shell.cwd) {
					try { shell.cwd = await parent.capabilities?.get(TerminalCapability.NaiveCwdDetection)?.getCwd(); }
					catch { /* The backend-confirmed launch directory remains a valid fallback. */ }
				}
				shell.cwd ??= parent.initialCwd;
			}
			const os = this.processService.operatingSystem;
			if (os === undefined) throw new Error(localize('terminal.profile.platformUnavailable', 'The terminal execution host is not ready.'));
			await this.profileResolver.resolveShellLaunchConfig(shell, { os, remoteAuthority: getRemoteAuthority(folder.uri), workspaceFolder: folder });
			assertCurrent();
			launch = {
				...options, config: undefined, dirId: folder.id, dimensions,
				title: profile?.overrideName ? profile.profileName : shell.name,
				profile: profile?.isAutoDetected ? { type: 'profile', profileId: profile.profileId } : { type: 'custom', name: profile?.profileName ?? shell.name ?? localize('terminal.profile.shell', 'Shell'), path: typeof shell.executable === 'string' ? [shell.executable] : shell.executable!, args: shell.args ?? [] },
				env: shell.env, strictEnv: shell.strictEnv, cwd: shell.cwd, icon: shell.icon, color: shell.color,
				initialText: shell.initialText, waitOnExit: shell.waitOnExit,
			};
		}
		assertCurrent();
		const instance = await this.createTerminalCore(launch, isEditorLocation(location) ? TerminalLocation.Editor : undefined);
		return this.placeCreatedTerminal(instance, location, parent, assertCurrent);
	}

	private async placeCreatedTerminal(instance: ITerminalInstance, location: ITerminalLocationOptions | undefined, parent: ITerminalInstance | undefined, assertCurrent: () => void): Promise<ITerminalInstance> {
		try {
			assertCurrent();
			if (!this.instances.includes(instance)) throw new CancellationError();
			if (isEditorLocation(location)) await this.terminalEditors.openEditor(instance, typeof location === 'object' ? location : undefined);
			else if (parent) this.groups.joinInstances([parent, instance]);
			return instance;
		} catch (error) {
			if (this.instances.includes(instance)) await this.closeTerminal(instance);
			throw error;
		}
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
		// An empty window has no process to reattach, including hosts without a PTY backend.
		if (state.instances.length === 0) return;
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

	private async createTerminalCore(options: ITerminalCreateOptions, target?: TerminalLocation): Promise<ITerminalInstance> {
		if (this.isDisposed) throw new CancellationError();
		const instance = await this.instanceFactory.createInstance(options, {
			getConnectionState: () => this.connectionState,
			onClosed: instance => this.removeInstance(instance),
			onTitleChanged: () => { this.refreshInstanceTitles(); this._onDidChangeInstances.fire(); },
		});
		if (this.isDisposed) { await instance.close(); throw new CancellationError(); }
		if (target !== undefined) instance.target = target;
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
			this.requireWorkspaceFolder(instance.dirId);
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
		if (!dirId && folders.length > 1) throw new Error(localize('terminal.selectFolder', 'Select a workspace folder for the terminal.'));
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

function isEditorLocation(location: ITerminalLocationOptions | undefined): location is TerminalLocation.Editor | import('./terminal.js').TerminalEditorLocation {
	return location === TerminalLocation.Editor || typeof location === 'object' && !('parentTerminal' in location) && !('splitActiveTerminal' in location);
}
