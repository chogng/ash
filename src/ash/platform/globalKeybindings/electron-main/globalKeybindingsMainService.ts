import { AbstractDisposable, toDisposable, type IDisposable, type DisposableStore } from '../../../base/common/lifecycle.js';
import type { BrowserWindow } from 'electron';
import type { IpcRoute } from '../../ipc/electron-main/trustedIpcRouter.js';
import { GLOBAL_KEYBINDING_UPDATE_CHANNEL, GLOBAL_KEYBINDING_TRIGGER_CHANNEL, validateGlobalKeybindingRequest, type GlobalKeybindingRequest } from '../common/globalKeybindings.js';
import type { JsonValue } from '../../../base/common/jsonValue.js';
import type { INativeSystemWideKeybinding, INativeSystemWideKeybindingResult } from '../../native/common/nativeHost.js';

export interface IGlobalShortcutRegistry {
	register(accelerator: string, callback: () => void): boolean;
	isRegistered(accelerator: string): boolean;
	unregister(accelerator: string): void;
}

export interface IGlobalKeybindingOwner extends IDisposable {
	update(binding: INativeSystemWideKeybinding | undefined): boolean;
	getBinding(): INativeSystemWideKeybinding | undefined;
	check(accelerator: string, commandId: string): boolean;
}

interface ScopedBinding {
	readonly windowId: number;
	readonly run: (binding: INativeSystemWideKeybinding) => void;
	binding: INativeSystemWideKeybinding | undefined;
}

export interface GlobalKeybindingsMainServiceOptions {
	readonly shortcuts: IGlobalShortcutRegistry;
	readonly activeWindowId: () => number | undefined;
	readonly runCommand: (windowId: number, commandId: string, args?: JsonValue) => void | Promise<void>;
	readonly onError: (error: unknown) => void;
}

/** Owns operating-system shortcut registrations requested by live Workbench windows. */
export class GlobalKeybindingsMainService extends AbstractDisposable {
	private readonly byWindow = new Map<number, Map<string, INativeSystemWideKeybinding>>();
	private readonly scoped = new Set<ScopedBinding>();
	private readonly registered = new Set<string>();
	private readonly failed = new Set<string>();

	constructor(private readonly options: GlobalKeybindingsMainServiceOptions) {
		super();
	}

