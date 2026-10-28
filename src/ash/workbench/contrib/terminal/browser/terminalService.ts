import { getTerminalAutoReplyRules } from '../common/terminalConfiguration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { TerminalHasActiveInstanceContext } from '../common/terminalContextKey.js';
import type { IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { CancellationError, onUnexpectedError } from '../../../../base/common/errors.js';
import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ITerminalProcessService, type TerminalProcessConnectionState } from "../../../../platform/terminal/common/terminal.js";
import { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { TerminalTransferError, ITerminalEditorService, ITerminalGroupService, type ICreateTerminalOptions, type ITerminalCreateOptions, type ITerminalDimensions, type ITerminalInstance, type ITerminalProfile, type ITerminalService, type ITerminalLocationOptions } from './terminal.js';
import { TerminalInstance } from './terminalInstance.js';
import { TerminalInstanceService } from './terminalInstanceService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ProcessPropertyType, TerminalLocation, TERMINAL_REVIVE_STATE_KEY } from '../../../../platform/terminal/common/terminal.js';
import { localize } from '../../../../nls.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { parseTerminalReloadCredentials, parseTerminalReloadState, parseTerminalReviveStateKey, TerminalStorageKeys } from '../common/terminalStorageKeys.js';
import { terminalExecutionScope, terminalExecutionScopesEqual } from '../common/remote/terminal.js';
import { getTerminalUri, parseTerminalUri } from './terminalUri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { URI } from '../../../../base/common/uri.js';
import { ITerminalProfileResolverService, ITerminalProfileService } from '../common/terminal.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { PICK_WORKSPACE_FOLDER_COMMAND_ID } from '../../../browser/actions/workspaceCommands.js';
import type { IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import type { IShellLaunchConfig } from '../../../../platform/terminal/common/terminal.js';
import { TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { getRemoteAuthority } from '../../../../platform/remote/common/remoteHosts.js';
import type { ITerminalSerializedState } from '../../../services/terminal/common/terminal.js';
import type { ITerminalReconnectLease } from '../../../../platform/terminal/common/terminal.js';
import { IPathService } from '../../../../platform/path/common/pathService.js';

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
	private readonly hasActiveInstanceContext: IContextKey<boolean>;
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
		@IContextKeyService contextKeyService: IContextKeyService,
		@IPathService private readonly paths: IPathService,
	) {
		super();
		this.hasActiveInstanceContext = TerminalHasActiveInstanceContext.bindTo(contextKeyService);
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
		this.hasActiveInstanceContext.reset();
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
		const preserveFocus = options.preserveFocus ?? (isEditorLocation(location) && typeof location === 'object' && location.preserveFocus);
		const parent = typeof location === 'object' && 'parentTerminal' in location ? await location.parentTerminal
			: typeof location === 'object' && 'splitActiveTerminal' in location && location.splitActiveTerminal ? this.activeInstance : undefined;
		const assertCurrent = (): void => {
			if (this.isDisposed || !terminalExecutionScopesEqual(scope, terminalExecutionScope(this.workspaceContext.getWorkspace()))
				|| parent && (!this.instances.includes(parent) || parent.state !== 'running')) throw new CancellationError();
		};
		assertCurrent();
		const dimensions = options.dimensions ?? parent?.xterm?.dimensions() ?? { rows: 24, cols: 80 };
		const cwd = options.cwd ?? (options.config && 'cwd' in options.config ? options.config.cwd : undefined);
		const cwdResource = URI.isUri(cwd) ? cwd : typeof cwd === 'string' && /^(?:[\\/]|[a-z]:[\\/])/i.test(cwd) ? URI.file(cwd) : undefined;
		// URI.fsPath applies renderer OS rules, which need not match the process
		// host (for example a Windows window creating a remote POSIX profile).
		const requestedCwd = URI.isUri(options.cwd) ? await this.paths.getHostPath(options.cwd) : options.cwd;
		assertCurrent();
		if (URI.isUri(options.cwd) && requestedCwd === undefined) throw new Error(localize('terminal.path.wrongHost', 'The resource does not belong to this terminal execution host.'));
		let launch: ITerminalCreateOptions;
		if (options.config && 'customPtyImplementation' in options.config && options.config.customPtyImplementation) {
			launch = {
				...options, dimensions,
				dirId: options.dirId ?? (cwdResource ? this.workspaceContext.getWorkspaceFolder(cwdResource)?.id : undefined),
				cwd: requestedCwd,
				config: { ...options.config, customPtyImplementation: options.config.customPtyImplementation },
				profile: undefined,
			};
		} else if (options.profile) {
			// Tasks, Debug and low-level profile callers already carry resolved launch data.
			// They may opt into revival only with a separate raw revivalLaunch intent.
			launch = { ...options, dimensions, cwd: requestedCwd, config: undefined, profile: options.profile };
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
			if (!folder && (folders.length || options.dirId)) throw new CancellationError();
			if (!this.profiles.getAvailableProfiles(folder?.id).length) await this.profiles.refreshAvailableProfiles(folder?.id);
			assertCurrent();
			const config = options.config;
			const contributed = config && 'extensionIdentifier' in config ? config
				: !config && !options.skipContributedProfileCheck ? await this.profiles.getContributedDefaultProfile({}) : undefined;
			if (contributed) {
				const provider = this.profiles.getContributedProfileProvider(contributed.extensionIdentifier, contributed.id);
				if (!provider) throw new Error(localize('terminal.profile.providerUnavailable', 'Terminal profile provider is unavailable: {0}', contributed.title));
				const previous = new Set(this.instances);
				const instanceId = await provider.createContributedTerminalProfile({
					...contributed.options,
					preserveFocus,
					location: isEditorLocation(location) ? typeof location === 'object' ? location : TerminalLocation.Editor : undefined,
					cwd: options.cwd ?? parent?.cwd ?? parent?.initialCwd ?? folder?.uri,
				});
				const created = this.instances.find(instance => instance.instanceId === instanceId);
				if (!created || previous.has(created)) throw new CancellationError();
				return this.placeCreatedTerminal(created, location, parent, () => {
					assertCurrent();
					if (created.dirId !== (folder?.id ?? '')) throw new CancellationError();
				}, created.target === TerminalLocation.Editor);
			}
			const profile = config && 'profileName' in config ? config : !config && !parent?.shellLaunchConfig?.executable ? this.profiles.getDefaultProfile(undefined, folder?.id) : undefined;
			const shell: IShellLaunchConfig = profile ? { name: profile.overrideName ? profile.profileName : undefined, executable: profile.path, args: profile.args, env: profile.env, icon: profile.icon, color: profile.color }
				: { ...(config as IShellLaunchConfig | undefined ?? parent?.shellLaunchConfig) };
			if (options.cwd !== undefined) shell.cwd = requestedCwd;
			else if (parent) {
				shell.cwd = parent.cwd;
				if (!shell.cwd) {
					try { shell.cwd = await parent.capabilities?.get(TerminalCapability.NaiveCwdDetection)?.getCwd(); }
					catch { /* The backend-confirmed launch directory remains a valid fallback. */ }
				}
				shell.cwd ??= parent.initialCwd;
			}
			const inheritsResolvedEnvironment = !profile && parent && shell.env === parent.shellLaunchConfig?.env;
			// A split inherits explicit user naming, not the parent's rendered label.
			if (inheritsResolvedEnvironment && shell.name === parent.title) shell.name = this._instances.find(instance => instance === parent)?.customTitle;
			if (inheritsResolvedEnvironment && parent.revivalLaunch) {
				// The parent env already contains collection mutations. Keep its shell
				// command, but resolve the shared raw overrides only once for this split.
				shell.env = parent.revivalLaunch.env;
				shell.strictEnv = parent.revivalLaunch.strictEnv;
			}
			const rawEnvironment = shell.env;
			const rawExecutable = shell.executable;
			const rawArgs = shell.args;
			const rawCwd = shell.cwd;
			const os = this.processService.operatingSystem;
			if (os === undefined) throw new Error(localize('terminal.profile.platformUnavailable', 'The terminal execution host is not ready.'));
			await this.profileResolver.resolveShellLaunchConfig(shell, { os, remoteAuthority: folder ? getRemoteAuthority(folder.uri) : scope.remoteAuthority, workspaceFolder: folder });
			assertCurrent();
			const profileName = profile?.profileName ?? shell.name
				?? (parent?.revivalLaunch?.profile.type === 'custom' ? parent.revivalLaunch.profile.name : parent?.profile.title)
				?? localize('terminal.profile.shell', 'Shell');
			launch = {
				...options, config: undefined, dirId: folder?.id, dimensions,
				resolvedShellLaunchConfig: { executable: shell.executable, args: shell.args },
				title: profile?.overrideName ? profile.profileName : shell.name,
				profile: profile?.isAutoDetected ? { type: 'profile', profileId: profile.profileId } : { type: 'custom', name: profileName, path: typeof shell.executable === 'string' ? [shell.executable] : shell.executable!, args: shell.args ?? [] },
				env: shell.env, strictEnv: shell.strictEnv, cwd: shell.cwd, icon: shell.icon, color: shell.color,
				initialText: shell.initialText, waitOnExit: shell.waitOnExit, environmentVariableCollections: shell.environmentVariableCollections, environmentVariableCollectionsPersistable: shell.environmentVariableCollectionsPersistable,
			};
			launch = {
				...launch, revivalLaunch: options.revivalLaunch ?? (inheritsResolvedEnvironment ? parent.revivalLaunch : {
					profile: { type: 'custom', name: profileName, path: typeof rawExecutable === 'string' ? [rawExecutable] : rawExecutable ?? (typeof shell.executable === 'string' ? [shell.executable] : shell.executable!), args: rawArgs ?? shell.args ?? [] },
					env: rawEnvironment, strictEnv: shell.strictEnv, cwd: rawCwd,
				})
			};
		}
		assertCurrent();
		const instance = await this.createTerminalCore(launch, isEditorLocation(location) ? TerminalLocation.Editor : undefined, !preserveFocus);
		return this.placeCreatedTerminal(instance, location, parent, assertCurrent);
	}

	private async placeCreatedTerminal(instance: ITerminalInstance, location: ITerminalLocationOptions | undefined, parent: ITerminalInstance | undefined, assertCurrent: () => void, editorAlreadyOpened = false): Promise<ITerminalInstance> {
		try {
			assertCurrent();
			if (!this.instances.includes(instance)) throw new CancellationError();
			if (isEditorLocation(location)) {
				// Extension providers can finish opening the requested editor during
				// recursive creation. Keep placement with that completed operation.
				if (!editorAlreadyOpened) await this.terminalEditors.openEditor(instance, typeof location === 'object' ? location : undefined);
			}
			else if (parent) this.groups.joinInstances([parent, instance]);
			return instance;
		} catch (error) {
			if (this.instances.includes(instance)) await this.closeTerminal(instance);
			throw error;
		}
	}

	private async restoreTerminals(): Promise<void> {
		const encoded = await this.secrets.get(TerminalStorageKeys.Reload);
		if (this.isDisposed || this.configuration.getValue<boolean>('terminal.integrated.enablePersistentSessions') === false) return;
		const credentials = encoded ? parseTerminalReloadCredentials(encoded) : undefined;
		if (credentials && credentials.expiresAt < Date.now()) return;
		const text = this.storage.get(credentials?.stateKey ?? parseTerminalReviveStateKey(await this.secrets.get(TERMINAL_REVIVE_STATE_KEY)), StorageScope.WORKSPACE);
		if (!text && !credentials) return;
		if (!text) throw new Error('Terminal checkpoint is missing');
		const state = parseTerminalReloadState(text);
		const revive = !credentials && state.kind === 'revive';
		if (!credentials && (!revive || this.configuration.getValue<string>('terminal.integrated.persistentSessionReviveProcess') === 'never')) return;
		const scope = terminalExecutionScope(this.workspaceContext.getWorkspace());
		if (scope.workspaceId !== state.workspaceId || scope.remoteAuthority !== state.remoteAuthority) throw new Error('Terminal checkpoint belongs to another workspace or host');
		// Validate the complete checkpoint before any bearer credential attaches a process.
		for (const snapshot of state.instances) {
			const folders = this.workspaceContext.getWorkspace().folders;
			if (parseTerminalUri(URI.parse(snapshot.resource)).instanceId !== snapshot.instanceId
				|| !(snapshot.dirId === '' && folders.length === 0 || folders.some(folder => folder.id === snapshot.dirId))) throw new TypeError('Invalid terminal checkpoint identity');
		}
		// An empty checkpoint needs no process API, including hosts without a PTY backend.
		if (state.instances.length === 0) return;
		if (!revive && !this.processService.attach) throw new Error('Terminal attachment is unavailable');
		const screens: Promise<unknown>[] = [];
		const failures: unknown[] = [];
		for (const snapshot of state.instances) {
			try {
				if (this.isDisposed) throw new CancellationError();
				const dimensions = { rows: snapshot.rows, cols: snapshot.cols };
				const lease = credentials?.leases.find(candidate => candidate.terminalId === snapshot.process.terminalId && candidate.dirId === snapshot.processDirId);
				if (!revive && !lease) throw new Error('Terminal recovery credential is missing');
				// An existing PTY needs no executable or environment resolution. The saved
				// launch intent remains available for a later explicit relaunch.
				const autoReplies = getTerminalAutoReplyRules(this.configuration);
				const liveLaunch: (NonNullable<ITerminalSerializedState['launch']> & Pick<IShellLaunchConfig, 'environmentVariableCollections' | 'environmentVariableCollectionsPersistable'>) | undefined = revive ? await this.resolveRevivalLaunch(snapshot) : snapshot.launch;
				const { environmentVariableCollections: _snapshot, environmentVariableCollectionsPersistable: _persistable, ...processLaunch } = liveLaunch ?? {};
				const process = revive
					? await this.processService.create({ ...processLaunch as NonNullable<typeof liveLaunch>, ...(autoReplies.length ? { autoReplies } : {}), dirId: snapshot.processDirId ?? (snapshot.dirId || undefined), ...dimensions })
					: await this.processService.attach!(lease!, dimensions, snapshot.process.profile);
				if (this.isDisposed || !terminalExecutionScopesEqual(scope, terminalExecutionScope(this.workspaceContext.getWorkspace()))) {
					await this.processService.close({ terminalId: process.terminalId, dirId: snapshot.processDirId ?? (snapshot.dirId || undefined) });
					throw new CancellationError();
				}
				if (!revive && process.ready.pid !== snapshot.process.ready.pid) throw new Error('Terminal process identity changed');
				const restored = revive ? { ...snapshot, sequence: 0, pendingUtf8: [] } : snapshot;
				const instance = await this.createTerminalCore({
					...liveLaunch, revivalLaunch: snapshot.launch, dirId: snapshot.dirId, dimensions, profile: liveLaunch?.profile ?? { type: 'profile', profileId: snapshot.process.profile.profileId }, title: snapshot.customTitle ?? snapshot.title,
					attachPersistentProcess: { state: restored, process }, deferStart: true
				});
				screens.push(instance.xtermReadyPromise.catch(error => { failures.push(error); }));
			} catch (error) {
				if (this.isDisposed || !terminalExecutionScopesEqual(scope, terminalExecutionScope(this.workspaceContext.getWorkspace()))) throw error;
				failures.push(error);
			}
		}
		await Promise.all(screens);
		const active = this._instances.find(instance => instance.instanceId === state.activeId);
		if (active) this.setActiveInstance(active);
		if (failures.length) throw new AggregateError(failures, 'Some terminal sessions could not be restored');
	}

	/** Rebuilds only the live environment; the persisted intent stays unchanged. */
	private async resolveRevivalLaunch(snapshot: Pick<ITerminalSerializedState, 'launch' | 'dirId' | 'cwd' | 'title'>): Promise<(NonNullable<ITerminalSerializedState['launch']> & Pick<IShellLaunchConfig, 'environmentVariableCollections' | 'environmentVariableCollectionsPersistable'>) | undefined> {
		const intent = snapshot.launch;
		if (!intent) return undefined;
		const scope = terminalExecutionScope(this.workspaceContext.getWorkspace());
		const folder = this.resolveWorkspaceFolder(snapshot.dirId);
		// Discovery waits for execution-host readiness before reading its OS.
		await this.profiles.refreshAvailableProfiles(folder?.id);
		const os = this.processService.operatingSystem;
		if (os === undefined) throw new Error(localize('terminal.profile.platformUnavailable', 'The terminal execution host is not ready.'));
		const selectedId = intent.profile.type === 'profile' ? intent.profile.profileId : undefined;
		const selected = selectedId ? this.profiles.getAvailableProfiles(folder?.id).find(profile => profile.profileId === selectedId) : undefined;
		const shell: IShellLaunchConfig = {
			executable: intent.profile.type === 'custom' ? intent.profile.path : selected?.path,
			args: intent.profile.type === 'custom' ? intent.profile.args : selected?.args,
			env: selected ? { ...selected.env, ...intent.env } : intent.env,
			strictEnv: intent.strictEnv, cwd: snapshot.cwd ?? intent.cwd,
		};
		await this.profileResolver.resolveShellLaunchConfig(shell, { os, remoteAuthority: scope.remoteAuthority, workspaceFolder: folder });
		if (this.isDisposed || !terminalExecutionScopesEqual(scope, terminalExecutionScope(this.workspaceContext.getWorkspace()))) throw new CancellationError();
		return { profile: { type: 'custom', name: snapshot.title, path: typeof shell.executable === 'string' ? [shell.executable] : shell.executable!, args: shell.args ?? [] }, env: shell.env, strictEnv: shell.strictEnv, cwd: shell.cwd, environmentVariableCollections: shell.environmentVariableCollections, environmentVariableCollectionsPersistable: shell.environmentVariableCollectionsPersistable };
	}

	async importTerminalState(snapshot: ITerminalSerializedState, lease: ITerminalReconnectLease): Promise<ITerminalInstance> {
		await this.whenConnected;
		if (this.isDisposed || !this.processService.attach || !this.processService.detach) throw new CancellationError();
		const scope = terminalExecutionScope(this.workspaceContext.getWorkspace());
		if (parseTerminalUri(URI.parse(snapshot.resource)).instanceId !== snapshot.instanceId) throw new TypeError('Invalid terminal transfer identity');
		this.resolveWorkspaceFolder(snapshot.dirId);
		if (lease.terminalId !== snapshot.process.terminalId || lease.dirId !== snapshot.processDirId) throw new Error('Terminal transfer belongs to another execution directory');
		const dimensions = { cols: snapshot.cols, rows: snapshot.rows };
		const liveLaunch = snapshot.launch;
		let instance: ITerminalInstance | undefined;
		let adopted = false;
		const ownership = { get canTerminate() { return adopted; } };
		try {
			const process = await this.processService.attach(lease, dimensions, snapshot.process.profile);
			if (process.ready.pid !== snapshot.process.ready.pid || this.isDisposed || !terminalExecutionScopesEqual(scope, terminalExecutionScope(this.workspaceContext.getWorkspace()))) throw new CancellationError();
			// The destination owns its instance number. Preserve the screen, not the source editor identity.
			const instanceId = Math.max(0, ...this.instances.map(instance => instance.instanceId)) + 1;
			const state = { ...snapshot, instanceId, resource: getTerminalUri(generateUuid(), instanceId, snapshot.title).toString(), target: TerminalLocation.Panel };
			instance = await this.createTerminalCore({ ...liveLaunch, revivalLaunch: snapshot.launch, dirId: snapshot.dirId, dimensions, profile: liveLaunch?.profile ?? { type: 'profile', profileId: snapshot.process.profile.profileId }, attachPersistentProcess: { state, process, ownership }, deferStart: true });
			await instance.xtermReadyPromise;
			if (this.isDisposed || !this.instances.includes(instance) || !terminalExecutionScopesEqual(scope, terminalExecutionScope(this.workspaceContext.getWorkspace()))) throw new CancellationError();
			adopted = true;
			return instance;
		} catch {
			// Attach can consume the lease before a later information query fails.
			// Construction/disposal also releases only borrowed frontend handles.
			const rollbackLease = await this.processService.detach?.(lease.terminalId).catch(() => undefined);
			if (!rollbackLease) {
				// The old token was consumed by attach. If detachment cannot return a
				// replacement, no surviving frontend can reclaim this target-owned PTY.
				await this.processService.close({ terminalId: lease.terminalId, dirId: snapshot.processDirId }).catch(() => { });
			}
			if (instance) await instance.close().catch(onUnexpectedError);
			throw new TerminalTransferError(rollbackLease);
		}
	}

	private async createTerminalCore(options: ITerminalCreateOptions, target?: TerminalLocation, activate = true): Promise<ITerminalInstance> {
		if (this.isDisposed) throw new CancellationError();
		const instance = await this.instanceFactory.createInstance(options, {
			getConnectionState: () => this.connectionState,
			onClosed: instance => this.removeInstance(instance),
			onTitleChanged: () => { this.refreshInstanceTitles(); this._onDidChangeInstances.fire(); },
		});
		try {
			if (this.isDisposed) throw new CancellationError();
			if (target !== undefined) instance.target = target;
			this.ownedInstances.set(instance.id, instance);
			this._instances.push(instance);
			this.refreshInstanceTitles();
			if (options.deferStart && this.connectionState !== 'ready') instance.loseConnection();
			this._onDidCreateInstance.fire(instance);
			if (this.isDisposed || !this._instances.includes(instance)) throw new CancellationError();
			if (activate) this.setActiveInstance(instance);
			if (!options.deferStart) instance.start();
			this._onDidChangeInstances.fire();
			return instance;
		} catch (error) {
			await instance.close().catch(onUnexpectedError);
			throw error;
		}
	}

	private readonly pendingRelaunches = new Map<ITerminalInstance, Promise<void>>();

	relaunchTerminal(instance: ITerminalInstance, dimensions: ITerminalDimensions): Promise<void> {
		const pending = this.pendingRelaunches.get(instance);
		if (pending) return pending;
		const operation = this.performInstanceRelaunch(instance, dimensions).finally(() => this.pendingRelaunches.delete(instance));
		this.pendingRelaunches.set(instance, operation);
		return operation;
	}

	private async performInstanceRelaunch(instance: ITerminalInstance, dimensions: ITerminalDimensions): Promise<void> {
		if (!instance.isReadOnly) {
			this.resolveWorkspaceFolder(instance.dirId);
		}
		if (!this._instances.includes(instance as TerminalInstance)) {
			throw new Error("Terminal must belong to this TerminalService");
		}
		if (instance.state === 'reconnecting') return;
		const processId = instance.processId;
		const intent = instance.revivalLaunch;
		const state = instance.state;
		let retired = false;
		using lifetime = new DisposableStore();
		// Reuse leaves running and returns to it even when the OS reuses a PID.
		// State changes also report exit without subscribing to replayed exit events.
		lifetime.add(instance.onDidChangeState(() => { retired = true; }));
		const assertCurrentProcess = (): void => {
			if (retired || this.isDisposed || !this._instances.includes(instance as TerminalInstance)
				|| instance.processId !== processId || instance.revivalLaunch !== intent || instance.state !== state) throw new CancellationError();
		};
		if (state === 'running') {
			const confirmed = await this.confirmTerminalClose(instance);
			assertCurrentProcess();
			if (!confirmed) return;
		}
		let replacement: IShellLaunchConfig | undefined;
		if (intent) {
			const resolved = await this.resolveRevivalLaunch({ launch: intent, dirId: instance.dirId, cwd: instance.cwd, title: instance.profile.title });
			assertCurrentProcess();
			if (resolved) replacement = {
				...instance.shellLaunchConfig,
				executable: resolved.profile.type === 'custom' ? resolved.profile.path : undefined,
				args: resolved.profile.type === 'custom' ? resolved.profile.args : undefined,
				env: resolved.env, strictEnv: resolved.strictEnv, cwd: resolved.cwd,
				environmentVariableCollections: resolved.environmentVariableCollections,
				environmentVariableCollectionsPersistable: resolved.environmentVariableCollectionsPersistable,
			};
		}
		assertCurrentProcess();
		await (instance as TerminalInstance).relaunch(dimensions, replacement);
	}

	setActiveInstance(instance: ITerminalInstance | undefined): void {
		if (instance !== undefined && !this._instances.includes(instance as TerminalInstance)) {
			throw new Error("Active terminal must belong to this TerminalService");
		}
		if (this._activeInstance === instance) return;
		this._activeInstance = instance as TerminalInstance | undefined;
		this.hasActiveInstanceContext.set(instance !== undefined);
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

	async confirmTerminalClose(instance: ITerminalInstance): Promise<boolean> {
		if (!this._instances.includes(instance as TerminalInstance)) return true;
		const policy = this.configuration.getValue<string>('terminal.integrated.confirmOnKill') ?? 'editor';
		const confirm = policy === 'always' || policy === (instance.target === TerminalLocation.Editor ? 'editor' : 'panel');
		if (confirm && await instance.refreshProperty(ProcessPropertyType.HasChildProcesses).catch(() => true)) {
			const result = await this.dialogs.confirm({
				message: localize('terminal.confirmKill', 'Terminate the running processes in “{0}”?', instance.title),
				detail: localize('terminal.confirmKillDetail', 'Closing this terminal will stop its shell and child processes.'),
				primaryButton: localize('terminal.terminate', 'Terminate'),
			});
			if (!result.confirmed) return false;
		}
		return true;
	}

	async safeDisposeTerminal(instance: ITerminalInstance): Promise<void> {
		if (await this.confirmTerminalClose(instance)) await this.closeTerminal(instance);
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
			this.hasActiveInstanceContext.set(this._activeInstance !== undefined);
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
			const first = profileInstances[0];
			const baseTitle = terminalProfileTitle(first.profile, first.shellLaunchConfig?.executable);
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

	private resolveWorkspaceFolder(dirId?: string) {
		const folders = this.workspaceContext.getWorkspace().folders;
		if (!dirId && folders.length === 0) return undefined;
		if (!dirId && folders.length > 1) throw new Error(localize('terminal.selectFolder', 'Select a workspace folder for the terminal.'));
		const folder = dirId ? folders.find(folder => folder.id === dirId) : folders[0];
		if (!folder) throw new Error("TerminalUnavailable: Terminal requires an open workspace folder");
		return folder;
	}
}

function terminalProfileTitle(profile: ITerminalProfile, executable?: string | readonly string[]): string {
	// Configured profile names belong to the picker. A resolved launch supplies
	// the process name unless the user explicitly chose a fixed terminal title.
	const path = typeof executable === 'string' ? executable : executable?.length === 1 ? executable[0] : undefined;
	if (path) return path.split(/[/\\]/).at(-1)!.replace(/\.exe$/i, '').toLowerCase() || profile.title;
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
	return location === TerminalLocation.Editor || typeof location === 'object' && ('viewColumn' in location || !('parentTerminal' in location) && !('splitActiveTerminal' in location));
}
