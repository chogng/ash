import { ILifecycleService } from '../../../services/lifecycle/common/lifecycle.js';
import { IStorageService } from "../../../../platform/storage/common/storage.js";
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { DEBUG_CONFIGURE_COMMAND_ID } from './debugCommands.js';
import { IExtensionService } from '../../../services/extensions/common/extensionService.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { getUriFromSource } from '../common/debugSource.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import { ViewModel } from '../common/debugViewModel.js';
import { ReplModel } from '../common/replModel.js';
import { registerWorkbenchServiceContribution } from '../../../browser/workbenchServiceContributions.js';
import { IConfigurationResolverService } from '../../../services/configurationResolver/common/configurationResolver.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Debugger } from '../common/debugger.js';
import { localize } from '../../../../nls.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { CONTEXT_DEBUG_STATE, IAdapterManager, type IResolvedDebugConfiguration, type IDebugStackFrame, type IDebugThread, type IViewModel, type DebugBreakpoint, type IBaseBreakpoint, type IDebugBreakpoint, type IDebugBreakpointUpdate, type IDebugCompound, type IDebugConfiguration, type IDataBreakpoint, type IDataBreakpointOptions, type IFunctionBreakpoint, type IFunctionBreakpointOptions, type IInstructionBreakpoint, type IInstructionBreakpointOptions, IDebugService, DebugConsoleMode, type IDebugSessionOptions, type IDebugSession, DebugConfigurationProviderTriggerKind, type DebugConfiguration, type IDebugConfigurationProvider, type DebugConfigurationProviderRegistration, type IDebugAdapterTracker, type IDebugAdapterTrackerFactory, type DebugAdapterTrackerFactoryRegistration } from '../common/debug.js';
import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable, DisposableStore, toDisposable } from "../../../../base/common/lifecycle.js";
import { URI } from "../../../../base/common/uri.js";
import { generateUuid } from "../../../../base/common/uuid.js";
import { IDebugAdapterProcessService, type DebugWorkspaceEdit } from "../../../../platform/debug/common/debugAdapterProcessService.js";
import { FileNotFoundError, IFileService } from "../../../../platform/files/common/files.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { DebugStorage, type PersistedDebugState } from "../common/debugStorage.js";
import { ITaskService } from "../../tasks/common/taskService.js";
import { waitForTask } from "../../tasks/common/tasks.js";
import { ITerminalService } from "../../terminal/browser/terminal.js";
import { ITerminalProfileResolverService, type IShellLaunchConfigResolveOptions } from '../../terminal/common/terminal.js';
import { ITerminalProcessService, type IShellLaunchConfig } from '../../../../platform/terminal/common/terminal.js';
import { escapeNonWindowsPath } from '../../../../platform/terminal/common/terminalEnvironment.js';
import { GeneralShellType } from '../../../../platform/terminal/common/terminal.js';
import { mergeEnvironments } from '../../terminal/common/terminalEnvironment.js';
import { OperatingSystem } from '../../../../base/common/platform.js';
import { getRemoteAuthority } from '../../../../platform/remote/common/remoteHosts.js';
import { DebugSession } from "./debugSession.js";
import { ConfigurationManager, parseLaunchConfigurationDocument } from "./debugConfigurationManager.js";
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { Schemas } from '../../../../base/common/network.js';

interface DebugSessionRecord {
	readonly session: DebugSession;
	readonly workspaceGeneration: number;
	readonly workspaceId: string;
	readonly listener: DisposableStore;
	readonly postDebugTask: string | undefined;
	completion?: Promise<void>;
}

/** Workspace Debug composition over generic DAP processes. */
export class DebugService extends Disposable implements IDebugService {
	readonly replModel: ReplModel;
	private readonly debugger: Debugger;
	private readonly configurationManager = this._register(new ConfigurationManager());
	private readonly breakpointsEmitter = this._register(new Emitter<readonly DebugBreakpoint[]>());
	private readonly watchExpressionsEmitter = this._register(new Emitter<readonly string[]>());
	private readonly exceptionBreakpointsEmitter = this._register(new Emitter<readonly string[]>());
	private readonly willSessionEmitter = this._register(new Emitter<IDebugSession>());
	private readonly newSessionEmitter = this._register(new Emitter<IDebugSession>());
	private readonly endSessionEmitter = this._register(new Emitter<IDebugSession>());
	private readonly sessionEmitter = this._register(new Emitter<IDebugSession | undefined>());
	private readonly viewModel = this._register(new ViewModel());
	private readonly debugStorage: DebugStorage;
	private readonly sessionRecords = new Map<string, DebugSessionRecord>();
	private currentBreakpoints: readonly IDebugBreakpoint[] = Object.freeze([]);
	private currentFunctionBreakpoints: readonly IFunctionBreakpoint[] = Object.freeze([]);
	private currentDataBreakpoints: readonly IDataBreakpoint[] = Object.freeze([]);
	private currentInstructionBreakpoints: readonly IInstructionBreakpoint[] = Object.freeze([]);
	private currentWatchExpressions: readonly string[] = Object.freeze([]);
	private exceptionBreakpointsByType: Readonly<Record<string, readonly string[]>> = Object.freeze({});
	private refreshGeneration = 0;
	private workspaceGeneration = 0;
	private terminalGeneration = 0;
	private readonly launchControllers = new Map<string, AbortController>();
	private readonly pendingDescriptors = new Set<AbortController>();
	private readonly descriptorOwners = new Map<AbortController, Set<object>>();
	private readonly preparingSessions = new Map<string, IDebugSession>();
	private readonly descriptorControllers = new Map<string, AbortController>();
	private readonly trackerFactories = new Map<string, { readonly owner: object; readonly factory: IDebugAdapterTrackerFactory; }>();
	private readonly configurationProviders = new Map<string, { readonly owner: object; readonly source: IDebugConfigurationProvider; readonly provider: IDebugConfigurationProvider; }>();

	readonly onDidChangeConfigurations = this.configurationManager.onDidChangeConfigurations;
	readonly onDidChangeBreakpoints: Event<readonly DebugBreakpoint[]> = this.breakpointsEmitter.event;
	readonly onDidChangeWatchExpressions: Event<readonly string[]> = this.watchExpressionsEmitter.event;
	readonly onDidChangeExceptionBreakpoints: Event<readonly string[]> = this.exceptionBreakpointsEmitter.event;
	readonly onDidChangeSession: Event<IDebugSession | undefined> = this.sessionEmitter.event;
	readonly onWillNewSession = this.willSessionEmitter.event;
	readonly onDidNewSession = this.newSessionEmitter.event;
	readonly onDidEndSession = this.endSessionEmitter.event;
	getViewModel(): IViewModel { return this.viewModel; }

	constructor(
		@IFileService private readonly files: IFileService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IDebugAdapterProcessService private readonly processes: IDebugAdapterProcessService | undefined,
		@ITerminalService private readonly terminals: ITerminalService,
		@ITerminalProfileResolverService private readonly terminalProfiles: ITerminalProfileResolverService,
		@ITerminalProcessService private readonly terminalProcesses: ITerminalProcessService,
		@ITaskService private readonly tasks: ITaskService,
		@IAdapterManager private readonly adapters: IAdapterManager,
		@ILogService private readonly logService: ILogService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IExtensionService private readonly extensions: IExtensionService,
		@IUriIdentityService private readonly uriIdentity: IUriIdentityService,
		@ICommandService private readonly commands: ICommandService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IEditorService private readonly editors: IEditorService,
		@IEditorGroupsService private readonly editorGroups: IEditorGroupsService,
	) {
		super();
		this.debugger = instantiationService.createInstance(Debugger);
		this._register(terminalProcesses.onConnectionState(() => this.terminalGeneration++));
		// Session changes include state changes; inactive debugging must leave F6 available for region navigation.
		const debugState = CONTEXT_DEBUG_STATE.bindTo(contextKeys);
		this._register(this.onDidChangeSession(session => debugState.set(session?.state ?? 'inactive')));
		this._register(toDisposable(() => debugState.reset()));
		try { this.debugStorage = this._register(instantiationService.createInstance(DebugStorage)); } catch (error) { this.dispose(); throw error; }
		this.restoreState(this.debugStorage.state);
		this._register(this.debugStorage.onDidChangeState(state => this.restoreState(state)));
		this._register(files.onDidChangeFiles(event => { if (event.resources === undefined || event.resources.some(resource => /\/\.vscode\/launch\.json$/i.test(resource.path))) void this.refresh().catch(error => this.reportError(error)); }));
		let previousFactories = adapters.factories;
		this._register(adapters.onDidChange(factories => {
			// Catalog replacement may retire an unrelated extension while another
			// launch awaits a provider. Revoke only callbacks using retired owners.
			this.cancelRetiredDescriptors(previousFactories.filter(factory => !factories.includes(factory)));
			previousFactories = factories;
			this.configurationManager.setConfigurations(Object.freeze([]), Object.freeze([]));
			void this.refresh().catch(error => this.reportError(error));
		}));
		this._register(workspace.onDidChangeWorkspace(() => { this.workspaceGeneration++; this.currentDataBreakpoints = Object.freeze(this.currentDataBreakpoints.filter(point => point.canPersist)); this.currentInstructionBreakpoints = Object.freeze([]); this.restoreState(this.debugStorage.state); this.cancelPendingDescriptors(); this.refreshGeneration += 1; this.configurationManager.setConfigurations(Object.freeze([]), Object.freeze([])); void this.stopAll(); }));
		this._register(toDisposable(() => { this.cancelPendingDescriptors(); this.configurationProviders.clear(); this.trackerFactories.clear(); for (const session of this.preparingSessions.values()) { session.dispose(); } this.preparingSessions.clear(); for (const record of this.sessionRecords.values()) { record.listener.dispose(); record.session.dispose(); } this.sessionRecords.clear(); }));
		this.replModel = this._register(new ReplModel(this));
	}

