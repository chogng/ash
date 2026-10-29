import { terminalTextToDisplayData } from './terminalEscapeSequences.js';
import type { ITerminalOutputSnapshot } from '../../../../platform/terminal/common/terminal.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { Schemas } from '../../../../base/common/network.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { localize } from '../../../../nls.js';
import type { ChatContextAttachment } from '../../../services/chat/common/chatContextService.js';
import type { ITerminalInstance, ITerminalView } from './terminal.js';
import { DetachedTerminal } from './detachedTerminal.js';

/** Capture after xterm parses queued writes; the resulting draft never rereads a live PTY. */
export async function captureTerminalAttachment(instance: ITerminalInstance, view: ITerminalView | null | undefined, signal: AbortSignal): Promise<ChatContextAttachment | undefined> {
	const output = await view?.getTerminalOutput(instance, 100_000, signal);
	if (signal.aborted) return undefined;
	if (!output?.trim()) throw new Error(localize('chat.context.terminalUnavailable', 'The terminal has closed or has no output to attach'));
	const name = localize('chat.context.terminalName', 'Terminal: {0}', instance.title);
	const integration = instance.shellIntegration;
	const commands = integration?.commandDetection && !integration.commandStorageDisabled ? integration.commands : [];
	const content =
		`Terminal: ${instance.title}\nDirectory: ${instance.cwd ?? instance.initialCwd}\n\n${output}` +
		(commands.length ? `\n\n${JSON.stringify({ hasRichCommandDetection: integration!.hasRichCommandDetection, commands }, null, 2)}` : '');
	return Object.freeze({
		id: `terminal:${instance.id}`,
		kind: 'terminal',
		name,
		resource: URI.from({
			scheme: Schemas.internal,
			authority: 'terminal',
			query: new URLSearchParams({ id: instance.id }).toString(),
		}),
		terminalSnapshot: Object.freeze({ text: output, columns: instance.xterm?.raw.cols ?? 80 }),
		resolve: async () => ({ name, content }),
	});
}

/** Mirrors the accepted display snapshot, independent of the source terminal's lifetime. */
export class DetachedTerminalSnapshotMirror extends Disposable {
	private readonly terminal: DetachedTerminal;
	constructor(container: HTMLElement, @IInstantiationService instantiation: IInstantiationService) {
		super();
		this.terminal = this._register(instantiation.createInstance(DetachedTerminal, container));
	}
	async render(snapshot: ITerminalOutputSnapshot): Promise<void> {
		await this.terminal.initialize();
		if (this.isDisposed) return;
		const screen = this.terminal.xterm;
		// A replacement snapshot starts a fresh display, never an appended process stream.
		screen.raw.reset();
		screen.raw.resize(Math.max(2, snapshot.columns), 8);
		let completion: ReturnType<typeof toDisposable> | undefined;
		try {
			await new Promise<void>(resolve => {
				completion = this._register(toDisposable(resolve));
				screen.write(terminalTextToDisplayData(snapshot.text), resolve);
			});
		} finally {
			if (completion) {
				this._store.delete(completion);
				completion.dispose();
			}
		}
		if (!this.isDisposed) screen.fit();
	}
}
