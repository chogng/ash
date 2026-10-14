import { TerminalProcessExtHostProxy } from '../../contrib/terminal/browser/terminalProcessExtHostProxy.js';
import { IEnvironmentVariableService } from '../../contrib/terminal/common/environmentVariable.js';
import { deserializeEnvironmentDescriptionMap, deserializeEnvironmentVariableCollection } from '../../../platform/terminal/common/environmentVariableShared.js';
import { CancellationError } from '../../../base/common/errors.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { localize } from '../../../nls.js';
import { ITerminalProcessService, type IShellLaunchConfig, type TerminalArguments } from '../../../platform/terminal/common/terminal.js';
import { getRemoteAuthority } from '../../../platform/remote/common/remoteHosts.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { IExtensionService } from '../../services/extensions/common/extensionService.js';
import { ITerminalService, type ITerminalInstance } from '../../services/terminal/browser/terminal.js';
import { ITerminalProfileResolverService, ITerminalProfileService } from '../../services/terminal/common/terminal.js';
import type { ExtensionHostProviderInvoker } from './extensionHostLanguageBridge.js';
import type { JsonValue } from '../../../platform/agentHost/common/extensionHostApi.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { RequestStore } from '../../../platform/terminal/common/requestStore.js';
import { addDisposableListener } from '../../../base/browser/dom.js';

type ProfileReply = { value: JsonValue; } | { error: unknown; };

export interface ExtensionTerminalProfileRegistration {
	readonly runtimeId: string;
	readonly packageDigest: string;
	readonly profileId: string;
	readonly title: string;
	readonly invoke: ExtensionHostProviderInvoker;
}

export interface ExtensionTerminalEnvironmentRegistration {
	readonly runtimeId: string;
	readonly packageDigest: string;
	readonly invoke: ExtensionHostProviderInvoker;
}

/** Binds incarnation-owned callbacks to the existing terminal profile and instance owners. */
export class MainThreadTerminalService extends Disposable {
	private readonly registrations = this._register(new DisposableMap<string, DisposableStore>());
	private readonly descriptors = new Map<string, ExtensionTerminalProfileRegistration>();
	private workspaceGeneration = 0;
	private readonly environmentRegistrations = this._register(new DisposableMap<string, DisposableStore>());
	private readonly environmentDescriptors = new Map<string, ExtensionTerminalEnvironmentRegistration>();

	constructor(
		@ITerminalProfileService private readonly profiles: ITerminalProfileService,
		@ITerminalProfileResolverService private readonly resolver: ITerminalProfileResolverService,
		@ITerminalService private readonly terminals: ITerminalService,
		@IExtensionService private readonly extensions: IExtensionService,
		@ITerminalProcessService private readonly processes: ITerminalProcessService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IEnvironmentVariableService private readonly environmentVariables: IEnvironmentVariableService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@ILogService private readonly log: ILogService,
	) {
		super();
		this._register(workspace.onDidChangeWorkspace(() => this.workspaceGeneration++));
	}

	replaceEnvironmentProviders(next: readonly ExtensionTerminalEnvironmentRegistration[]): void {
		if (this.isDisposed) throw new CancellationError();
		const keys = new Set(next.map(descriptor => descriptor.runtimeId));
		if (keys.size !== next.length) throw invalid();
		for (const key of this.environmentDescriptors.keys()) {
			if (keys.has(key)) continue;
			this.environmentRegistrations.deleteAndDispose(key);
			this.environmentDescriptors.delete(key);
		}
		for (const descriptor of next) {
			const key = descriptor.runtimeId;
			if (this.environmentDescriptors.get(key) === descriptor) continue;
			const extension = this.extensions.currentCatalog.extensions.find(extension => extension.packageSha256 === descriptor.packageDigest);
			if (!extension) throw invalid();
			this.environmentRegistrations.deleteAndDispose(key);
			this.environmentDescriptors.delete(key);
			const lifetime = new DisposableStore();
			const controller = new AbortController();
			lifetime.add(toDisposable(() => controller.abort()));
			lifetime.add(this.environmentVariables.registerCollectionProvider(extension.id, async () => {
				const snapshot = record(await descriptor.invoke('getTerminalEnvironment', {}, controller.signal));
				if (Object.keys(snapshot).some(key => !['persistent', 'map', 'descriptionMap'].includes(key))) throw invalid();
				if (typeof snapshot.persistent !== 'boolean') throw invalid();
				return { persistent: snapshot.persistent, map: deserializeEnvironmentVariableCollection(snapshot.map), descriptionMap: snapshot.descriptionMap === undefined ? undefined : deserializeEnvironmentDescriptionMap(snapshot.descriptionMap) };
			}));
			this.environmentRegistrations.set(key, lifetime);
			this.environmentDescriptors.set(key, descriptor);
		}
	}