	getConfigurationManager() { return this.configurationManager; }
	get configurations() { return this.configurationManager.configurations; }
	get compounds() { return this.configurationManager.compounds; }
	get breakpoints() { return this.currentBreakpoints; }
	get functionBreakpoints() { return this.currentFunctionBreakpoints; }
	get dataBreakpoints() { return this.currentDataBreakpoints; }
	get instructionBreakpoints() { return this.currentInstructionBreakpoints; }
	get watchExpressions() { return this.currentWatchExpressions; }
	get exceptionBreakpoints() { return this.session?.exceptionBreakpoints ?? Object.freeze([]); }
	getSession(id: string): IDebugSession | undefined { return this.sessionRecords.get(id)?.session ?? this.preparingSessions.get(id); }
	// Release retains canonical identities for extension callbacks, but disposed
	// session emitters must never be advertised to views as subscribable sessions.
	get sessions(): readonly IDebugSession[] { return Object.freeze([...this.sessionRecords.values()].map(record => record.session).filter(session => !session.isDisposed)); }
	get session(): IDebugSession | undefined {
		const session = this.viewModel.focusedSession ? this.sessionRecords.get(this.viewModel.focusedSession.id)?.session : undefined;
		return session?.isDisposed ? undefined : session;
	}

	registerDebugAdapterTrackerFactories(factories: readonly IDebugAdapterTrackerFactory[]): DebugAdapterTrackerFactoryRegistration {
		this.assertNotDisposed();
		const owner = Object.freeze({});
		this.replaceTrackerFactories(owner, factories);
		let disposed = false;
		const registration = toDisposable(() => {
			if (disposed) { return; }
			disposed = true;
			this.replaceTrackerFactories(owner, []);
		}) as DebugAdapterTrackerFactoryRegistration;
		registration.replace = replacement => {
			if (disposed) { throw new ReferenceError('Debug Adapter tracker registration is disposed'); }
			this.assertNotDisposed();
			this.replaceTrackerFactories(owner, replacement);
		};
		return registration;
	}

	private replaceTrackerFactories(owner: object, factories: readonly IDebugAdapterTrackerFactory[]): void {
		if (!Array.isArray(factories) || factories.length > 2048) { throw new TypeError('Debug Adapter tracker factories must be a bounded array'); }
		const ids = new Set<string>();
		for (const factory of factories) {
			if (!factory || typeof factory.id !== 'string' || !factory.id.trim() || factory.id.length > 32768 || factory.id.includes('\0') || typeof factory.type !== 'string' || !factory.type.trim() || factory.type.length > 256 || factory.type.includes('\0') || typeof factory.createDebugAdapterTracker !== 'function') { throw new TypeError('Invalid Debug Adapter tracker factory'); }
			const existing = this.trackerFactories.get(factory.id);
			if (ids.has(factory.id) || existing && existing.owner !== owner) { throw new TypeError(`Debug Adapter tracker '${factory.id}' is already registered`); }
			ids.add(factory.id);
		}
		for (const [id, entry] of this.trackerFactories) {
			if (entry.owner === owner) { this.trackerFactories.delete(id); }
		}
		for (const factory of factories) { this.trackerFactories.set(factory.id, { owner, factory }); }
		// Active trackers belong to sessions and survive factory unregistration.
		// Pending creations check their factory identity before accepting a handle.
	}

	private async createAdapterTrackers(session: IDebugSession, generation: number): Promise<readonly IDebugAdapterTracker[]> {
		const controller = new AbortController();
		this.pendingDescriptors.add(controller);
		this.descriptorControllers.set(session.id, controller);
		const trackers: IDebugAdapterTracker[] = [];
		let expired = false;
		// Optional instrumentation has one second for all factories, so a hung
		// extension cannot delay launching a debuggee indefinitely.
		let expire: (() => void) | undefined;
		const deadlinePromise = new Promise<void>(resolve => { expire = resolve; });
		const deadline = setTimeout(() => { expired = true; expire?.(); }, 1000);
		try {
			const creations = [...this.trackerFactories.values()].filter(({ factory }) => factory.type === '*' || factory.type === session.resolvedConfiguration?.type).map(async ({ factory }) => {
				try {
					const tracker = await factory.createDebugAdapterTracker(session, controller.signal);
					if (expired || controller.signal.aborted || this.trackerFactories.get(factory.id)?.factory !== factory) { tracker?.dispose(); return; }
					if (tracker) { trackers.push(tracker); }
					return tracker;
				} catch (error) {
					if (!controller.signal.aborted) { this.reportError(error); }
				}
			});
			const result = await raceCancellationError(Promise.race([Promise.all(creations), deadlinePromise]), controller.signal);
			if (expired) { for (const tracker of trackers) { tracker.dispose(); } return []; }
			if (generation !== this.workspaceGeneration || this.isDisposed || controller.signal.aborted) { throw new CancellationError(); }
			return result?.filter((tracker): tracker is IDebugAdapterTracker => tracker !== undefined) ?? [];
		} catch (error) {
			for (const tracker of trackers) { tracker.dispose(); }
			throw error;
		} finally { clearTimeout(deadline); this.pendingDescriptors.delete(controller); this.descriptorControllers.delete(session.id); }
	}

	registerDebugConfigurationProviders(providers: readonly IDebugConfigurationProvider[]): DebugConfigurationProviderRegistration {
		this.assertNotDisposed();
		const owner = Object.freeze({});
		this.replaceConfigurationProviders(owner, providers);
		let disposed = false;
		const registration = toDisposable(() => {
			if (disposed) return;
			disposed = true;
			this.replaceConfigurationProviders(owner, []);
		}) as DebugConfigurationProviderRegistration;
		registration.replace = replacement => {
			if (disposed) throw new ReferenceError('Debug configuration provider registration is disposed');
			this.assertNotDisposed();
			this.replaceConfigurationProviders(owner, replacement);
		};
		return registration;
	}

	private replaceConfigurationProviders(owner: object, providers: readonly IDebugConfigurationProvider[]): void {
		if (!Array.isArray(providers) || providers.length > 2048) throw new TypeError('Debug configuration providers must be a bounded array');
		const ids = new Set<string>();
		const normalized = providers.map(provider => {
			if (!provider || typeof provider !== 'object' || [provider.id, provider.type].some(value => typeof value !== 'string' || !value.trim() || value.length > 256 || value.includes('\0')) || ![1, 2].includes(provider.triggerKind)) throw new TypeError('Invalid Debug configuration provider identity');
			const existing = this.configurationProviders.get(provider.id);
			if (ids.has(provider.id) || existing && existing.owner !== owner) throw new TypeError(`Debug configuration provider '${provider.id}' is already registered`);
			ids.add(provider.id);
			if (existing && existing.source === provider) return existing.provider;
			const methods = ['provideDebugConfigurations', 'resolveDebugConfiguration', 'resolveDebugConfigurationWithSubstitutedVariables'] as const;
			if (!methods.some(method => typeof provider[method] === 'function') || methods.some(method => provider[method] !== undefined && typeof provider[method] !== 'function')) throw new TypeError('A Debug configuration provider requires callbacks');
			return Object.freeze({
				id: provider.id, type: provider.type, triggerKind: provider.triggerKind,
				...(provider.provideDebugConfigurations ? { provideDebugConfigurations: provider.provideDebugConfigurations.bind(provider) } : {}),
				...(provider.resolveDebugConfiguration ? { resolveDebugConfiguration: provider.resolveDebugConfiguration.bind(provider) } : {}),
				...(provider.resolveDebugConfigurationWithSubstitutedVariables ? { resolveDebugConfigurationWithSubstitutedVariables: provider.resolveDebugConfigurationWithSubstitutedVariables.bind(provider) } : {}),
			});
		});
		const previous = [...this.configurationProviders.values()].filter(entry => entry.owner === owner);
		const changed = previous.length !== normalized.length || normalized.some(provider => this.configurationProviders.get(provider.id)?.provider !== provider);
		if (!changed) return;
		const retired = previous.filter(entry => !normalized.includes(entry.provider)).map(entry => entry.provider);
		for (const [id, entry] of this.configurationProviders) {
			if (entry.owner === owner) this.configurationProviders.delete(id);
		}
		for (let index = 0; index < normalized.length; index++) {
			const provider = normalized[index]!;
			this.configurationProviders.set(provider.id, { owner, source: providers[index]!, provider });
		}
		if (!this.isDisposed) {
			this.cancelRetiredDescriptors(retired);
			void this.refresh().catch(error => this.reportError(error));
		}
	}

