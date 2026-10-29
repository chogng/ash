import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { RawContextKey, type IContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import type { ITerminalContribution, IXtermTerminal } from '../../../terminal/browser/terminal.js';
import type { ITerminalContributionContext } from '../../../terminal/browser/terminalExtensions.js';

export type TerminalDictationState = 'unavailable' | 'idle' | 'active' | 'busy';
export const TerminalDictationStateContext = new RawContextKey<TerminalDictationState>(
	'terminalAshCodeDictationState',
	'unavailable',
);

/** The CLI owns recording and the input draft; the terminal only projects its advertised capability. */
export class TerminalVoiceContribution extends Disposable implements ITerminalContribution {
	static readonly ID = 'terminal.voice';
	private readonly contextKey: IContextKey<TerminalDictationState>;
	private reportedState: TerminalDictationState = 'unavailable';
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;

	constructor(
		private readonly context: ITerminalContributionContext,
		@IContextKeyService contextKeys: IContextKeyService,
	) {
		super();
		this.contextKey = TerminalDictationStateContext.bindTo(contextKeys);
		this._register(toDisposable(() => this.contextKey.reset()));
		this._register(context.instance.onDidChangeState(() => this.setState('unavailable')));
		this._register(context.instance.onDidExit(() => this.setState('unavailable')));
		// A killed CLI cannot emit its clear sequence. Shell completion retires its capability too.
		this._register(
			context.instance.onDidChangeCommandStatus(event => {
				if (event.status !== 'running') this.setState('unavailable');
			}),
		);
	}

	get state(): TerminalDictationState {
		return this.context.instance.state === 'running' && !this.context.instance.isReadOnly
			? this.reportedState
			: 'unavailable';
	}

	xtermReady(screen: IXtermTerminal): void {
		const handler = screen.raw.parser.registerOscHandler(7501, payload => {
			if (payload === 'state=clear') {
				this.setState('unavailable');
				return true;
			}
			// Only this versioned capability enables controls; titles and echoed commands do not.
			const match =
				/^state=(?:idle|working|blocked):app=ash:dictation=(idle|active|busy|unavailable):protocol=1$/.exec(
					payload,
				);
			if (!match) return false;
			this.setState(match[1] as TerminalDictationState);
			return true;
		});
		this._register(toDisposable(() => handler.dispose()));
	}

	async start(): Promise<void> {
		if (this.state !== 'idle') return;
		// Protocol 1 reserves Ctrl+Alt+Shift+F11/F12 for idempotent start/stop, independently of user keybindings.
		await this.context.instance.sendText('\x1b[23;8~', false);
		this.context.instance.xterm?.focus();
	}

	async stop(): Promise<void> {
		if (this.state !== 'active') return;
		await this.context.instance.sendText('\x1b[24;8~', false);
		this.context.instance.xterm?.focus();
	}

	private setState(state: TerminalDictationState): void {
		if (this.reportedState === state) return;
		this.reportedState = state;
		this.contextKey.set(this.state);
		this.changed.fire();
	}
}