	replaceProfiles(next: readonly ExtensionTerminalProfileRegistration[]): void {
		if (this.isDisposed) throw new CancellationError();
		const keys = new Set(next.map(profile => `${profile.runtimeId}/${profile.profileId}`));
		if (keys.size !== next.length) throw new Error(localize('terminal.profile.duplicate', 'Terminal profile is already registered: {0}', 'extension'));
		for (const key of this.descriptors.keys()) {
			if (!keys.has(key)) {
				this.registrations.deleteAndDispose(key);
				this.descriptors.delete(key);
			}
		}
		for (const descriptor of next) {
			const key = `${descriptor.runtimeId}/${descriptor.profileId}`;
			if (this.descriptors.get(key) === descriptor) continue;
			const extension = this.extensions.currentCatalog.extensions.find(extension => extension.packageSha256 === descriptor.packageDigest);
			if (!extension) throw new Error(localize('terminal.profile.providerUnavailable', 'Terminal profile provider is unavailable: {0}', descriptor.title));
			this.registrations.deleteAndDispose(key);
			this.descriptors.delete(key);
			const lifetime = new DisposableStore();
			const controller = new AbortController();
			lifetime.add(toDisposable(() => controller.abort()));
			const requests = lifetime.add(this.instantiation.createInstance(RequestStore<ProfileReply, { signal: AbortSignal; }>, undefined));
			lifetime.add(requests.onCreateRequest(({ requestId, signal }) => {
				if (signal.aborted) { requests.acceptReply(requestId, { error: new CancellationError() }); return; }
				const cancellation = addDisposableListener(signal, 'abort', () => {
					cancellation.dispose();
					requests.acceptReply(requestId, { error: new CancellationError() });
				}, { once: true });
				void Promise.resolve().then(() => {
					signal.throwIfAborted();
					return descriptor.invoke('createTerminalProfile', {}, signal);
				}).then(async value => {
					if (signal.aborted) {
						// A provider can ignore cancellation. Its late opaque PTY is still
						// an owned resource and must be closed before discarding the reply.
						const result = record(value, ['options', 'pty']);
						if (result.pty !== undefined) await descriptor.invoke('closeTaskTerminal', { ptyId: text(record(result.pty).ptyId, 256) }, AbortSignal.timeout(5_000));
						return;
					}
					cancellation.dispose();
					requests.acceptReply(requestId, { value });
				}, error => {
					cancellation.dispose();
					if (!signal.aborted) requests.acceptReply(requestId, { error });
				}).catch(error => this.log.error('terminal', localize('terminal.profile.lateReleaseFailed', 'Failed to release a late extension terminal profile.'), error));
			}));
			try {

				lifetime.add(this.profiles.registerInternalContributedProfile({ extensionIdentifier: extension.id, id: descriptor.profileId, title: descriptor.title }));
				lifetime.add(this.profiles.registerTerminalProfileProvider(extension.id, descriptor.profileId, {
					createContributedTerminalProfile: async presentation => {
						const generation = this.workspaceGeneration;
						const request = new AbortController();
						let reply: ProfileReply;
						try {
							reply = await requests.createRequest({ signal: AbortSignal.any([controller.signal, request.signal]) });
						} catch (error) {
							request.abort();
							throw error;
						}
						if ('error' in reply) throw reply.error;
						const result = record(reply.value, ['options', 'pty']);
						if (lifetime.isDisposed || generation !== this.workspaceGeneration) {
							if (result.pty !== undefined) await descriptor.invoke('closeTaskTerminal', { ptyId: text(record(result.pty).ptyId, 256) }, AbortSignal.timeout(5_000));
							throw new CancellationError();
						}
						if (result.options === null) return;
						const options = record(result.options, ['name', 'shellPath', 'shellArgs', 'cwd', 'env', 'strictEnv', 'icon', 'color']);
						const name = text(options.name ?? descriptor.title, 256);
						const icon = presentation.icon ?? (options.icon === undefined ? undefined : ThemeIcon.fromId(text(options.icon, 256)));
						const color = presentation.color ?? (options.color === undefined ? undefined : text(options.color, 256));
						let instance: ITerminalInstance;
						if (result.pty !== undefined) {
							const pty = record(result.pty, ['ptyId', 'acceptsInput']);
							const id = text(pty.ptyId, 256);
							if (typeof pty.acceptsInput !== 'boolean') throw invalid();
							let nextPtyId: string | undefined = id;
							instance = await this.terminals.createTerminal({
								dimensions: { cols: 80, rows: 24 }, config: {
									name, icon, color, customPtyImplementation: (terminalId, cols, rows) => {
										if (lifetime.isDisposed || generation !== this.workspaceGeneration) throw new CancellationError();
										let registration: IDisposable | undefined;
										const child = new TerminalProcessExtHostProxy(terminalId, nextPtyId, pty.acceptsInput === true, cols, rows, descriptor.invoke, () => {
											if (registration) {
												lifetime.delete(registration);
												registration.dispose();
												registration = undefined;
											}
										});
										nextPtyId = undefined;
										registration = lifetime.add(toDisposable(() => child.shutdown(true)));
										return child;
									},
								}
							});
						} else {
							const os = this.processes.operatingSystem;
							if (os === undefined) throw new CancellationError();
							const shell: IShellLaunchConfig = {
								name, icon, color,
								executable: options.shellPath === undefined ? undefined : text(options.shellPath, 32768),
								args: options.shellArgs === undefined ? undefined : argumentsList(options.shellArgs),
								cwd: options.cwd === undefined ? undefined : text(options.cwd, 32768),
								env: environment(options.env),
								strictEnv: options.strictEnv === undefined ? undefined : boolean(options.strictEnv),
							};
							const resource = this.workspace.getWorkspace().folders[0]?.uri;
							await this.resolver.resolveShellLaunchConfig(shell, { os, remoteAuthority: resource && getRemoteAuthority(resource) });
							if (lifetime.isDisposed) throw new CancellationError();
							instance = await this.terminals.createTerminal({
								dimensions: { cols: 80, rows: 24 }, title: name,
								profile: { type: 'custom', name, path: typeof shell.executable === 'string' ? [shell.executable] : shell.executable!, args: shell.args ?? [] },
								env: shell.env, ...(shell.strictEnv === undefined ? {} : { strictEnv: shell.strictEnv }),
								cwd: shell.cwd, icon: shell.icon, color: shell.color,
							});
						}
						if (lifetime.isDisposed || generation !== this.workspaceGeneration) {
							await this.terminals.closeTerminal(instance);
							throw new CancellationError();
						}
					},
				}));
				this.registrations.set(key, lifetime);
				this.descriptors.set(key, descriptor);
			} catch (error) {
				lifetime.dispose();
				throw error;
			}
		}
	}