	async provideDebugConfigurations(folder: URI, signal?: AbortSignal, triggerKind = DebugConfigurationProviderTriggerKind.Initial): Promise<readonly DebugConfiguration[]> {
		this.assertNotDisposed();
		if (triggerKind !== DebugConfigurationProviderTriggerKind.Initial && triggerKind !== DebugConfigurationProviderTriggerKind.Dynamic) throw new TypeError('Invalid debug configuration provider trigger');
		if (!this.workspace.getWorkspace().folders.some(candidate => candidate.uri.toString() === folder.toString())) throw new CancellationError();
		const workspaceGeneration = this.workspaceGeneration;
		await this.extensions.activateByEvent('onDebug', signal);
		await this.extensions.activateByEvent(triggerKind === DebugConfigurationProviderTriggerKind.Dynamic ? 'onDebugDynamicConfigurations' : 'onDebugInitialConfigurations', signal);
		if (workspaceGeneration !== this.workspaceGeneration || this.isDisposed) throw new CancellationError();
		const generation = this.workspaceGeneration;
		const controller = new AbortController();
		const cancel = (): void => controller.abort();
		signal?.addEventListener('abort', cancel, { once: true });
		if (signal?.aborted) cancel();
		this.pendingDescriptors.add(controller);
		try {
			const configurations: DebugConfiguration[] = [];
			for (const { provider } of this.configurationProviders.values()) {
				if (provider.triggerKind !== triggerKind || !provider.provideDebugConfigurations) continue;
				throwIfCancelled(controller.signal);
				this.bindDescriptorOwner(controller, provider);
				const provided = await raceCancellationError(Promise.resolve(provider.provideDebugConfigurations(folder, controller.signal)), controller.signal);
				if (!Array.isArray(provided) || provided.length > 64 || configurations.length + provided.length > 64) throw new TypeError('Debug configuration templates must be a bounded array');
				for (const configuration of provided) {
					this.parseProviderConfiguration(configuration);
					configurations.push(JSON.parse(JSON.stringify(configuration)) as DebugConfiguration);
				}
			}
			if (generation !== this.workspaceGeneration || this.isDisposed || controller.signal.aborted) throw new CancellationError();
			return Object.freeze(configurations);
		} finally {
			signal?.removeEventListener('abort', cancel);
			this.pendingDescriptors.delete(controller);
			this.descriptorOwners.delete(controller);
		}
	}

	private parseProviderConfiguration(configuration: unknown): IDebugConfiguration {
		const encoded = JSON.stringify({ version: '0.2.0', configurations: [configuration] });
		if (encoded.length > 524288) throw new RangeError('Debug configuration provider result is too large');
		return parseLaunchConfigurationDocument(encoded, type => this.resolveDebugAdapter(type)).configurations[0]!;
	}

	private resolveDebugAdapter(type: string): IResolvedDebugConfiguration['adapter'] | null | undefined {
		const factory = this.adapters.get(type);
		const executable = factory?.createDebugAdapter?.();
		if (executable) return executable;
		if (factory?.createDebugAdapterDescriptor) return null;
		for (const { provider } of this.configurationProviders.values()) {
			if ((provider.type === type || provider.type === '*') && (provider.resolveDebugConfiguration || provider.resolveDebugConfigurationWithSubstitutedVariables)) return null;
		}
		return undefined;
	}

	private async resolveConfigurationProviders(configuration: IDebugConfiguration, folder: URI | undefined, substituted: boolean, signal: AbortSignal): Promise<IDebugConfiguration> {
		let current = configuration;
		const controller = new AbortController();
		using cancellation = linkCancellation(signal, controller);
		this.pendingDescriptors.add(controller);
		try {
			const seen = new Set<string>();
			do {
				const type = current.type;
				seen.add(type);
				const providers = [...this.configurationProviders.values()].map(entry => entry.provider);
				const matching = [
					...providers.filter(provider => provider.type !== '*' && provider.type === type),
					...providers.filter(provider => provider.type === '*'),
				];
				for (const provider of matching) {
					const callback = substituted ? provider.resolveDebugConfigurationWithSubstitutedVariables : provider.resolveDebugConfiguration;
					if (!callback) continue;
					throwIfCancelled(controller.signal);
					this.bindDescriptorOwner(controller, provider);
					const resolved = await raceCancellationError(Promise.resolve(callback(folder, toExtensionDebugConfiguration(current), controller.signal)), controller.signal);
					throwIfCancelled(controller.signal);
					if (resolved === null) {
						if (folder) await raceCancellationError(this.commands.executeCommand(DEBUG_CONFIGURE_COMMAND_ID, folder, true, controller.signal), controller.signal);
						throw new CancellationError();
					}
					if (resolved === undefined) throw new CancellationError();
					if (!substituted && typeof resolved.type === 'string' && resolved.type !== type && !seen.has(resolved.type)) {
						await this.extensions.activateByEvent(`onDebugResolve:${resolved.type}`, controller.signal);
						throwIfCancelled(controller.signal);
					}
					const parsed = this.parseProviderConfiguration(resolved);
					current = {
						...parsed,
						...(substituted && current.type === parsed.type && current.adapterExplicit === false && parsed.adapterExplicit === false ? { adapter: current.adapter } : {}),
						id: configuration.id,
						dirId: configuration.dirId, workspaceFolderName: configuration.workspaceFolderName,
					};
				}
				// A provider may redirect to another debugger before substitution.
				// Visit each resulting type once so redirects cannot loop indefinitely.
			} while (!substituted && !seen.has(current.type));
			return current;
		} finally {
			this.pendingDescriptors.delete(controller);
			this.descriptorOwners.delete(controller);
		}
	}

	async refresh(): Promise<readonly IDebugConfiguration[]> {
		await this.debugStorage.whenReady();
		await this.debugStorage.reload();
		const generation = ++this.refreshGeneration;
		const folders = this.workspace.getWorkspace().folders;
		const multiRoot = folders.length > 1;
		const configurations: IDebugConfiguration[] = [];
		const compounds: IDebugCompound[] = [];
		await Promise.all(folders.map(async folder => {
			try {
				const document = parseLaunchConfigurationDocument((await this.files.readFile(childResource(folder.uri, ".vscode/launch.json"))).content, type => this.resolveDebugAdapter(type));
				configurations.push(...document.configurations.map(configuration => Object.freeze({
					...configuration,
					id: multiRoot ? `${folder.id}:${configuration.id}` : configuration.id,
					dirId: folder.id,
					workspaceFolderName: folder.name,
				})));
				compounds.push(...document.compounds.map(compound => Object.freeze({
					...compound,
					id: multiRoot ? `${folder.id}:${compound.id}` : compound.id,
					dirId: folder.id,
					workspaceFolderName: folder.name,
				})));
			} catch (error) { if (!(error instanceof FileNotFoundError)) throw error; }
		}));
		if (generation === this.refreshGeneration) this.configurationManager.setConfigurations(Object.freeze(configurations), Object.freeze(compounds));
		return this.configurations;
	}

	async start(configuration: IDebugConfiguration, options?: IDebugSessionOptions): Promise<IDebugSession> {
		if (!this.processes) throw new Error("This host does not provide the Code debug adapter capability");
		const current = this.configurations.find(candidate => candidate.id === configuration.id);
		if (!current) throw new Error("Debug configuration is no longer present in launch.json");
		return this.startDebugging(current, options);
	}

	async startDynamicDebugging(folder: URI | undefined, configuration: DebugConfiguration, options?: IDebugSessionOptions): Promise<IDebugSession> {
		this.assertNotDisposed();
		const currentFolder = folder && this.workspace.getWorkspace().folders.find(candidate => candidate.uri.toString() === folder.toString());
		if (folder && !currentFolder) throw new CancellationError();
		const parsed = this.parseProviderConfiguration(configuration);
		return this.startDebugging(Object.freeze({ ...parsed, id: generateUuid(), dirId: currentFolder?.id ?? null, workspaceFolderName: currentFolder?.name }), options);
	}

	async startDebugging(current: IDebugConfiguration, options: IDebugSessionOptions = {}): Promise<IDebugSession> {
		const sessionOptions = this.normalizeSessionOptions(options);
		if (!this.processes) throw new Error("This host does not provide the Code debug adapter capability");
		const generation = this.workspaceGeneration;
		const relation = await this.processes.reserveSession({
			id: generateUuid(), workspaceId: this.workspace.getWorkspace().id, parentId: sessionOptions.parentSession?.id ?? null,
			lifecycleManagedByParent: sessionOptions.lifecycleManagedByParent ?? false,
			mergeConsole: sessionOptions.consoleMode === DebugConsoleMode.MergeWithParent,
			noDebug: sessionOptions.noDebug ?? (sessionOptions.parentSession ? null : typeof current.arguments.noDebug === 'boolean' ? current.arguments.noDebug : null),
		});
		const controller = new AbortController();
		this.launchControllers.set(relation.id, controller);
		try {
			if (this.isDisposed || generation !== this.workspaceGeneration) throw new CancellationError();
			const launch = relation.noDebug === null ? current : Object.freeze({ ...current, arguments: Object.freeze({ ...current.arguments, noDebug: relation.noDebug }) });
			return await this.startAdmittedDebugging(launch, sessionOptions, relation.id, controller.signal);
		} catch (error) {
			await this.processes.manageSession(relation.id, 'end').catch(() => { });
			throw error;
		} finally { this.launchControllers.delete(relation.id); }
	}

