import { URI } from '../../../base/common/uri.js';
import { extUri } from '../../../base/common/resources.js';
import { match } from '../../../base/common/glob.js';
import { FileKind, IFileService } from '../../../platform/files/common/files.js';
import { ITerminalCompletionService, type ITerminalCompletion } from '../../contrib/terminalContrib/suggest/browser/terminalCompletionService.js';
import { ITerminalQuickFixService, type ITerminalQuickFix } from '../../contrib/terminalContrib/quickFix/browser/quickFix.js';
import { TerminalProcessExtHostProxy } from '../../contrib/terminal/browser/terminalProcessExtHostProxy.js';
import { IEnvironmentVariableService } from '../../contrib/terminal/common/environmentVariable.js';
import { deserializeEnvironmentDescriptionMap, deserializeEnvironmentVariableCollection } from '../../../platform/terminal/common/environmentVariableShared.js';
import { CancellationError } from '../../../base/common/errors.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { localize } from '../../../nls.js';
import type { IShellLaunchConfig, TerminalArguments } from '../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { IExtensionService } from '../../services/extensions/common/extensionService.js';
import { ITerminalService, type ITerminalInstance } from '../../contrib/terminal/browser/terminal.js';
import { ITerminalProfileService } from '../../contrib/terminal/common/terminal.js';
import type { ExtensionHostProviderInvoker } from './extensionHostLanguageBridge.js';
import type { JsonValue } from '../../../platform/agentHost/common/extensionHostApi.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { RequestStore } from '../../../platform/terminal/common/requestStore.js';
import { addDisposableListener } from '../../../base/browser/dom.js';
import { ITerminalLinkProviderService } from '../../contrib/terminalContrib/links/browser/links.js';

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

export interface ExtensionTerminalLinkRegistration {
	readonly runtimeId: string;
	readonly packageDigest: string;
	readonly registrationId: string;
	readonly invoke: ExtensionHostProviderInvoker;
}

export interface ExtensionTerminalCompletionRegistration extends ExtensionTerminalLinkRegistration {
	readonly triggerCharacters: readonly string[];
}
export interface ExtensionTerminalQuickFixRegistration extends ExtensionTerminalLinkRegistration { }

/** Binds incarnation-owned callbacks to the existing terminal profile and instance owners. */
export class MainThreadTerminalService extends Disposable {
	private readonly registrations = this._register(new DisposableMap<string, DisposableStore>());
	private readonly descriptors = new Map<string, ExtensionTerminalProfileRegistration>();
	private workspaceGeneration = 0;
	private readonly completionRegistrations = this._register(new DisposableMap<string, DisposableStore>());
	private readonly completionDescriptors = new Map<string, ExtensionTerminalCompletionRegistration>();
	private readonly quickFixRegistrations = this._register(new DisposableMap<string, DisposableStore>());
	private readonly quickFixDescriptors = new Map<string, ExtensionTerminalQuickFixRegistration>();
	private readonly environmentRegistrations = this._register(new DisposableMap<string, DisposableStore>());
	private readonly environmentDescriptors = new Map<string, ExtensionTerminalEnvironmentRegistration>();
	private readonly linkRegistrations = this._register(new DisposableMap<string, DisposableStore>());
	private readonly linkDescriptors = new Map<string, ExtensionTerminalLinkRegistration>();

	constructor(
		@ITerminalProfileService private readonly profiles: ITerminalProfileService,
		@ITerminalService private readonly terminals: ITerminalService,
		@IExtensionService private readonly extensions: IExtensionService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IEnvironmentVariableService private readonly environmentVariables: IEnvironmentVariableService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@ILogService private readonly log: ILogService,
		@ITerminalLinkProviderService private readonly links: ITerminalLinkProviderService,
		@ITerminalCompletionService private readonly completions: ITerminalCompletionService,
		@ITerminalQuickFixService private readonly quickFixes: ITerminalQuickFixService,
		@IFileService private readonly files: IFileService,
	) {
		super();
		this._register(workspace.onDidChangeWorkspace(() => this.workspaceGeneration++));
	}

