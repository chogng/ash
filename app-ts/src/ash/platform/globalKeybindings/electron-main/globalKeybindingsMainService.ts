import { AbstractDisposable } from '../../../base/common/lifecycle.js';
import type { INativeSystemWideKeybinding, INativeSystemWideKeybindingResult } from '../../native/common/nativeHost.js';

export interface IGlobalShortcutRegistry {
	register(accelerator: string, callback: () => void): boolean;
	unregister(accelerator: string): void;
}

export interface GlobalKeybindingsMainServiceOptions {
	readonly shortcuts: IGlobalShortcutRegistry;
	readonly activeWindowId: () => number | undefined;
	readonly runCommand: (windowId: number, commandId: string) => void | Promise<void>;
	readonly onError: (error: unknown) => void;
}

/** Owns operating-system shortcut registrations requested by live Workbench windows. */
export class GlobalKeybindingsMainService extends AbstractDisposable {
	private readonly byWindow = new Map<number, Map<string, INativeSystemWideKeybinding>>();
	private readonly registered = new Set<string>();
	private readonly failed = new Set<string>();

	constructor(private readonly options: GlobalKeybindingsMainServiceOptions) {
		super();
	}

	updateKeybindings(windowId: number, keybindings: readonly INativeSystemWideKeybinding[]): INativeSystemWideKeybindingResult {
		this.assertNotDisposed();
		const bindings = new Map<string, INativeSystemWideKeybinding>();
		for (const binding of keybindings) {
			if (!bindings.has(binding.accelerator)) bindings.set(binding.accelerator, binding);
		}
		this.byWindow.set(windowId, bindings);
		this.reconcile();
		return { failed: [...bindings].filter(([accelerator]) => this.failed.has(accelerator)).map(([, binding]) => binding.userSettingsLabel) };
	}

	removeWindow(windowId: number): void {
		if (!this.byWindow.delete(windowId)) return;
		this.reconcile();
	}

	protected override disposeCore(): void {
		for (const accelerator of this.registered) this.options.shortcuts.unregister(accelerator);
		this.registered.clear();
		this.failed.clear();
		this.byWindow.clear();
	}

	private reconcile(): void {
		const desired = new Set([...this.byWindow.values()].flatMap(bindings => [...bindings.keys()]));
		for (const accelerator of this.registered) {
			if (desired.has(accelerator)) continue;
			this.options.shortcuts.unregister(accelerator);
			this.registered.delete(accelerator);
		}
		for (const accelerator of desired) {
			if (this.registered.has(accelerator)) continue;
			let registered = false;
			try {
				registered = this.options.shortcuts.register(accelerator, () => this.trigger(accelerator));
			} catch (error) {
				this.options.onError(error);
			}
			if (registered) this.registered.add(accelerator);
		}
		this.failed.clear();
		for (const accelerator of desired) if (!this.registered.has(accelerator)) this.failed.add(accelerator);
	}

	private trigger(accelerator: string): void {
		const active = this.options.activeWindowId();
		const owner = active !== undefined ? this.byWindow.get(active)?.get(accelerator) : undefined;
		const selected = owner && active !== undefined
			? { windowId: active, binding: owner }
			: [...this.byWindow].map(([windowId, bindings]) => ({ windowId, binding: bindings.get(accelerator) })).find(item => item.binding);
		const binding = selected?.binding;
		if (!binding) return;
		void (async () => this.options.runCommand(selected.windowId, binding.commandId))().catch(this.options.onError);
	}
}