	private async startAdmittedDebugging(current: IDebugConfiguration, sessionOptions: IDebugSessionOptions, id: string, signal: AbortSignal): Promise<IDebugSession> {
		const assertParent = (): void => {
			throwIfCancelled(signal);
			if (sessionOptions.parentSession && (this.getSession(sessionOptions.parentSession.id) !== sessionOptions.parentSession || ['terminated', 'error'].includes(sessionOptions.parentSession.state))) throw new CancellationError();
		};
		if (!this.processes) throw new Error("This host does not provide the Code debug adapter capability");
		const assertAdmitted = async (): Promise<void> => {
			assertParent();
			if ((await this.processes!.manageSession(id, 'read')).ended) throw new CancellationError();
			throwIfCancelled(signal);
		};
		await this.debugStorage.whenReady();
		const activeResource = this.editors.activeEditor?.resource;
		const folders = this.workspace.getWorkspace().folders;
		const folder = current.dirId === null ? undefined : current.dirId
			? this.workspace.getWorkspace().folders.find(folder => folder.id === current.dirId)
			: (activeResource && this.workspace.getWorkspaceFolder(activeResource)) || (folders.length === 1 ? folders[0] : undefined);
		if (current.dirId === undefined && folders.length > 1 && !folder) throw new Error(localize('debug.selectFolder', 'Select a workspace folder to configure debugging.'));
		if (folder && current.dirId === undefined) current = Object.freeze({ ...current, dirId: folder.id, workspaceFolderName: folder.name });
		const root = folder?.uri;
		if (current.dirId && !folder) throw new CancellationError();
		const workspaceGeneration = this.workspaceGeneration;
		if (!sessionOptions.parentSession && !sessionOptions.suppressSaveBeforeStart) {
			const policy = this.configuration.getValue<string>('debug.saveBeforeStart', { overrideIdentifier: this.editors.activeEditor?.languageId }) ?? 'allEditorsInActiveGroup';
			if (policy !== 'none') {
				const saved = await this.editors.saveAll();
				if (!saved.success) { throw new CancellationError(); }
				if (policy === 'allEditorsInActiveGroup' && this.editors.activeEditor?.resource.scheme === Schemas.untitled) {
					const saved = await this.editors.save({ editor: this.editors.activeEditor, groupId: this.editorGroups.activeGroup.id });
					if (!saved.success) { throw new CancellationError(); }
				}
			}
			await this.configuration.reloadConfiguration();
			if (workspaceGeneration !== this.workspaceGeneration || this.isDisposed) { throw new CancellationError(); }
		}
		await this.extensions.activateByEvent('onDebug');
		await this.extensions.activateByEvent(`onDebugResolve:${current.type}`);
		await this.extensions.reload();
		if (workspaceGeneration !== this.workspaceGeneration || this.isDisposed) throw new CancellationError();
		assertParent();
		// Discovery refreshes do not invalidate the immutable launch snapshot.
		// Workspace retirement revokes every launch; registration retirement is scoped
		// to the callbacks using that owner and checked again before adapter creation.
		const generation = this.workspaceGeneration;
		// Defaults can become available while a dormant extension activates. Read
		// them from the canonical registry before substitution, not from discovery.
		const launch = current.adapterExplicit === false
			? { ...current, adapter: this.resolveDebugAdapter(current.type) ?? undefined } : current;
		await assertAdmitted();
		const providedConfiguration = await this.resolveConfigurationProviders(launch, root, false, signal);
		if (generation !== this.workspaceGeneration || this.isDisposed) throw new CancellationError();
		let resolvedConfiguration;
		try { resolvedConfiguration = await raceCancellationError(this.debugger.substituteVariables(folder, providedConfiguration), signal); }
		catch (error) {
			if (generation !== this.workspaceGeneration) throw new Error(localize('configurationResolver.workspaceChanged', 'The workspace changed while resolving the configuration. Run it again.'));
			throw error;
		}
		if (generation !== this.workspaceGeneration || this.isDisposed) throw new Error(localize('configurationResolver.workspaceChanged', 'The workspace changed while resolving the configuration. Run it again.'));
		if (!resolvedConfiguration) throw new CancellationError();
		resolvedConfiguration = await this.resolveConfigurationProviders(resolvedConfiguration, root, true, signal);
		if (generation !== this.workspaceGeneration || this.isDisposed) throw new CancellationError();
		const factory = resolvedConfiguration.adapter && resolvedConfiguration.adapterExplicit !== false
			? undefined : this.adapters.get(resolvedConfiguration.type);
		if (!resolvedConfiguration.adapter && !factory?.createDebugAdapterDescriptor) throw new Error(`No Debug Adapter factory is available for '${resolvedConfiguration.type}'`);
		assertParent();
		await assertAdmitted();
		await this.runTask(resolvedConfiguration.preLaunchTask, "preLaunchTask", current.dirId ?? undefined, signal);
		if (generation !== this.workspaceGeneration || this.isDisposed) throw new CancellationError();
		if (factory && this.adapters.get(resolvedConfiguration.type) !== factory) throw new CancellationError();

		if (generation !== this.workspaceGeneration || this.isDisposed) throw new Error(localize('configurationResolver.workspaceChanged', 'The workspace changed while resolving the configuration. Run it again.'));
		let initializingSession: IDebugSession | undefined;
		const acceptsBreakpointEvents = (): boolean => !this.isDisposed && workspaceGeneration === this.workspaceGeneration && initializingSession !== undefined && !['terminated', 'error'].includes(initializingSession.state);
		const session = await DebugSession.start({
			id, admitted: true, configuration: current, sessionOptions,
			processService: this.processes,
			resolvedConfiguration: factory?.createDebugAdapterDescriptor ? { ...resolvedConfiguration, adapter: undefined } : resolvedConfiguration,
			workspace: root, breakpoints: () => this.currentBreakpoints,
			additionalBreakpoints: () => [...this.currentFunctionBreakpoints, ...this.currentDataBreakpoints, ...this.currentInstructionBreakpoints],
			runInTerminal: value => {
				const terminalGeneration = this.terminalGeneration;
				const assertCurrent = (): void => {
					if (this.isDisposed || workspaceGeneration !== this.workspaceGeneration || terminalGeneration !== this.terminalGeneration
						|| !initializingSession || this.getSession(initializingSession.id) !== initializingSession
						|| ['terminated', 'error'].includes(initializingSession.state)) {
						throw new CancellationError();
					}
				};
				assertCurrent();
				const os = this.terminalProcesses.operatingSystem;
				if (os === undefined) throw new Error(localize('terminal.profile.platformUnavailable', 'The terminal execution host is not ready.'));
				return runDebuggeeInTerminal(
					this.terminals, this.terminalProfiles,
					{ os, remoteAuthority: root && getRemoteAuthority(root), workspaceFolder: folder, allowAutomationShell: true },
					value, assertCurrent, current.dirId ?? undefined,
				);
			},
			startDebugging: value => this.startChildSession(initializingSession!, value),
			updateBreakpoints: updates => { if (acceptsBreakpointEvents()) this.acceptBreakpointUpdates(updates); },
			addBreakpoint: (source, line, column, id) => {
				if (!initializingSession || !acceptsBreakpointEvents()) return undefined;
				const resource = getUriFromSource(source, source.path, initializingSession.id, this.uriIdentity, this.logService);
				const existing = this.currentBreakpoints.find(point => this.uriIdentity.extUri.isEqual(point.resource, resource) && point.lineNumber === line && point.columnNumber === column);
				if (existing) return existing.enabled ? existing : undefined;
				const point = Object.freeze({ id: id ?? generateUuid(), resource, lineNumber: line, ...(column === undefined ? {} : { columnNumber: column }), enabled: true, verified: false });
				this.currentBreakpoints = Object.freeze([...this.currentBreakpoints, point].sort(compareBreakpoints));
				this.persistState();
				return point;
			},
			removeBreakpoint: id => {
				if (!acceptsBreakpointEvents()) return;
				this.currentBreakpoints = Object.freeze(this.currentBreakpoints.filter(point => point.id !== id));
				this.currentFunctionBreakpoints = Object.freeze(this.currentFunctionBreakpoints.filter(point => point.id !== id));
				this.currentDataBreakpoints = Object.freeze(this.currentDataBreakpoints.filter(point => point.id !== id));
				this.currentInstructionBreakpoints = Object.freeze(this.currentInstructionBreakpoints.filter(point => point.id !== id));
				this.breakpointsEmitter.fire(this.allBreakpoints());
				this.persistState();
			},
			exceptionBreakpoints: () => this.exceptionBreakpointsByType[resolvedConfiguration.type],
			onWillStart: session => { assertParent(); initializingSession = session; this.preparingSessions.set(session.id, session); this.willSessionEmitter.fire(session); },
			createDebugAdapterTrackers: session => this.createAdapterTrackers(session, generation),
			createDebugAdapterDescriptor: factory?.createDebugAdapterDescriptor ? async session => {
				const controller = new AbortController();
				this.pendingDescriptors.add(controller);
				this.descriptorControllers.set(session.id, controller);
				this.bindDescriptorOwner(controller, factory!);
				try {
					if (this.adapters.get(resolvedConfiguration.type) !== factory) throw new CancellationError();
					const pending = Promise.resolve(factory!.createDebugAdapterDescriptor!(resolvedConfiguration, controller.signal, session));
					void pending.then(adapter => { if (controller.signal.aborted || generation !== this.workspaceGeneration || this.isDisposed) { void adapter?.inline?.close().catch(() => { }); } }, () => { });
					const adapter = await raceCancellationError(pending, controller.signal);
					if (generation !== this.workspaceGeneration || this.isDisposed || controller.signal.aborted) { await adapter?.inline?.close().catch(() => { }); throw new CancellationError(); }
					return adapter;
				} finally { this.pendingDescriptors.delete(controller); this.descriptorControllers.delete(session.id); this.descriptorOwners.delete(controller); }
			} : undefined,
		}).catch(async error => {
			if (initializingSession) {
				this.preparingSessions.delete(initializingSession.id);
				await this.stopChildSessions(initializingSession);
				this.endSessionEmitter.fire(initializingSession);
			}
			throw error;
		});
		this.preparingSessions.delete(session.id);
		if (generation !== this.workspaceGeneration || this.isDisposed || sessionOptions.parentSession && this.getSession(sessionOptions.parentSession.id) !== sessionOptions.parentSession) {
			// Initialization can finish after the workspace or service lifetime ends.
			// Release the returned process before publishing a session to any consumer.
			try { await session.disconnect(); } finally { session.dispose(); await this.stopChildSessions(session); this.endSessionEmitter.fire(session); }
			throw new CancellationError();
		}
		const listener = new DisposableStore();
		listener.add(session.onDidChangeExceptionBreakpoints(() => { if (this.session === session) this.exceptionBreakpointsEmitter.fire(this.exceptionBreakpoints); }));
		listener.add(session.onDidChangeName(() => this.sessionEmitter.fire(this.session)));
		listener.add(session.onDidChangeThread(() => {
			if (this.session === session) this.focusStackFrame(undefined);
		}));
		listener.add(session.onDidChangeState(state => {
			if (this.session === session && state !== "stopped") this.focusStackFrame(undefined);
			if (this.sessionRecords.has(session.id)) this.sessionEmitter.fire(this.session);
			if (state === "terminated" || state === "error") queueMicrotask(() => { void this.finishSession(session); });
		}));
		this.sessionRecords.set(session.id, { session, workspaceGeneration, workspaceId: this.workspace.getWorkspace().id, listener, postDebugTask: resolvedConfiguration.postDebugTask });
		this.viewModel.setFocus(undefined, undefined, session, true);
		this.newSessionEmitter.fire(session);
		this.sessionEmitter.fire(session);
		this.exceptionBreakpointsEmitter.fire(this.exceptionBreakpoints);
		if (session.state === "terminated" || session.state === "error") { await this.finishSession(session); }
		return session;
	}