	replaceCompletionProviders(next: readonly ExtensionTerminalCompletionRegistration[]): void {
		this.replaceProviders(next, this.completionDescriptors, this.completionRegistrations, (descriptor, lifetime, controller) => {
			return this.completions.registerTerminalCompletionProvider(descriptor.runtimeId, descriptor.registrationId, {
				provideCompletions: async (instance, commandLine, cursorIndex, signal) => {
					using pending = new DisposableStore();
					const request = this.terminalRequest(instance, controller.signal, signal, pending);
					if (!request.valid()) return [];
					const result = record(await descriptor.invoke('provideTerminalCompletions', { commandLine, cursorIndex, terminal: { id: instance.id, name: instance.title, processId: instance.processId ?? null } }, request.signal), ['items', 'resourceOptions']);
					if (!request.valid()) return [];
					if (!Array.isArray(result.items) || result.items.length > 1000) throw invalid();
					const items: ITerminalCompletion[] = result.items.map(value => {
						const item = record(value, ['label', 'replacementRange', 'detail', 'documentation', 'kind']);
						const label = text(item.label, 32768);
						const range = item.replacementRange;
						if (!Array.isArray(range) || range.length !== 2 || range.some(value => typeof value !== 'number' || !Number.isSafeInteger(value)) || (range[0] as number) < 0 || (range[1] as number) < (range[0] as number) || (range[1] as number) > commandLine.length) throw invalid();
						if (item.kind !== undefined && (typeof item.kind !== 'number' || !Number.isInteger(item.kind) || item.kind < 0 || item.kind > 16)) throw invalid();
						return { label, replacementRange: [range[0] as number, range[1] as number], ...(item.detail === undefined ? {} : { detail: text(item.detail, 4096, true) }), ...(item.documentation === undefined ? {} : { documentation: text(item.documentation, 32768, true) }), ...(item.kind === undefined ? {} : { kind: item.kind }) };
					});
					if (result.resourceOptions !== undefined) {
						const options = record(result.resourceOptions, ['showFiles', 'showDirectories', 'globPattern', 'cwd']);
						if (options.showFiles !== undefined && typeof options.showFiles !== 'boolean' || options.showDirectories !== undefined && typeof options.showDirectories !== 'boolean') throw invalid();
						const cwd = URI.parse(text(options.cwd, 32768));
						const glob = options.globPattern === undefined ? undefined : text(options.globPattern, 2048);
						const folder = this.workspace.getWorkspace().folders.find(folder => folder.id === instance.dirId);
						// Resource suggestions use the file service's existing workspace authority;
						// an extension cannot turn completion into an arbitrary host filesystem read.
						if ((options.showFiles || options.showDirectories) && folder && extUri.isEqualOrParent(cwd, folder.uri)) {
							const tokenStart = commandLine.lastIndexOf(' ', cursorIndex - 1) + 1;
							const typed = commandLine.slice(tokenStart, cursorIndex);
							let entries: Awaited<ReturnType<IFileService['readDirectory']>>;
							try { entries = await this.files.readDirectory(cwd); } catch { return request.valid() ? items : []; }
							if (!request.valid()) return [];
							for (const entry of entries.slice(0, 1000)) {
								if (!entry.name.startsWith(typed) || /[\x00-\x1f\x7f]/.test(entry.name) || glob && !match(glob, entry.name)) continue;
								if (entry.kind === FileKind.File && options.showFiles || entry.kind === FileKind.Directory && options.showDirectories) items.push({ label: entry.name + (entry.kind === FileKind.Directory ? '/' : ''), replacementRange: [tokenStart, cursorIndex] });
							}
						}
					}
					return request.valid() ? items : [];
				}
			}, ...descriptor.triggerCharacters);
		});
	}

