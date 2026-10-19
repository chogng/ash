import { Disposable, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import type { ITerminalCommand } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import type { ITerminalInstance } from '../../../terminal/browser/terminal.js';
import type { ITerminalQuickFix, ITerminalQuickFixProvider, ITerminalQuickFixService } from './quickFix.js';

/** Selectors are admitted with the extension and evaluated by its original runtime. */
export class TerminalQuickFixService extends Disposable implements ITerminalQuickFixService {
	private readonly providers = new Map<string, ITerminalQuickFixProvider>();
	registerQuickFixProvider(id: string, provider: ITerminalQuickFixProvider): IDisposable {
		if (this.providers.has(id)) throw new Error('Terminal quick fix provider is already registered');
		this.providers.set(id, provider);
		return toDisposable(() => { if (this.providers.get(id) === provider) this.providers.delete(id); });
	}
	async provideTerminalQuickFixes(instance: ITerminalInstance, command: ITerminalCommand, signal: AbortSignal): Promise<readonly ITerminalQuickFix[]> {
		const entries = [...this.providers.values()];
		const replies = await Promise.allSettled(entries.map(provider => provider.provideTerminalQuickFixes(instance, command, signal)));
		if (signal.aborted) return [];
		return replies.flatMap((reply, index) => reply.status === 'fulfilled' && [...this.providers.values()].includes(entries[index]!) ? reply.value.map(fix => ({ ...fix, isValid: () => !signal.aborted && [...this.providers.values()].includes(entries[index]!) && fix.isValid?.() !== false })) : []);
	}
	protected override disposeCore(): void { this.providers.clear(); super.disposeCore(); }
}