	private normalizeSessionOptions(options: IDebugSessionOptions): IDebugSessionOptions {
		if (!options || typeof options !== 'object' || Array.isArray(options)
			|| Object.keys(options).some(key => !['parentSession', 'lifecycleManagedByParent', 'consoleMode', 'noDebug', 'suppressSaveBeforeStart'].includes(key))
			|| [options.noDebug, options.lifecycleManagedByParent, options.suppressSaveBeforeStart].some(value => value !== undefined && typeof value !== 'boolean')
			|| options.consoleMode !== undefined && options.consoleMode !== DebugConsoleMode.Separate && options.consoleMode !== DebugConsoleMode.MergeWithParent) {
			throw new TypeError(localize('debug.invalidSessionOptions', 'Invalid debug session options.'));
		}
		if (options.parentSession && (this.getSession(options.parentSession.id) !== options.parentSession || ['terminated', 'error'].includes(options.parentSession.state))) {
			throw new Error(localize('debug.parentSessionEnded', 'The parent debug session has ended.'));
		}
		return Object.freeze({ ...options });
	}

	private async startChildSession(parent: IDebugSession, value: unknown): Promise<void> {
		const input = record(value, 'startDebugging arguments');
		if (input.request !== 'launch' && input.request !== 'attach') throw new TypeError(localize('debug.invalidStartDebuggingRequest', 'A startDebugging request must specify launch or attach.'));
		const configuration = record(input.configuration, 'startDebugging configuration');
		const parsed = this.parseProviderConfiguration({ ...configuration, type: parent.resolvedConfiguration?.type ?? parent.configuration.type, name: configuration.name || parent.name, request: input.request });
		// DAP requests start without a selected folder. An explicitly configured
		// executable still supplies the same adapter when no type factory exists.
		const executable = parent.resolvedConfiguration?.adapter ?? parent.configuration.adapter;
		const child = Object.freeze({
			...parsed, dirId: null,
			...(parent.configuration.adapterExplicit && parsed.adapterExplicit === false ? { adapter: executable, adapterExplicit: true } : {}),
		});
		await this.startDebugging(child, { parentSession: parent });
	}

	private cancelPendingDescriptors(): void {
		for (const controller of this.launchControllers.values()) controller.abort();
		for (const controller of this.pendingDescriptors) controller.abort();
		this.pendingDescriptors.clear();
		this.descriptorOwners.clear();
	}

	private bindDescriptorOwner(controller: AbortController, owner: object): void {
		let owners = this.descriptorOwners.get(controller);
		if (!owners) this.descriptorOwners.set(controller, owners = new Set());
		owners.add(owner);
	}

	private cancelRetiredDescriptors(retired: readonly object[]): void {
		for (const [controller, owners] of this.descriptorOwners) {
			if (retired.some(owner => owners.has(owner))) controller.abort();
		}
	}

	async startCompound(compound: IDebugCompound): Promise<readonly IDebugSession[]> {
		const current = this.compounds.find(candidate => candidate.id === compound.id);
		if (!current) throw new Error("Debug compound is no longer present in launch.json");
		// Resolve the entire group before a pre-launch task can have side effects.
		const configurations = current.configurations.map(reference => resolveCompoundConfiguration(reference, this.configurations, current.dirId));
		await this.runTask(current.preLaunchTask, "compound preLaunchTask", current.dirId);
		const started: IDebugSession[] = [];
		try {
			for (const configuration of configurations) started.push(await this.start(configuration));
		} catch (error) {
			await Promise.allSettled(started.map(session => this.stop(session)));
			throw error;
		}
		if (current.stopAll) {
			let stopping = false;
			for (const session of started) this.sessionRecords.get(session.id)?.listener.add(session.onDidChangeState(state => {
				if (stopping || (state !== "terminated" && state !== "error")) return;
				stopping = true;
				void Promise.allSettled(started.filter(candidate => candidate !== session).map(candidate => this.stop(candidate)));
			}));
		}
		return Object.freeze(started);
	}

	setActiveSession(session: IDebugSession): void {
		if (!this.sessionRecords.has(session.id)) throw new Error("Debug session is no longer active");
		if (this.viewModel.focusedSession === session) return;
		this.viewModel.setFocus(undefined, undefined, session, true);
		this.sessionEmitter.fire(session);
		this.exceptionBreakpointsEmitter.fire(this.exceptionBreakpoints);
	}

	focusStackFrame(frame: IDebugStackFrame | undefined, thread?: IDebugThread): void {
		const session = this.session;
		if (frame && session?.state !== 'stopped') throw new Error('A stack frame requires the active paused session');
		this.viewModel.setFocus(frame, thread, session, true);
	}

	async restart(session: IDebugSession | undefined = this.session): Promise<IDebugSession> {
		if (!session) throw new Error("There is no active debug session to restart");
		if (!this.sessionRecords.has(session.id)) throw new Error("Debug session is no longer active");
		const target = await this.processes!.manageSession(session.id, 'route');
		if (target.lifecycleTargetId !== session.id) return this.restart(this.getSession(target.lifecycleTargetId));
		if (session.capabilities.supportsRestart) { await session.restart(); return session; }
		const configuration = session.configuration;
		await this.stop(session);
		return this.startDebugging(configuration, session.sessionOptions);
	}

	async stop(session: IDebugSession | undefined = this.session): Promise<void> {
		if (!session) return;
		const target = await this.processes!.manageSession(session.id, 'route');
		if (target.lifecycleTargetId !== session.id) return this.stop(this.getSession(target.lifecycleTargetId));
		const record = this.sessionRecords.get(session.id);
		if (!record) {
			if (this.preparingSessions.get(session.id) === session) {
				this.preparingSessions.delete(session.id);
				this.descriptorControllers.get(session.id)?.abort();
				try { await session.disconnect(); } finally { session.dispose(); await this.stopChildSessions(session); }
			}
			return;
		}
		await record.session.disconnect();
		await (record.completion ?? this.finishSession(record.session));
	}

	async stopAll(): Promise<void> {
		await Promise.allSettled([...this.sessions, ...this.preparingSessions.values()].map(session => this.stop(session)));
	}

	addBreakpoints(points: readonly (IDebugBreakpoint | IFunctionBreakpoint)[]): void {
		this.assertNotDisposed();
		const currentIds = new Set(this.allBreakpoints().map(point => point.id));
		const added = points.map(point => {
			const id = normalizePersistedString(point.id, 'breakpoint ID', 32768);
			if (typeof point.enabled !== 'boolean') throw new TypeError('Breakpoint enabled must be a boolean');
			const state = { id, enabled: point.enabled, verified: false, ...breakpointConditions(point), ...(point.logMessage === undefined ? {} : { logMessage: normalizeBreakpointExpression(point.logMessage, 'logMessage') }) };
			if ('kind' in point) {
				return Object.freeze({ ...state, kind: 'function' as const, name: normalizePersistedString(point.name, 'function breakpoint name', 32768) });
			}
			if (!Number.isSafeInteger(point.lineNumber) || point.lineNumber < 1 || point.columnNumber !== undefined && (!Number.isSafeInteger(point.columnNumber) || point.columnNumber < 1)) throw new TypeError('Breakpoint position must be positive integers');
			return Object.freeze({
				...state, resource: point.resource, lineNumber: point.lineNumber,
				...(point.columnNumber === undefined ? {} : { columnNumber: point.columnNumber }),
				...(point.logMessage === undefined ? {} : { logMessage: normalizeBreakpointExpression(point.logMessage, 'logMessage') }),
			});
		}).filter(point => {
			if (currentIds.has(point.id)) return false;
			currentIds.add(point.id);
			return true;
		});
		if (added.length === 0) return;
		this.currentBreakpoints = Object.freeze([...this.currentBreakpoints, ...added.filter((point): point is IDebugBreakpoint => 'resource' in point)].sort(compareBreakpoints));
		this.currentFunctionBreakpoints = Object.freeze([...this.currentFunctionBreakpoints, ...added.filter((point): point is IFunctionBreakpoint => 'kind' in point)]);
		this.breakpointStateChanged();
	}