	replaceQuickFixProviders(next: readonly ExtensionTerminalQuickFixRegistration[]): void {
		this.replaceProviders(next, this.quickFixDescriptors, this.quickFixRegistrations, (descriptor, lifetime, controller) => {
			return this.quickFixes.registerQuickFixProvider(`${descriptor.runtimeId}/${descriptor.registrationId}`, {
				provideTerminalQuickFixes: async (instance, command, signal) => {
					using pending = new DisposableStore();
					const request = this.terminalRequest(instance, controller.signal, signal, pending);
					if (!request.valid() || command.wasReplayed || command.exitCode === undefined) return [];
					const commandSnapshot = { commandLine: command.command, exitCode: command.exitCode, terminalId: instance.id };
					const matcher = record(await descriptor.invoke('provideTerminalQuickFixes', { ...commandSnapshot, phase: 'matcher' }, request.signal), ['matches', 'outputMatcher']);
					if (!request.valid() || matcher.matches === false) return [];
					if (matcher.matches !== true) throw invalid();
					let outputLines: string[] = [];
					if (matcher.outputMatcher !== null) {
						const window = record(matcher.outputMatcher, ['anchor', 'offset', 'length']);
						if (window.anchor !== 'top' && window.anchor !== 'bottom' || typeof window.offset !== 'number' || !Number.isSafeInteger(window.offset) || window.offset < 0 || typeof window.length !== 'number' || !Number.isSafeInteger(window.length) || window.length < 1 || window.length > 40) throw invalid();
						const output = command.getOutputMatch({ lineMatcher: /[\s\S]*/, anchor: window.anchor, offset: window.offset, length: window.length, multipleMatches: true });
						if (!output || output.outputLines.some(line => line.length > 32768)) return [];
						outputLines = output.outputLines;
					}
					const result = record(await descriptor.invoke('provideTerminalQuickFixes', { ...commandSnapshot, phase: 'provide', outputLines }, request.signal), ['fixes']);
					if (!request.valid()) return [];
					if (!Array.isArray(result.fixes) || result.fixes.length > 100) throw invalid();
					return result.fixes.map(value => {
						const fix = record(value, ['kind', 'label', 'id', 'shouldExecute']);
						const label = text(fix.label, 32768);
						if (fix.kind === 'terminalCommand') {
							if (typeof fix.shouldExecute !== 'boolean') throw invalid();
							return { label, terminalCommand: label, shouldExecute: fix.shouldExecute };
						}
						if (fix.kind === 'opener') {
							const uri = URI.parse(label);
							if (!['http', 'https', 'file', 'ash-remote', 'vscode-remote'].includes(uri.scheme)) throw invalid();
							return { label, uri };
						}
						if (fix.kind !== 'command') throw invalid();
						const id = text(fix.id, 256);
						return {
							label, run: async () => {
								if (!request.bindingValid()) return;
								using activation = new DisposableStore();
								const active = this.terminalRequest(instance, controller.signal, signal, activation);
								if (active.valid()) await descriptor.invoke('handleTerminalQuickFix', { id, terminalId: instance.id, commandLine: command.command }, active.signal);
							}
						} satisfies ITerminalQuickFix;
					});
				}
			});
		});
	}

	private replaceProviders<T extends ExtensionTerminalLinkRegistration>(next: readonly T[], descriptors: Map<string, T>, registrations: DisposableMap<string, DisposableStore>, register: (descriptor: T, lifetime: DisposableStore, controller: AbortController) => IDisposable): void {
		if (this.isDisposed) throw new CancellationError();
		const keys = new Set(next.map(descriptor => `${descriptor.runtimeId}/${descriptor.registrationId}`));
		if (keys.size !== next.length) throw invalid();
		for (const key of descriptors.keys()) if (!keys.has(key)) { registrations.deleteAndDispose(key); descriptors.delete(key); }
		for (const descriptor of next) {
			const key = `${descriptor.runtimeId}/${descriptor.registrationId}`;
			if (descriptors.get(key) === descriptor) continue;
			if (!this.extensionForRuntime(descriptor)) throw invalid();
			registrations.deleteAndDispose(key);
			descriptors.delete(key);
			const lifetime = new DisposableStore();
			const controller = new AbortController();
			lifetime.add(toDisposable(() => controller.abort()));
			try { lifetime.add(register(descriptor, lifetime, controller)); }
			catch (error) { lifetime.dispose(); throw error; }
			registrations.set(key, lifetime);
			descriptors.set(key, descriptor);
		}
	}

