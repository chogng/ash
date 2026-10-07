import { Disposable, DisposableMap, toDisposable } from '../../../base/common/lifecycle.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { normalizeExtensionStatusBarEntries, type ExtensionClientSource, type ExtensionHostFleetSnapshot, type ExtensionStatusBarEntry } from '../../../platform/extensionHost/common/extensionHostApi.js';
import { IStatusbarService, StatusbarAlignment, type IStatusbarEntryAccessor } from '../../services/statusbar/browser/statusbar.js';

class StatusBarRegistration extends Disposable {
	public revision = 0;
	public readonly entries = this._register(new DisposableMap<string, IStatusbarEntryAccessor>());
	public readonly placement = new Map<string, string>();
	constructor() {
		super();
		this._register(toDisposable(() => this.placement.clear()));
	}
}

/** Bridges process-fenced extension values into the window's existing status bar owner. */
export class MainThreadStatusBar extends Disposable {
	private readonly registrations = this._register(new DisposableMap<string, StatusBarRegistration>());

	constructor(
		private readonly reportError: (error: unknown) => void,
		@IStatusbarService private readonly statusbar: IStatusbarService,
		@ICommandService private readonly commands: ICommandService,
	) { super(); }

	public update(snapshot: ExtensionHostFleetSnapshot): void {
		const current = new Set<string>();
		for (const runtime of snapshot.extensions) {
			if (runtime.lifecycle !== 'ready' || runtime.incarnation === undefined) continue;
			const source = { extensionId: runtime.id, activationGeneration: runtime.activationGeneration, incarnation: runtime.incarnation };
			for (const registration of runtime.registrations) {
				if (registration.kind !== 'statusBar') continue;
				const key = registrationKey(source, registration.registrationId);
				current.add(key);
				if (!this.registrations.has(key)) this.registrations.set(key, new StatusBarRegistration());
				this.set(source, registration.registrationId, registration.revision, registration.entries);
			}
		}
		for (const key of this.registrations.keys()) {
			if (!current.has(key)) this.registrations.deleteAndDispose(key);
		}
	}

	public set(source: ExtensionClientSource, registrationId: string, revision: number, values: readonly ExtensionStatusBarEntry[]): void {
		this.assertNotDisposed();
		const key = registrationKey(source, registrationId);
		const registration = this.registrations.get(key);
		if (!registration) throw new Error('Status bar request belongs to a retired extension registration');
		if (!Number.isSafeInteger(revision) || revision < 1) throw new TypeError('Invalid status bar revision');
		if (revision <= registration.revision) return;
		const entries = normalizeExtensionStatusBarEntries(values);
		const current = new Set(entries.map(entry => entry.id));
		for (const id of registration.entries.keys()) {
			if (!current.has(id)) { registration.entries.deleteAndDispose(id); registration.placement.delete(id); }
		}
		for (const value of entries) {
			const entry = {
				text: value.text, tooltip: value.tooltip ?? undefined, ariaLabel: value.ariaLabel ?? value.text,
				run: value.command === null ? undefined : () => {
					// A pending click owns this snapshot; replacing the UI releases all other old arguments.
					if (this.registrations.get(key) !== registration) return;
					return this.commands.executeCommand(value.command!.command, ...value.command!.arguments).catch(error => {
						if (!this.isDisposed) this.reportError(error);
					});
				},
			};
			const placement = JSON.stringify([value.alignment, value.priority]);
			if (registration.placement.get(value.id) !== placement) registration.entries.deleteAndDispose(value.id);
			const accessor = registration.entries.get(value.id);
			if (accessor) accessor.update(entry);
			else registration.entries.set(value.id, this.statusbar.addEntry(entry, {
				id: `extensionHost.statusBar.${key}.${value.id}`, alignment: value.alignment === 'left' ? StatusbarAlignment.Left : StatusbarAlignment.Right, priority: value.priority,
			}));
			registration.placement.set(value.id, placement);
		}
		registration.revision = revision;
	}

	public clear(): void { this.registrations.clearAndDisposeAll(); }
}

function registrationKey(source: ExtensionClientSource, registrationId: string): string {
	return JSON.stringify([source.extensionId, source.activationGeneration, source.incarnation, registrationId]);
}