	protected override disposeCore(): void {
		this.descriptors.clear();
		this.environmentDescriptors.clear();
		super.disposeCore();
	}
}


function invalid(): TypeError {
	return new TypeError(localize('terminal.profile.invalidProviderResult', 'Invalid terminal profile provider response.'));
}

function record(value: unknown, keys?: readonly string[]): Record<string, JsonValue> {
	if (!value || typeof value !== 'object' || Array.isArray(value) || keys && Object.keys(value).some(key => !keys.includes(key))) throw invalid();
	return value as Record<string, JsonValue>;
}

function text(value: unknown, maximum: number, allowEmpty = false): string {
	if (typeof value !== 'string' || value.length > maximum || !allowEmpty && (!value || /[\u0000-\u001f\u007f]/.test(value))) throw invalid();
	return value;
}

function argumentsList(value: unknown): TerminalArguments {
	if (typeof value === 'string') {
		if (value.length > 32768 || value.includes('\0')) throw invalid();
		return value;
	}
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 1024) throw invalid();
	return value.map(arg => {
		const textValue = text(arg, 32768, true);
		if (textValue.includes('\0')) throw invalid();
		return textValue;
	});
}
function environment(value: unknown): Readonly<Record<string, string | null>> | undefined {
	if (value === undefined) return undefined;
	const values = record(value);
	if (Object.keys(values).length > 128) throw invalid();
	return Object.freeze(Object.fromEntries(Object.entries(values).map(([key, value]) => {
		if (!key || key.length > 256 || /[=\u0000]/.test(key) || value !== null && (typeof value !== 'string' || value.length > 32768 || value.includes('\0'))) throw invalid();
		return [key, value as string | null];
	})));
}

function boolean(value: unknown): boolean {
	if (typeof value !== 'boolean') throw invalid();
	return value;
}
