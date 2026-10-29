import { toDisposable, type IDisposable } from '../../base/common/lifecycle.js';

/** Registry for editor commands that retrigger inline completions after execution. */
export abstract class TriggerInlineEditCommandsRegistry {
	private static readonly commands = new Map<string, { permanent: boolean; leases: number }>();

	public static getRegisteredCommands(): readonly string[] {
		return [...this.commands.keys()];
	}

	public static registerCommand(commandId: string): void {
		this.entry(commandId).permanent = true;
	}

	/** Provider metadata can leave while another provider or a core command still owns the trigger. */
	public static registerScopedCommand(commandId: string): IDisposable {
		const entry = this.entry(commandId);
		entry.leases++;
		return toDisposable(() => {
			entry.leases--;
			if (!entry.permanent && entry.leases === 0) this.commands.delete(commandId);
		});
	}

	private static entry(commandId: string): { permanent: boolean; leases: number } {
		if (typeof commandId !== 'string' || !commandId.trim())
			throw new TypeError('Inline edit trigger command ID must be a non-empty string');
		let entry = this.commands.get(commandId);
		if (!entry) {
			entry = { permanent: false, leases: 0 };
			this.commands.set(commandId, entry);
		}
		return entry;
	}
}
