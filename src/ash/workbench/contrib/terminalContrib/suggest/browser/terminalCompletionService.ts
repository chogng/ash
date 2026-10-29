import { Emitter } from '../../../../../base/common/event.js';
import { raceCancellationError } from '../../../../../base/common/async.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { Disposable, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import type { ITerminalInstance } from '../../../terminal/browser/terminal.js';

export interface ITerminalCompletion {
	readonly label: string;
	/** Shell-ready text for host-generated resources; provider labels retain their insertion semantics. */
	readonly insertText?: string;
	readonly isValid?: () => boolean;
	readonly replacementRange: readonly [number, number];
	readonly detail?: string;
	readonly documentation?: string;
	readonly kind?: number;
}
export interface ITerminalCompletionProvider {
	readonly triggerCharacters?: readonly string[];
	provideCompletions(
		instance: ITerminalInstance,
		value: string,
		cursorIndex: number,
		signal: AbortSignal,
	): Promise<readonly ITerminalCompletion[]>;
}
export const ITerminalCompletionService = createDecorator<ITerminalCompletionService>('terminalCompletionService');
export interface ITerminalCompletionService {
	readonly providers: IterableIterator<ITerminalCompletionProvider>;
	readonly onDidChangeProviders: import('../../../../../base/common/event.js').Event<void>;
	registerTerminalCompletionProvider(
		extensionIdentifier: string,
		id: string,
		provider: ITerminalCompletionProvider,
		...triggerCharacters: string[]
	): IDisposable;
	provideCompletions(
		instance: ITerminalInstance,
		value: string,
		cursorIndex: number,
		signal: AbortSignal,
		triggerCharacter?: string,
	): Promise<readonly ITerminalCompletion[]>;
}

/** One window owns the providers; every request still belongs to its original terminal prompt. */
export class TerminalCompletionService extends Disposable implements ITerminalCompletionService {
	private readonly registered = new Map<
		string,
		ITerminalCompletionProvider & { readonly controller: AbortController }
	>();
	get providers(): IterableIterator<ITerminalCompletionProvider> {
		return this.registered.values();
	}
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChangeProviders = this.changed.event;
	registerTerminalCompletionProvider(
		extensionIdentifier: string,
		id: string,
		provider: ITerminalCompletionProvider,
		...triggerCharacters: string[]
	): IDisposable {
		if (this.isDisposed) throw new CancellationError();
		const key = `${extensionIdentifier}/${id}`;
		if (this.registered.has(key)) throw new Error('Terminal completion provider is already registered');
		const entry = {
			controller: new AbortController(),
			triggerCharacters,
			provideCompletions: provider.provideCompletions.bind(provider),
		};
		this.registered.set(key, entry);
		this.changed.fire();
		return toDisposable(() => {
			if (this.registered.get(key) !== entry) return;
			this.registered.delete(key);
			entry.controller.abort();
			this.changed.fire();
		});
	}
	async provideCompletions(
		instance: ITerminalInstance,
		value: string,
		cursorIndex: number,
		signal: AbortSignal,
		triggerCharacter?: string,
	): Promise<readonly ITerminalCompletion[]> {
		if (signal.aborted) return [];
		const entries = [...this.registered.entries()].filter(
			([, entry]) => triggerCharacter === undefined || entry.triggerCharacters?.includes(triggerCharacter),
		);
		// An async callback isolates both synchronous throws and rejected provider promises.
		const replies = await Promise.allSettled(
			entries.map(async ([key, entry]) => {
				if (signal.aborted || this.registered.get(key) !== entry) return [];
				const cancellation = AbortSignal.any([signal, entry.controller.signal]);
				return raceCancellationError(
					entry.provideCompletions(instance, value, cursorIndex, cancellation),
					cancellation,
				);
			}),
		);
		if (signal.aborted) return [];
		return replies.flatMap((reply, index) => {
			const [key, entry] = entries[index]!;
			if (reply.status !== 'fulfilled' || this.registered.get(key) !== entry) return [];
			return reply.value.map(item => ({
				...item,
				isValid: () => !signal.aborted && this.registered.get(key) === entry && item.isValid?.() !== false,
			}));
		});
	}
	protected override disposeCore(): void {
		const entries = [...this.registered.values()];
		this.registered.clear();
		for (const entry of entries) entry.controller.abort();
		super.disposeCore();
	}
}