	/** Renderer leases share the existing registry and end on navigation, crash or window teardown. */
	createWindowRoutes(window: BrowserWindow, lifetime: DisposableStore): readonly IpcRoute<unknown, unknown>[] {
		const leases = new Map<string, IGlobalKeybindingOwner>();
		let disposed = false;
		const clear = () => {
			for (const lease of leases.values()) lease.dispose();
			leases.clear();
		};
		const navigating = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
			if (mainFrame && !inPlace) clear();
		};
		const contents = window.webContents;
		contents.on('render-process-gone', clear);
		contents.on('did-start-navigation', navigating);
		lifetime.add(
			toDisposable(() => {
				disposed = true;
				contents.off('render-process-gone', clear);
				contents.off('did-start-navigation', navigating);
				clear();
			}),
		);
		return [
			{
				channel: GLOBAL_KEYBINDING_UPDATE_CHANNEL,
				validate: validateGlobalKeybindingRequest,
				invoke: value => {
					if (disposed || window.isDestroyed() || contents.isDestroyed()) throw new Error('Global keybinding scope has closed');
					const request = value as GlobalKeybindingRequest;
					let lease = leases.get(request.id);
					if (!request.global) {
						lease?.dispose();
						leases.delete(request.id);
						return {
							available: !!request.accelerator && this.check(request.accelerator, request.commandId),
							activeLabel: '',
						};
					}
					if (!lease) {
						if (leases.size >= 64) throw new RangeError('Too many global keybinding leases');
						lease = this.createOwner(window.id, () => {
							if (!window.isDestroyed() && !contents.isDestroyed()) contents.send(GLOBAL_KEYBINDING_TRIGGER_CHANNEL, { id: request.id });
						});
						leases.set(request.id, lease);
					}
					const available =
						!!request.accelerator &&
						lease.update({
							accelerator: request.accelerator,
							commandId: request.commandId,
							userSettingsLabel: request.label,
						});
					return { available, activeLabel: lease.getBinding()?.userSettingsLabel ?? '' };
				},
			},
		];
	}

	updateKeybindings(windowId: number, keybindings: readonly INativeSystemWideKeybinding[]): INativeSystemWideKeybindingResult {
		this.assertNotDisposed();
		const bindings = new Map<string, INativeSystemWideKeybinding>();
		const conflicts: string[] = [];
		for (const binding of keybindings) {
			if ([...this.scoped].some(owner => owner.binding?.accelerator === binding.accelerator && owner.binding.commandId !== binding.commandId)) {
				conflicts.push(binding.userSettingsLabel);
				continue;
			}
			if (!bindings.has(binding.accelerator)) bindings.set(binding.accelerator, binding);
		}
		this.byWindow.set(windowId, bindings);
		this.reconcile();
		return {
			failed: [...conflicts, ...[...bindings].filter(([accelerator]) => this.failed.has(accelerator)).map(([, binding]) => binding.userSettingsLabel)],
		};
	}

	/** A contribution lease keeps its registration independent of a window's user shortcut payload. */
	createOwner(windowId: number, run: (binding: INativeSystemWideKeybinding) => void): IGlobalKeybindingOwner {
		this.assertNotDisposed();
		const owner: ScopedBinding = { windowId, run, binding: undefined };
		this.scoped.add(owner);
		return Object.assign(
			toDisposable(() => {
				const removed = this.scoped.delete(owner);
				owner.binding = undefined;
				if (removed && !this.isDisposed) this.reconcile();
			}),
			{
				getBinding: () => owner.binding,
				check: (accelerator: string, commandId: string) => this.check(accelerator, commandId),
				update: (binding: INativeSystemWideKeybinding | undefined): boolean => {
					this.assertNotDisposed();
					if (!this.scoped.has(owner)) throw new Error('Shortcut owner has closed');
					if (binding) {
						const conflicting =
							[...this.byWindow.values()].some(bindings => {
								const current = bindings.get(binding.accelerator);
								return current && current.commandId !== binding.commandId;
							}) || [...this.scoped].some(other => other !== owner && other.binding?.accelerator === binding.accelerator && other.binding.commandId !== binding.commandId);
						if (conflicting || (!this.registered.has(binding.accelerator) && !this.register(binding.accelerator))) return false;
					}
					// Acquire a replacement before releasing the old shortcut; a failed attempt leaves it effective.
					owner.binding = binding;
					this.reconcile();
					return true;
				},
			},
		);
	}

	private check(accelerator: string, commandId: string): boolean {
		this.assertNotDisposed();
		if (this.registered.has(accelerator)) {
			return (
				![...this.byWindow.values()].some(bindings => {
					const current = bindings.get(accelerator);
					return current && current.commandId !== commandId;
				}) && ![...this.scoped].some(owner => owner.binding?.accelerator === accelerator && owner.binding.commandId !== commandId)
			);
		}
		// isRegistered covers registrations in this process outside this owner. Never release those.
		if (this.options.shortcuts.isRegistered(accelerator)) return false;
		let acquired = false;
		try {
			acquired = this.options.shortcuts.register(accelerator, () => {});
			return acquired;
		} catch (error) {
			this.options.onError(error);
			return false;
		} finally {
			if (acquired) this.options.shortcuts.unregister(accelerator);
		}
	}

	private register(accelerator: string): boolean {
		try {
			if (this.options.shortcuts.isRegistered(accelerator)) return false;
			if (this.options.shortcuts.register(accelerator, () => this.trigger(accelerator))) {
				this.registered.add(accelerator);
				return true;
			}
		} catch (error) {
			this.options.onError(error);
		}
		return false;
	}

	removeWindow(windowId: number): void {
		const removed = this.byWindow.delete(windowId);
		let scopedRemoved = false;
		for (const owner of this.scoped)
			if (owner.windowId === windowId) {
				owner.binding = undefined;
				this.scoped.delete(owner);
				scopedRemoved = true;
			}
		if (!removed && !scopedRemoved) return;
		this.reconcile();
	}

	protected override disposeCore(): void {
		for (const accelerator of this.registered) this.options.shortcuts.unregister(accelerator);
		this.registered.clear();
		this.failed.clear();
		this.byWindow.clear();
		this.scoped.clear();
	}

	private reconcile(): void {
		const desired = new Set([...this.byWindow.values()].flatMap(bindings => [...bindings.keys()]).concat([...this.scoped].flatMap(owner => (owner.binding ? [owner.binding.accelerator] : []))));
		for (const accelerator of this.registered) {
			if (desired.has(accelerator)) continue;
			this.options.shortcuts.unregister(accelerator);
			this.registered.delete(accelerator);
		}
		for (const accelerator of desired) {
			if (this.registered.has(accelerator)) continue;
			this.register(accelerator);
		}
		this.failed.clear();
		for (const accelerator of desired) if (!this.registered.has(accelerator)) this.failed.add(accelerator);
	}

	private trigger(accelerator: string): void {
		const active = this.options.activeWindowId();
		const scoped = [...this.scoped].filter(owner => owner.binding?.accelerator === accelerator);
		const contribution = scoped.find(owner => owner.windowId === active) ?? (active === undefined || !this.byWindow.get(active)?.has(accelerator) ? scoped[0] : undefined);
		if (contribution?.binding) {
			try {
				contribution.run(contribution.binding);
			} catch (error) {
				this.options.onError(error);
			}
			return;
		}
		const owner = active !== undefined ? this.byWindow.get(active)?.get(accelerator) : undefined;
		const selected =
			owner && active !== undefined
				? { windowId: active, binding: owner }
				: [...this.byWindow].map(([windowId, bindings]) => ({ windowId, binding: bindings.get(accelerator) })).find(item => item.binding);
		const binding = selected?.binding;
		if (!binding) return;
		void (async () => this.options.runCommand(selected.windowId, binding.commandId, binding.args))().catch(this.options.onError);
	}
}