	removeBreakpoints(ids: readonly string[]): void {
		this.assertNotDisposed();
		const removed = new Set(ids.map(id => normalizePersistedString(id, 'breakpoint ID', 32768)));
		this.currentBreakpoints = Object.freeze(this.currentBreakpoints.filter(point => !removed.has(point.id)));
		this.currentFunctionBreakpoints = Object.freeze(this.currentFunctionBreakpoints.filter(point => !removed.has(point.id)));
		this.currentDataBreakpoints = Object.freeze(this.currentDataBreakpoints.filter(point => !removed.has(point.id)));
		this.currentInstructionBreakpoints = Object.freeze(this.currentInstructionBreakpoints.filter(point => !removed.has(point.id)));
		this.breakpointStateChanged([{ kind: 'remove', ids: [...removed] }]);
	}

	toggleBreakpoint(resource: URI, lineNumber: number): void {
		if (!Number.isSafeInteger(lineNumber) || lineNumber <= 0) throw new RangeError("Breakpoint line number must be positive");
		const existing = this.currentBreakpoints.find(breakpoint => breakpoint.resource.toString() === resource.toString() && breakpoint.lineNumber === lineNumber);
		this.currentBreakpoints = existing ? Object.freeze(this.currentBreakpoints.filter(breakpoint => breakpoint !== existing)) : Object.freeze([...this.currentBreakpoints, createBreakpoint(resource, lineNumber, true)].sort(compareBreakpoints));
		this.breakpointStateChanged();
	}

	removeBreakpoint(id: string): void {
		this.currentBreakpoints = Object.freeze(this.currentBreakpoints.filter(breakpoint => breakpoint.id !== id));
		this.currentFunctionBreakpoints = Object.freeze(this.currentFunctionBreakpoints.filter(breakpoint => breakpoint.id !== id));
		this.currentDataBreakpoints = Object.freeze(this.currentDataBreakpoints.filter(breakpoint => breakpoint.id !== id));
		this.currentInstructionBreakpoints = Object.freeze(this.currentInstructionBreakpoints.filter(breakpoint => breakpoint.id !== id));
		this.breakpointStateChanged([{ kind: 'remove', ids: [id] }]);
	}

	updateBreakpoint(id: string, update: IDebugBreakpointUpdate): void {
		const breakpoint = this.allBreakpoints().find(candidate => candidate.id === id);
		if (!breakpoint) throw new Error("Breakpoint is no longer present");
		const patch = { ...update };
		for (const field of ["condition", "hitCondition", "logMessage"] as const) {
			if (update[field] !== undefined) patch[field] = normalizeBreakpointExpression(update[field], field);
		}
		if (patch.name !== undefined) {
			if (!("kind" in breakpoint) || breakpoint.kind !== "function") throw new TypeError("Only function breakpoints have a name");
			patch.name = normalizePersistedString(patch.name, "name", 32_768);
		}
		if (patch.accessType !== undefined && (!("kind" in breakpoint) || breakpoint.kind !== "data" || !breakpoint.accessTypes.includes(patch.accessType))) throw new TypeError("Unsupported data breakpoint access type");
		if (patch.instructionReference !== undefined || patch.offset !== undefined) {
			if (!("kind" in breakpoint) || breakpoint.kind !== "instruction") throw new TypeError("Only instruction breakpoints have an instruction reference or offset");
			if (patch.instructionReference !== undefined) patch.instructionReference = normalizeBreakpointReference(patch.instructionReference, "instructionReference");
			if (patch.offset !== undefined && !Number.isSafeInteger(patch.offset)) throw new TypeError("Instruction offset must be an integer");
		}
		if (update.logMessage !== undefined && !("resource" in breakpoint)) throw new TypeError("Log messages require a source breakpoint");
		const change = <T extends IBaseBreakpoint>(points: readonly T[]): readonly T[] => Object.freeze(points.map(point => point.id === id ? Object.freeze({ ...point, ...patch, verified: false, message: undefined }) : point));
		this.currentBreakpoints = change(this.currentBreakpoints);
		this.currentFunctionBreakpoints = change(this.currentFunctionBreakpoints);
		this.currentDataBreakpoints = change(this.currentDataBreakpoints);
		this.currentInstructionBreakpoints = change(this.currentInstructionBreakpoints);
		this.breakpointStateChanged();
	}

	setBreakpointsEnabled(enabled: boolean): void {
		const change = <T extends IBaseBreakpoint>(points: readonly T[]): readonly T[] => Object.freeze(points.map(point => Object.freeze({ ...point, enabled, verified: false, message: undefined })));
		this.currentBreakpoints = change(this.currentBreakpoints);
		this.currentFunctionBreakpoints = change(this.currentFunctionBreakpoints);
		this.currentDataBreakpoints = change(this.currentDataBreakpoints);
		this.currentInstructionBreakpoints = change(this.currentInstructionBreakpoints);
		this.breakpointStateChanged([{ kind: 'setEnabled', enabled }]);
	}

	removeAllBreakpoints(): void {
		this.currentBreakpoints = Object.freeze([]);
		this.currentFunctionBreakpoints = Object.freeze([]);
		this.currentDataBreakpoints = Object.freeze([]);
		this.currentInstructionBreakpoints = Object.freeze([]);
		this.breakpointStateChanged([{ kind: 'clearBreakpoints' }]);
	}

	private breakpointStateChanged(commands: readonly DebugWorkspaceEdit[] = []): void {
		this.breakpointsEmitter.fire(this.allBreakpoints());
		this.persistState(commands);
		this.syncSessionBreakpoints();
	}

	addFunctionBreakpoint(options: IFunctionBreakpointOptions): void {
		this.addBreakpoints([{ kind: "function", id: generateUuid(), name: options.name, enabled: true, verified: false, ...breakpointConditions(options) }]);
	}

	addDataBreakpoint(options: IDataBreakpointOptions): void {
		const session = this.session;
		if (!session || session.id !== options.sessionId || session.state !== "stopped") throw new Error(localize("debug.dataRequiresPause", "Data breakpoints require the paused session that identified the variable."));
		if (!session.capabilities.supportsDataBreakpoints) throw new Error(localize("debug.unsupportedDataBreakpoints", "Debug Adapter does not support data breakpoints"));
		if (!options.accessTypes.includes(options.accessType)) throw new TypeError("Unsupported data breakpoint access type");
		const dataId = normalizeBreakpointReference(options.dataId, "dataId");
		this.currentDataBreakpoints = Object.freeze([...this.currentDataBreakpoints, Object.freeze({
			...options,
			dataId,
			accessTypes: Object.freeze([...options.accessTypes]),
			id: generateUuid(),
			kind: "data" as const,
			enabled: true,
			verified: false,
			adapterType: session.configuration.type,
			...breakpointConditions(options),
		})]);
		this.breakpointStateChanged();
	}

	addInstructionBreakpoint(options: IInstructionBreakpointOptions): void {
		const session = this.session;
		if (!session || session.state !== "stopped") throw new Error(localize("debug.instructionRequiresPause", "Instruction breakpoints require a paused debug session."));
		if (!session.capabilities.supportsInstructionBreakpoints) throw new Error(localize("debug.unsupportedInstructionBreakpoints", "Debug Adapter does not support instruction breakpoints"));
		if (options.offset !== undefined && !Number.isSafeInteger(options.offset)) throw new TypeError("Instruction offset must be an integer");
		const instructionReference = normalizeBreakpointReference(options.instructionReference, "instructionReference");
		this.currentInstructionBreakpoints = Object.freeze([...this.currentInstructionBreakpoints, Object.freeze({ ...options, instructionReference, id: generateUuid(), kind: "instruction" as const, enabled: true, verified: false, sessionId: session.id, ...breakpointConditions(options) })]);
		this.breakpointStateChanged();
	}

	private allBreakpoints(): readonly DebugBreakpoint[] {
		return Object.freeze([...this.currentBreakpoints, ...this.currentFunctionBreakpoints, ...this.currentDataBreakpoints, ...this.currentInstructionBreakpoints]);
	}

	addWatchExpression(expression: string): void {
		const normalized = normalizeExpression(expression);
		if (this.currentWatchExpressions.includes(normalized)) return;
		this.currentWatchExpressions = Object.freeze([...this.currentWatchExpressions, normalized]);
		this.watchExpressionsEmitter.fire(this.currentWatchExpressions);
		this.persistState();
	}

	removeWatchExpression(expression: string): void {
		const next = this.currentWatchExpressions.filter(candidate => candidate !== expression);
		if (next.length === this.currentWatchExpressions.length) return;
		this.currentWatchExpressions = Object.freeze(next);
		this.watchExpressionsEmitter.fire(this.currentWatchExpressions);
		this.persistState();
	}

	async setExceptionBreakpoints(filters: readonly string[]): Promise<void> {
		const session = this.session;
		if (!session) throw new Error("Exception breakpoints require an active debug session");
		const generation = this.workspaceGeneration;
		await session.setExceptionBreakpoints(filters);
		if (this.isDisposed || generation !== this.workspaceGeneration) throw new CancellationError();
		this.exceptionBreakpointsByType = Object.freeze({ ...this.exceptionBreakpointsByType, [session.configuration.type]: Object.freeze([...session.exceptionBreakpoints]) });
		this.exceptionBreakpointsEmitter.fire(this.exceptionBreakpoints);
		this.persistState();
	}

