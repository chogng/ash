import { Emitter } from '../../../base/common/event.js';
import { CancellationError, onUnexpectedError } from '../../../base/common/errors.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { TaskQueue } from '../../../base/common/async.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { localize } from '../../../nls.js';
import { ITerminalProcessService, type ITerminalChildProcess, type IProcessProperty, type IProcessReadyEvent, ProcessPropertyType, type IShellLaunchConfig } from '../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { IExtensionService } from '../../services/extensions/common/extensionService.js';
import { ITerminalService, type ITerminalInstance } from '../../services/terminal/browser/terminal.js';
import { ITerminalProfileResolverService, ITerminalProfileService } from '../../services/terminal/common/terminal.js';
import type { ExtensionHostProviderInvoker } from './extensionHostLanguageBridge.js';
import type { JsonValue } from '../../../platform/agentHost/common/extensionHostApi.js';

export interface ExtensionTerminalProfileRegistration {
	readonly runtimeId: string;
	readonly packageDigest: string;
	readonly profileId: string;
	readonly title: string;
	readonly invoke: ExtensionHostProviderInvoker;
}

/** Binds incarnation-owned callbacks to the existing terminal profile and instance owners. */
export class MainThreadTerminalService extends Disposable {
	private readonly registrations = this._register(new DisposableMap<string, DisposableStore>());
	private readonly descriptors = new Map<string, ExtensionTerminalProfileRegistration>();
	private workspaceGeneration = 0;

