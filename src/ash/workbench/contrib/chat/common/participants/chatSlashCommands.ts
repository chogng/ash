import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import type { URI } from '../../../../../base/common/uri.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import type { IChatSideChatRequestOptions } from '../chatSideChatService.js';

export interface IChatSlashCommandData {
	readonly command: string;
	readonly detail: string;
	readonly executeDuringRequest?: boolean;
}

type SlashCommandHandler = (prompt: string, sessionResource: URI, options?: IChatSideChatRequestOptions) => Promise<void>;

export const IChatSlashCommandService = createDecorator<IChatSlashCommandService>('chatSlashCommandService');

export interface IChatSlashCommandService {
	readonly onDidChangeCommands: import('../../../../../base/common/event.js').Event<void>;
	registerSlashCommand(data: IChatSlashCommandData, handler: SlashCommandHandler): IDisposable;
	getCommands(): readonly IChatSlashCommandData[];
	executeCommand(command: string, prompt: string, sessionResource: URI, options?: IChatSideChatRequestOptions): Promise<void>;
}

/** Owns contributed client commands; input catalogs project this registry for parsing and completion. */
export class ChatSlashCommandService extends Disposable implements IChatSlashCommandService {
	private readonly commands = new Map<string, { readonly data: IChatSlashCommandData; readonly handler: SlashCommandHandler; }>();
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChangeCommands = this.changed.event;

	registerSlashCommand(data: IChatSlashCommandData, handler: SlashCommandHandler): IDisposable {
		if (!/^[a-z0-9][a-z0-9-]*$/u.test(data.command) || !data.detail.trim() || this.commands.has(data.command)) throw new TypeError('Invalid or duplicate client slash command');
		const entry = { data: Object.freeze({ ...data }), handler };
		this.commands.set(data.command, entry);
		this.changed.fire();
		return toDisposable(() => { if (this.commands.get(data.command) === entry) { this.commands.delete(data.command); this.changed.fire(); } });
	}

	getCommands(): readonly IChatSlashCommandData[] { return [...this.commands.values()].map(entry => entry.data); }

	async executeCommand(command: string, prompt: string, resource: URI, options?: IChatSideChatRequestOptions): Promise<void> {
		const entry = this.commands.get(command);
		if (!entry) throw new Error(`Unknown client slash command: /${command}`);
		await entry.handler(prompt, resource, options);
	}

	protected override disposeCore(): void { this.commands.clear(); super.disposeCore(); }
}