	private acceptBreakpointUpdates(updates: readonly { readonly id: string; readonly verified: boolean; readonly message?: string; }[]): void {
		if (updates.length === 0) return;
		const byId = new Map(updates.map(update => [update.id, update]));
		this.currentBreakpoints = Object.freeze(this.currentBreakpoints.map(breakpoint => {
			const update = byId.get(breakpoint.id);
			return update ? Object.freeze({ ...breakpoint, verified: update.verified, message: update.message }) : breakpoint;
		}));
		const accept = <T extends IBaseBreakpoint>(points: readonly T[]): readonly T[] => Object.freeze(points.map(point => {
			const update = byId.get(point.id);
			return update ? Object.freeze({ ...point, verified: update.verified, message: update.message }) : point;
		}));
		this.currentFunctionBreakpoints = accept(this.currentFunctionBreakpoints);
		this.currentDataBreakpoints = accept(this.currentDataBreakpoints);
		this.currentInstructionBreakpoints = accept(this.currentInstructionBreakpoints);
		this.breakpointsEmitter.fire(this.allBreakpoints());
	}

	private finishSession(session: DebugSession): Promise<void> {
		const record = this.sessionRecords.get(session.id);
		if (!record) return Promise.resolve();
		// Stop and adapter exit share the same release and post-task completion.
		return record.completion ??= this.releaseSession(record);
	}

	private async releaseSession(record: DebugSessionRecord): Promise<void> {
		const session = record.session;
		record.listener.dispose();
		this.currentDataBreakpoints = Object.freeze(this.currentDataBreakpoints.filter(point => point.canPersist || point.sessionId !== session.id));
		this.currentInstructionBreakpoints = Object.freeze(this.currentInstructionBreakpoints.filter(point => point.sessionId !== session.id));
		this.breakpointsEmitter.fire(this.allBreakpoints());
		await session.disconnect();
		await this.stopChildSessions(session);
		// Keep identity addressable while release is pending; requests observe
		// cancellation until adapter, inline implementation and children finish.
		this.sessionRecords.delete(session.id);
		this.endSessionEmitter.fire(session);
		if (this.viewModel.focusedSession === session) {
			this.viewModel.setFocus(undefined, undefined, this.sessions.at(-1), false);
		}
		this.sessionEmitter.fire(this.session);
		this.exceptionBreakpointsEmitter.fire(this.exceptionBreakpoints);
		try { await this.runTask(record.postDebugTask, "postDebugTask", session.configuration.dirId ?? undefined); }
		catch (error) { this.reportError(error); }
	}

	private async stopChildSessions(session: IDebugSession): Promise<void> {
		if (!this.processes) return;
		const relation = await this.processes.manageSession(session.id, 'end');
		// Rust has already revoked resources across directories. Release only the
		// editor/extension objects returned by its graph, without reconstructing it.
		await Promise.allSettled(relation.descendants.map(async id => {
			this.launchControllers.get(id)?.abort();
			const preparing = this.preparingSessions.get(id);
			if (preparing) {
				this.preparingSessions.delete(id);
				this.descriptorControllers.get(id)?.abort();
				try { await preparing.disconnect(); } finally { preparing.dispose(); }
			}
			const record = this.sessionRecords.get(id);
			if (record) {
				await record.session.disconnect();
				await (record.completion ?? this.finishSession(record.session));
			}
		}));
	}

	private async runTask(reference: string | undefined, role: string, dirId?: string, signal?: AbortSignal): Promise<void> {
		if (!reference) return;
		await this.tasks.refresh();
		const matches = this.tasks.tasks.filter(task =>
			(task.id === reference || task.label === reference)
			&& (dirId === undefined || task.dirId === undefined || task.dirId === dirId),
		);
		if (matches.length === 0) throw new Error(`Debug ${role} '${reference}' was not found`);
		if (matches.length > 1) throw new Error(`Debug ${role} '${reference}' is ambiguous`);
		const controller = new AbortController();
		using cancellation = linkCancellation(signal, controller);
		this.pendingDescriptors.add(controller);
		let run: Awaited<ReturnType<ITaskService['run']>> | undefined;
		try {
			throwIfCancelled(controller.signal);
			run = await this.tasks.run(matches[0]!, controller.signal);
			const status = await waitForTask(run, controller.signal);
			if (status !== 'succeeded' || run.hasErrors) throw new Error(`Debug ${role} '${reference}' ${run.hasErrors ? 'reported errors' : status}${run.exitCode === undefined ? '' : ` with exit code ${run.exitCode}`}`);
		} catch (error) {
			if (run?.status === 'running') await this.tasks.terminate(run);
			throw error;
		} finally {
			this.pendingDescriptors.delete(controller);
		}
	}

	private restoreState(state: Readonly<PersistedDebugState>): void {
		this.currentBreakpoints = Object.freeze(state.breakpoints.map(value => Object.freeze({ ...createBreakpoint(URI.parse(value.resource), value.lineNumber, value.enabled), ...(value.id === undefined ? {} : { id: value.id }), ...(value.columnNumber === undefined ? {} : { columnNumber: value.columnNumber }), ...breakpointExpressions(value) })).sort(compareBreakpoints));
		this.currentFunctionBreakpoints = Object.freeze(state.functionBreakpoints.map(point => Object.freeze({ ...point, verified: false })));
		this.currentDataBreakpoints = Object.freeze([...state.dataBreakpoints.map(point => Object.freeze({ ...point, verified: false })), ...this.currentDataBreakpoints.filter(point => !point.canPersist)]);
		this.currentWatchExpressions = Object.freeze([...state.watchExpressions]);
		this.exceptionBreakpointsByType = Object.freeze(Object.fromEntries(Object.entries(state.exceptionBreakpoints).map(([type, filters]) => [type, Object.freeze([...filters])])));
		this.breakpointsEmitter.fire(this.allBreakpoints());
		this.watchExpressionsEmitter.fire(this.currentWatchExpressions);
		this.exceptionBreakpointsEmitter.fire(this.exceptionBreakpoints);
		this.syncSessionBreakpoints();
	}

	private syncSessionBreakpoints(): void {
		for (const record of this.sessionRecords.values()) {
			// A previous workspace's adapter can still be acknowledging disconnect
			// when the new workspace publishes its first definitions snapshot.
			if (record.workspaceGeneration === this.workspaceGeneration && record.workspaceId === this.workspace.getWorkspace().id) void record.session.syncBreakpoints().catch(error => this.reportError(error));
		}
	}

	private persistState(commands: readonly DebugWorkspaceEdit[] = []): void {
		const state: PersistedDebugState = {
			version: 2,
			breakpoints: this.currentBreakpoints.map(breakpoint => ({
				...(breakpoint.id === `${breakpoint.resource.toString()}:${breakpoint.lineNumber}` ? {} : { id: breakpoint.id }),
				...(breakpoint.columnNumber === undefined ? {} : { columnNumber: breakpoint.columnNumber }),
				resource: breakpoint.resource.toString(),
				lineNumber: breakpoint.lineNumber,
				enabled: breakpoint.enabled,
				...breakpointExpressions(breakpoint),
			})),
			functionBreakpoints: this.currentFunctionBreakpoints,
			dataBreakpoints: this.currentDataBreakpoints.filter(point => point.canPersist),
			watchExpressions: this.currentWatchExpressions,
			exceptionBreakpoints: this.exceptionBreakpointsByType,
		};
		this.debugStorage.storeState(state, commands);
	}


	private reportError(error: unknown): void {
		this.logService.error("debug.service", "Debug service operation failed", error);
	}
}

function childResource(root: URI, relativePath: string): URI { return URI.joinPath(root, ...relativePath.split("/")); }
function createBreakpoint(resource: URI, lineNumber: number, enabled: boolean): IDebugBreakpoint { return Object.freeze({ id: `${resource.toString()}:${lineNumber}`, resource, lineNumber, enabled, verified: false }); }
function compareBreakpoints(left: IDebugBreakpoint, right: IDebugBreakpoint): number { return left.resource.toString().localeCompare(right.resource.toString()) || left.lineNumber - right.lineNumber; }
function normalizeBreakpointExpression(value: string, field: string): string | undefined {
	if (value.length > 32_768 || value.includes("\0")) throw new TypeError(`${field} must contain at most 32768 characters and no null characters`);
	return value.trim() ? value : undefined;
}
function breakpointExpressions(value: Pick<IDebugBreakpoint, "condition" | "hitCondition" | "logMessage">) {
	return {
		...(value.condition === undefined ? {} : { condition: value.condition }),
		...(value.hitCondition === undefined ? {} : { hitCondition: value.hitCondition }),
		...(value.logMessage === undefined ? {} : { logMessage: value.logMessage }),
	};
}

function breakpointConditions(value: Pick<IBaseBreakpoint, "condition" | "hitCondition">): Pick<IBaseBreakpoint, "condition" | "hitCondition"> {
	return {
		condition: value.condition === undefined ? undefined : normalizeBreakpointExpression(value.condition, "condition"),
		hitCondition: value.hitCondition === undefined ? undefined : normalizeBreakpointExpression(value.hitCondition, "hitCondition"),
	};
}
function normalizeExpression(expression: string): string {
	const normalized = expression.trim();
	if (!normalized || normalized.length > 32_768 || normalized.includes("\0")) throw new TypeError("Watch expression must contain 1 to 32768 characters");
	return normalized;
}