	constructor(
		@ITerminalProfileService private readonly profiles: ITerminalProfileService,
		@ITerminalProfileResolverService private readonly resolver: ITerminalProfileResolverService,
		@ITerminalService private readonly terminals: ITerminalService,
		@IExtensionService private readonly extensions: IExtensionService,
		@ITerminalProcessService private readonly processes: ITerminalProcessService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
	) {
		super();
		this._register(workspace.onDidChangeWorkspace(() => this.workspaceGeneration++));
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
			try {
				lifetime.add(this.profiles.registerInternalContributedProfile({ extensionIdentifier: extension.id, id: descriptor.profileId, title: descriptor.title }));
				lifetime.add(this.profiles.registerTerminalProfileProvider(extension.id, descriptor.profileId, {
					createContributedTerminalProfile: async presentation => {
						const generation = this.workspaceGeneration;
						const result = record(await descriptor.invoke('createTerminalProfile', {}, controller.signal), ['options', 'pty']);
						if (lifetime.isDisposed) throw new CancellationError();
						if (generation !== this.workspaceGeneration) {
							if (result.pty !== undefined) await descriptor.invoke('closeTaskTerminal', { ptyId: text(record(result.pty).ptyId, 256) }, controller.signal);
							throw new CancellationError();
						}
						if (result.options === null) return;
						const options = record(result.options, ['name', 'shellPath', 'shellArgs', 'cwd', 'env', 'icon', 'color']);
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
										const child = new ExtensionProfilePseudoterminal(terminalId, nextPtyId, pty.acceptsInput === true, cols, rows, descriptor.invoke, () => {
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
							const shell: IShellLaunchConfig = { name, executable: options.shellPath === undefined ? undefined : text(options.shellPath, 32768), args: options.shellArgs === undefined ? undefined : argumentsList(options.shellArgs), cwd: options.cwd === undefined ? undefined : text(options.cwd, 32768), env: environment(options.env), icon, color };
							await this.resolver.resolveShellLaunchConfig(shell, { os, remoteAuthority: this.workspace.getWorkspace().folders[0]?.uri.authority || undefined });
							if (lifetime.isDisposed) throw new CancellationError();
							instance = await this.terminals.createTerminal({
								dimensions: { cols: 80, rows: 24 }, title: name,
								profile: { type: 'custom', name, path: typeof shell.executable === 'string' ? [shell.executable] : shell.executable!, args: shell.args ?? [] }, env: shell.env, cwd: shell.cwd, icon: shell.icon, color: shell.color,
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
		super.disposeCore();
	}
}

/** The instance owns its screen; this child owns only an extension's bounded opaque PTY stream. */
class ExtensionProfilePseudoterminal extends Disposable implements ITerminalChildProcess {
	readonly shouldPersist = false;
	private readonly data = this._register(new Emitter<string>());
	private readonly ready = this._register(new Emitter<IProcessReadyEvent>());
	private readonly property = this._register(new Emitter<IProcessProperty>());
	private readonly exit = this._register(new Emitter<number | undefined>());
	readonly onProcessData = this.data.event;
	readonly onProcessReady = this.ready.event;
	readonly onDidChangeProperty = this.property.event;
	readonly onProcessExit = this.exit.event;
	private readonly sendInput = (data: string) => this.dispatch('inputTaskTerminal', { data });
	get input(): ((data: string) => void) | undefined { return this.acceptsInput ? this.sendInput : undefined; }
	private readonly queue = new TaskQueue();
	private readonly controller = new AbortController();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private closed = false;

	constructor(readonly id: number, private ptyId: string | undefined, private acceptsInput: boolean, private cols: number, private rows: number, private readonly invoke: ExtensionHostProviderInvoker, private readonly releaseOwner: () => void) {
		super();
	}

	async start(): Promise<void> {
		if (this.ptyId === undefined) {
			const result = record(await this.invoke('createTerminalProfile', {}, this.controller.signal), ['options', 'pty']);
			const pty = record(result.pty, ['ptyId', 'acceptsInput']);
			this.ptyId = text(pty.ptyId, 256);
			if (typeof pty.acceptsInput !== 'boolean') throw invalid();
			this.acceptsInput = pty.acceptsInput;
			if (this.closed) {
				await this.releasePty();
				throw new CancellationError();
			}
		}
		const result = await this.invoke('openTaskTerminal', { ptyId: this.ptyId, dimensions: { columns: this.cols, rows: this.rows } }, this.controller.signal);
		if (this.closed) throw new CancellationError();
		this.ready.fire({ pid: -1, cwd: '' });
		this.consume(result);
		this.poll();
	}

	resize(cols: number, rows: number): void {
		this.cols = cols;
		this.rows = rows;
		this.dispatch('resizeTaskTerminal', { dimensions: { columns: cols, rows } });
	}

	shutdown(_immediate: boolean): void {
		this.finish(undefined);
	}

	private finish(code: number | undefined): void {
		if (this.closed) return;
		this.closed = true;
		this.controller.abort();
		this.queue.clearPending();
		clearTimeout(this.timer);
		this.timer = undefined;
		this.releaseOwner();
		this.exit.fire(code);
		void this.releasePty();
	}

	private async releasePty(): Promise<void> {
		if (this.ptyId === undefined) return;
		const ptyId = this.ptyId;
		this.ptyId = undefined;
		await this.invoke('closeTaskTerminal', { ptyId }, new AbortController().signal).catch(() => undefined);
	}

	private dispatch(operation: string, payload: JsonValue): void {
		const ptyId = this.ptyId;
		if (this.closed || ptyId === undefined) return;
		void this.queue.schedule(async () => {
			if (this.closed) return;
			this.consume(await this.invoke(operation, { ...record(payload), ptyId }, this.controller.signal));
		}).catch(error => {
			if (!this.closed) {
				onUnexpectedError(error);
				this.shutdown(true);
			}
		});
	}

	private poll(): void {
		const ptyId = this.ptyId;
		if (this.closed || ptyId === undefined) return;
		void this.queue.schedule(async () => {
			const result = record(await this.invoke('readTaskTerminal', { ptyId }, this.controller.signal));
			if (this.closed) return;
			this.consume(result);
		}).then(() => {
			if (!this.closed) this.timer = setTimeout(() => {
				this.timer = undefined;
				this.poll();
			}, 50);
		}, error => {
			if (!this.closed) {
				onUnexpectedError(error);
				this.shutdown(true);
			}
		});
	}

	private consume(value: JsonValue): void {
		if (this.closed) return;
		const result = record(value);
		if (!Array.isArray(result.events) || result.events.length > 1024) throw invalid();
		for (const value of result.events) {
			if (this.closed) break;
			const event = record(value);
			if (event.type === 'data') this.data.fire(text(event.data, 262144, true));
			else if (event.type === 'name') this.property.fire({ type: ProcessPropertyType.Title, value: text(event.name, 256) });
			else if (event.type === 'close') {
				if (event.code !== null && (typeof event.code !== 'number' || !Number.isSafeInteger(event.code) || event.code < 0 || event.code > 2147483647)) throw invalid();
				this.finish(event.code === null ? undefined : event.code as number);
			} else throw invalid();
		}
	}

	protected override disposeCore(): void {
		this.shutdown(true);
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

function argumentsList(value: unknown): readonly string[] {
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
