import { Disposable, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { raceCancellationError } from '../../../../../base/common/async.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import type { ITerminalCommand } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import type { ITerminalInstance } from '../../../terminal/browser/terminal.js';
import type { ITerminalQuickFix, ITerminalQuickFixProvider, ITerminalQuickFixService } from './quickFix.js';

/** Selectors are admitted with the extension and evaluated by its original runtime. */
export class TerminalQuickFixService extends Disposable implements ITerminalQuickFixService {
	private readonly providers = new Map<string, { readonly provider: ITerminalQuickFixProvider; readonly controller: AbortController }>();
	registerQuickFixProvider(id: string, provider: ITerminalQuickFixProvider): IDisposable {
		if (this.isDisposed) throw new CancellationError();
		if (this.providers.has(id)) throw new Error('Terminal quick fix provider is already registered');
		// Results belong to this registration, even if the same provider is registered again.
		const entry = { provider, controller: new AbortController() };
		this.providers.set(id, entry);
		return toDisposable(() => {
			if (this.providers.get(id) !== entry) return;
			this.providers.delete(id);
			entry.controller.abort();
		});
	}
	async provideTerminalQuickFixes(instance: ITerminalInstance, command: ITerminalCommand, signal: AbortSignal): Promise<readonly ITerminalQuickFix[]> {
		if (signal.aborted) return [];
		const entries = [...this.providers.entries()];
		// An async callback isolates both synchronous throws and rejected provider promises.
		const replies = await Promise.allSettled(
			entries.map(async ([id, entry]) => {
				if (signal.aborted || this.providers.get(id) !== entry) return [];
				const cancellation = AbortSignal.any([signal, entry.controller.signal]);
				return raceCancellationError(entry.provider.provideTerminalQuickFixes(instance, command, cancellation), cancellation);
			}),
		);
		if (signal.aborted) return [];
		return replies.flatMap((reply, index) => {
			const [id, entry] = entries[index]!;
			if (reply.status !== 'fulfilled' || this.providers.get(id) !== entry) return [];
			return reply.value.map(fix => ({
				...fix,
				isValid: () => !signal.aborted && this.providers.get(id) === entry && fix.isValid?.() !== false,
			}));
		});
	}
	protected override disposeCore(): void {
		const entries = [...this.providers.values()];
		this.providers.clear();
		for (const entry of entries) entry.controller.abort();
		super.disposeCore();
	}
}
