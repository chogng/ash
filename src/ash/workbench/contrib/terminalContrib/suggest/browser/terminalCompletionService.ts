import { Emitter } from '../../../../../base/common/event.js';
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
	provideCompletions(instance: ITerminalInstance, value: string, cursorIndex: number, signal: AbortSignal): Promise<readonly ITerminalCompletion[]>;
}
export const ITerminalCompletionService = createDecorator<ITerminalCompletionService>('terminalCompletionService');
export interface ITerminalCompletionService {
	readonly providers: IterableIterator<ITerminalCompletionProvider>;
	readonly onDidChangeProviders: import('../../../../../base/common/event.js').Event<void>;
	registerTerminalCompletionProvider(extensionIdentifier: string, id: string, provider: ITerminalCompletionProvider, ...triggerCharacters: string[]): IDisposable;
	provideCompletions(instance: ITerminalInstance, value: string, cursorIndex: number, signal: AbortSignal, triggerCharacter?: string): Promise<readonly ITerminalCompletion[]>;
}

/** One window owns the providers; every request still belongs to its original terminal prompt. */
export class TerminalCompletionService extends Disposable implements ITerminalCompletionService {
	private readonly registered = new Map<string, ITerminalCompletionProvider>();
	get providers(): IterableIterator<ITerminalCompletionProvider> { return this.registered.values(); }
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChangeProviders = this.changed.event;
	registerTerminalCompletionProvider(extensionIdentifier: string, id: string, provider: ITerminalCompletionProvider, ...triggerCharacters: string[]): IDisposable {
		const key = `${extensionIdentifier}/${id}`;
		if (this.registered.has(key)) throw new Error('Terminal completion provider is already registered');
		const entry: ITerminalCompletionProvider = { triggerCharacters, provideCompletions: (...args) => provider.provideCompletions(...args) };
		this.registered.set(key, entry);
		this.changed.fire();
		return toDisposable(() => { if (this.registered.get(key) === entry) { this.registered.delete(key); this.changed.fire(); } });
	}
	async provideCompletions(instance: ITerminalInstance, value: string, cursorIndex: number, signal: AbortSignal, triggerCharacter?: string): Promise<readonly ITerminalCompletion[]> {
		const entries = [...this.registered.values()].filter(entry => triggerCharacter === undefined || entry.triggerCharacters?.includes(triggerCharacter));
		const replies = await Promise.allSettled(entries.map(entry => entry.provideCompletions(instance, value, cursorIndex, signal)));
		if (signal.aborted) return [];
		return replies.flatMap((reply, index) => reply.status === 'fulfilled' && [...this.registered.values()].includes(entries[index]!) ? reply.value.map(item => ({ ...item, isValid: () => !signal.aborted && [...this.registered.values()].includes(entries[index]!) && item.isValid?.() !== false })) : []);
	}
	protected override disposeCore(): void { this.registered.clear(); super.disposeCore(); }
}