function resolveCompoundConfiguration(reference: IDebugCompound["configurations"][number], configurations: readonly IDebugConfiguration[], dirId?: string): IDebugConfiguration {
	const name = typeof reference === "string" ? reference : reference.name;
	const matches = configurations.filter(configuration => {
		if (configuration.id !== name && configuration.name !== name) return false;
		return typeof reference === "string"
			? dirId === undefined || configuration.dirId === dirId
			: configuration.workspaceFolderName === reference.folder;
	});
	if (matches.length === 0) throw new Error(`Debug compound configuration '${name}' was not found`);
	if (matches.length > 1) throw new Error(`Debug compound configuration '${name}' is ambiguous`);
	return matches[0]!;
}

function normalizePersistedString(value: unknown, path: string, maximum: number): string {
	if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) throw new TypeError(`${path} must contain 1 to ${maximum} characters`);
	return value.trim();
}

function normalizeBreakpointReference(value: unknown, field: string): string {
	// DAP references are opaque adapter identifiers; whitespace is part of their identity.
	if (typeof value !== "string" || !value.trim() || value.length > 32_768 || value.includes("\0")) throw new TypeError(`${field} must contain 1 to 32768 characters`);
	return value;
}


interface RunInTerminalArguments {
	readonly kind: "integrated" | "external";
	readonly title: string | undefined;
	readonly cwd: string | undefined;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string | null>>;
	readonly argsCanBeInterpretedByShell: boolean;
}

/** Launches a DAP-requested debuggee through the existing integrated terminal boundary. */
async function runDebuggeeInTerminal(
	terminalService: ITerminalService,
	profiles: ITerminalProfileResolverService,
	options: IShellLaunchConfigResolveOptions,
	value: unknown,
	assertCurrent: () => void,
	dirId?: string,
): Promise<Readonly<{ shellProcessId: number; }>> {
	const request = parseRunInTerminalArguments(value);
	if (request.kind === "external") throw new Error("External debug terminals are not supported; use an integrated terminal");
	const profile = await profiles.getDefaultProfile(options);
	assertCurrent();
	const shell: IShellLaunchConfig = { name: profile.profileName, executable: profile.path, args: profile.args, env: profile.env, icon: profile.icon, color: profile.color };
	await profiles.resolveShellLaunchConfig(shell, options);
	assertCurrent();
	// DAP environment and cwd are literal adapter data. Resolve configuration
	// first, then apply these values without interpreting variable expressions.
	const env: Record<string, string | null> = {};
	mergeEnvironments(env, shell.env, options.os !== OperatingSystem.Windows);
	mergeEnvironments(env, request.env, options.os !== OperatingSystem.Windows);
	const executable = typeof shell.executable === 'string' ? shell.executable : shell.executable![0]!;
	const terminal = await terminalService.createTerminal({
		dirId, dimensions: { rows: 30, cols: 120 },
		profile: { type: 'custom', name: profile.profileName, path: [executable], args: shell.args ?? [] },
		title: request.title ?? localize('debug.terminalTitle', 'Debug'), env, cwd: request.cwd ?? shell.cwd, icon: shell.icon, color: shell.color,
	});
	try {
		assertCurrent();
		if (terminal.state !== 'running') throw new Error(localize('debug.terminalUnavailable', 'The terminal is unavailable. The debug command was not sent. Restart debugging.'));
		await terminal.sendText(terminalCommand(request, executable), true);
		assertCurrent();
	} catch (error) {
		// Preserve the dispatch error even if the unavailable transport also rejects close.
		await terminalService.closeTerminal(terminal).catch(() => { });
		throw error;
	}
	return Object.freeze({ shellProcessId: terminal.processId });
}

function parseRunInTerminalArguments(value: unknown): RunInTerminalArguments {
	const input = record(value, "runInTerminal arguments");
	const kind = input.kind === undefined ? "integrated" : input.kind;
	if (kind !== "integrated" && kind !== "external") throw new TypeError("runInTerminal kind must be 'integrated' or 'external'");
	const args = stringArray(input.args, "runInTerminal args", 256, 4096);
	if (args.length === 0) throw new TypeError("runInTerminal args must contain the executable");
	const env = input.env === undefined ? {} : environment(input.env);
	return Object.freeze({ kind, title: optionalString(input.title, "runInTerminal title", 256), cwd: optionalString(input.cwd, "runInTerminal cwd", 4096), args, env, argsCanBeInterpretedByShell: input.argsCanBeInterpretedByShell === true });
}

function terminalCommand(request: RunInTerminalArguments, executable: string): string {
	const shell = shellKind(executable);
	const command = request.argsCanBeInterpretedByShell ? request.args.join(" ") : request.args.map(argument => quote(argument, shell)).join(" ");
	const prefix = shell === "powershell" ? powershellPrefix(request) : shell === "cmd" ? cmdPrefix(request) : posixPrefix(request);
	return prefix ? `${prefix}${command}` : command;
}

function powershellPrefix(request: RunInTerminalArguments): string {
	const parts: string[] = [];
	if (request.cwd) parts.push(`Set-Location -LiteralPath ${quote(request.cwd, "powershell")}`);
	return parts.length > 0 ? `${parts.join("; ")}; & ` : "& ";
}

function cmdPrefix(request: RunInTerminalArguments): string {
	const parts: string[] = [];
	if (request.cwd) parts.push(`cd /d ${quote(request.cwd, "cmd")}`);
	return parts.length > 0 ? `${parts.join(" && ")} && ` : "";
}

function posixPrefix(request: RunInTerminalArguments): string {
	return request.cwd ? `cd -- ${quote(request.cwd, "posix")} && ` : "";
}

function quote(value: string, shell: "powershell" | "cmd" | "posix"): string {
	if (shell === "powershell") return escapeNonWindowsPath(value, GeneralShellType.PowerShell);
	if (shell === "cmd") {
		if (/[\r\n]/.test(value)) throw new TypeError("cmd debug terminal arguments cannot contain line breaks");
		return `"${value.replaceAll("%", "%%").replaceAll("\"", "\\\"")}"`;
	}
	return escapeNonWindowsPath(value);
}

function shellKind(executable: string): "powershell" | "cmd" | "posix" {
	const basename = executable.split(/[\\/]/).at(-1)!.replace(/\.exe$/i, '');
	if (/^(?:powershell|pwsh)$/i.test(basename)) return "powershell";
	if (/^(?:cmd|command-prompt)$/i.test(basename)) return "cmd";
	return "posix";
}

function environment(value: unknown): Readonly<Record<string, string | null>> {
	const input = record(value, "runInTerminal env");
	if (Object.keys(input).length > 128) throw new RangeError("runInTerminal env cannot contain more than 128 entries");
	return Object.freeze(Object.fromEntries(Object.entries(input).map(([key, item]) => {
		if (!key || key.length > 256 || /[=\0]/.test(key)) throw new TypeError(`runInTerminal env key '${key}' is invalid`);
		if (item !== null && (typeof item !== "string" || item.length > 32_768 || item.includes("\0"))) throw new TypeError(`runInTerminal env '${key}' must be a bounded string or null`);
		return [key, item as string | null];
	})));
}

function stringArray(value: unknown, path: string, maximumItems: number, maximumLength: number): readonly string[] {
	if (!Array.isArray(value) || value.length > maximumItems) throw new TypeError(`${path} must be an array with at most ${maximumItems} items`);
	return Object.freeze(value.map((item, index) => {
		if (typeof item !== "string" || item.length > maximumLength || item.includes("\0")) throw new TypeError(`${path}[${index}] must be a bounded string`);
		return item;
	}));
}

function optionalString(value: unknown, path: string, maximumLength: number): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length > maximumLength || value.includes("\0")) throw new TypeError(`${path} must be a bounded string`);
	return value;
}

function record(value: unknown, path: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
	return value as Record<string, unknown>;
}


function toExtensionDebugConfiguration(configuration: IDebugConfiguration): DebugConfiguration {
	// Extension mutations belong to this callback, never the source used for restart.
	return JSON.parse(JSON.stringify({
		...configuration.arguments,
		name: configuration.name, type: configuration.type, request: configuration.request,
		...(configuration.adapter === undefined || configuration.adapterExplicit === false ? {} : { debugAdapter: { ...(configuration.adapter.connection ? { connection: configuration.adapter.connection } : { program: configuration.adapter.program }), args: configuration.adapter.arguments, ...(configuration.adapter.cwd === undefined ? {} : { cwd: configuration.adapter.cwd }), ...(configuration.adapter.env === undefined ? {} : { env: configuration.adapter.env }) } }),
		...(configuration.preLaunchTask === undefined ? {} : { preLaunchTask: configuration.preLaunchTask }),
		...(configuration.postDebugTask === undefined ? {} : { postDebugTask: configuration.postDebugTask }),
	}));
}

registerWorkbenchServiceContribution({
	service: IDebugService,
	dependencies: [
		IExtensionService, IFileService, IWorkspaceContextService, IDebugAdapterProcessService,
		ITerminalService, ITerminalProfileResolverService, ITerminalProcessService,
		IStorageService, ILifecycleService, ITaskService, IAdapterManager, ILogService, IConfigurationResolverService,
		IConfigurationService, IEditorService, IEditorGroupsService,
	],
	install: context => {
		const service = context.register(context.container.createInstance(DebugService));
		return service;
	},
});

function linkCancellation(signal: AbortSignal | undefined, controller: AbortController) {
	const cancel = () => controller.abort();
	signal?.addEventListener('abort', cancel, { once: true });
	if (signal?.aborted) cancel();
	return toDisposable(() => signal?.removeEventListener('abort', cancel));
}