	private terminalRequest(instance: ITerminalInstance, provider: AbortSignal, caller: AbortSignal, lifetime: DisposableStore): { signal: AbortSignal; valid: () => boolean; bindingValid: () => boolean; } {
		const processId = instance.processId;
		const workspaceGeneration = this.workspaceGeneration;
		const controller = new AbortController();
		lifetime.add(instance.onDidChangeState(() => controller.abort()));
		lifetime.add(this.workspace.onDidChangeWorkspace(() => controller.abort()));
		lifetime.add(this.workspace.onDidChangeWorkspaceFolders(() => controller.abort()));
		lifetime.add(this.terminals.onDidDisposeInstance(disposed => { if (disposed === instance) controller.abort(); }));
		const signal = AbortSignal.any([provider, caller, controller.signal, AbortSignal.timeout(5_000)]);
		const bindingValid = (): boolean => !provider.aborted && !caller.aborted && !controller.signal.aborted && workspaceGeneration === this.workspaceGeneration && instance.state === 'running' && instance.processId === processId && this.terminals.instances.includes(instance);
		return { signal, bindingValid, valid: () => !signal.aborted && bindingValid() };
	}

	replaceLinkProviders(next: readonly ExtensionTerminalLinkRegistration[]): void {
		if (this.isDisposed) throw new CancellationError();
		const keys = new Set(next.map(descriptor => `${descriptor.runtimeId}/${descriptor.registrationId}`));
		if (keys.size !== next.length) throw invalid();
		for (const key of this.linkDescriptors.keys()) {
			if (keys.has(key)) continue;
			this.linkRegistrations.deleteAndDispose(key);
			this.linkDescriptors.delete(key);
		}
		for (const descriptor of next) {
			const key = `${descriptor.runtimeId}/${descriptor.registrationId}`;
			if (this.linkDescriptors.get(key) === descriptor) continue;
			if (!this.extensionForRuntime(descriptor)) throw invalid();
			this.linkRegistrations.deleteAndDispose(key);
			this.linkDescriptors.delete(key);
			const lifetime = new DisposableStore();
			const controller = new AbortController();
			lifetime.add(toDisposable(() => controller.abort()));
			const instances = lifetime.add(new DisposableMap<ITerminalInstance, DisposableStore>());
			const generations = new WeakMap<ITerminalInstance, number>();
			lifetime.add(this.terminals.onDidDisposeInstance(instance => {
				instances.deleteAndDispose(instance);
				generations.delete(instance);
			}));
			lifetime.add(this.links.registerLinkProvider({
				provideLinks: async (instance, line) => {
					if (!instances.has(instance)) {
						const listeners = new DisposableStore();
						generations.set(instance, 0);
						listeners.add(instance.onDidChangeState(() => generations.set(instance, (generations.get(instance) ?? 0) + 1)));
						instances.set(instance, listeners);
					}
					const generation = this.workspaceGeneration;
					const instanceGeneration = generations.get(instance);
					const processId = instance.processId;
					const request = new AbortController();
					using pending = new DisposableStore();
					pending.add(instance.onDidChangeState(() => request.abort()));
					pending.add(this.workspace.onDidChangeWorkspace(() => request.abort()));
					const signal = AbortSignal.any([controller.signal, request.signal, AbortSignal.timeout(5_000)]);
					const valid = (): boolean => !controller.signal.aborted && generation === this.workspaceGeneration
						&& instanceGeneration === generations.get(instance)
						&& instance.state === 'running' && instance.processId === processId && this.terminals.instances.includes(instance);
					if (!valid() || line.length > 32768) return undefined;
					const result = record(await descriptor.invoke('provideTerminalLinks', {
						line, terminal: { id: instance.id, name: instance.title, processId: processId ?? null },
					}, signal), ['links']);
					if (signal.aborted || !valid()) return undefined;
					if (!Array.isArray(result.links) || result.links.length > 256) throw invalid();
					return result.links.map(value => {
						const link = record(value, ['id', 'startIndex', 'length', 'label']);
						const id = text(link.id, 256);
						const startIndex = link.startIndex;
						const length = link.length;
						if (typeof startIndex !== 'number' || !Number.isSafeInteger(startIndex) || startIndex < 0
							|| typeof length !== 'number' || !Number.isSafeInteger(length) || length < 1 || startIndex + length > line.length) throw invalid();
						const label = link.label === undefined ? undefined : text(link.label, 512);
						return {
							startIndex, length, label, activate: (): void => {
								if (!valid()) return;
								const activate = async (): Promise<void> => {
									using activation = new DisposableStore();
									const cancellation = new AbortController();
									activation.add(instance.onDidChangeState(() => cancellation.abort()));
									activation.add(this.workspace.onDidChangeWorkspace(() => cancellation.abort()));
									await descriptor.invoke('handleTerminalLink', { id, line, startIndex, length, terminal: { id: instance.id, name: instance.title, processId } }, AbortSignal.any([controller.signal, cancellation.signal, AbortSignal.timeout(5_000)]));
								};
								void activate()
									.catch(error => { if (!controller.signal.aborted) this.log.error('terminal', error); });
							}
						};
					});
				},
			}));
			this.linkRegistrations.set(key, lifetime);
			this.linkDescriptors.set(key, descriptor);
		}
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
			const extension = this.extensionForRuntime(descriptor);
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
			const extension = this.extensionForRuntime(descriptor);
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
						if (result.options === null) return undefined;
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
								cwd: presentation.cwd, location: presentation.location, preserveFocus: presentation.preserveFocus, dimensions: { cols: 80, rows: 24 }, config: {
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
							const shell: IShellLaunchConfig = {
								name, icon, color,
								executable: options.shellPath === undefined ? undefined : text(options.shellPath, 32768),
								args: options.shellArgs === undefined ? undefined : argumentsList(options.shellArgs),
								cwd: typeof presentation.cwd === 'string' ? presentation.cwd : options.cwd === undefined ? undefined : text(options.cwd, 32768),
								env: environment(options.env),
								strictEnv: options.strictEnv === undefined ? undefined : boolean(options.strictEnv),
							};
							instance = await this.terminals.createTerminal({ config: shell, cwd: presentation.cwd, location: presentation.location, preserveFocus: presentation.preserveFocus, skipContributedProfileCheck: true });
						}
						if (lifetime.isDisposed || generation !== this.workspaceGeneration) {
							await this.terminals.closeTerminal(instance);
							throw new CancellationError();
						}
						return instance.instanceId;
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

	private extensionForRuntime(descriptor: ExtensionTerminalEnvironmentRegistration) {
		return this.extensions.currentCatalog.extensions.find(extension => {
			// A Plugin's executable authority and declarative catalog hash different
			// domains. Only its backend-attested pair can join those identities.
			if (extension.sourceKind === 'plugin' && extension.runtimeBinding) {
				return extension.runtimeBinding.runtimeId === descriptor.runtimeId && extension.runtimeBinding.packageDigest === descriptor.packageDigest;
			}
			// Product executables retain their source fingerprint; other packages
			// retain the standard exact catalog digest fence.
			return extension.packageSha256 === descriptor.packageDigest || extension.sourceKind === 'builtIn' && extension.id === descriptor.runtimeId;
		});
	}

	protected override disposeCore(): void {
		this.descriptors.clear();
		this.environmentDescriptors.clear();
		this.linkDescriptors.clear();
		this.completionDescriptors.clear();
		this.quickFixDescriptors.clear();
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
