import type { ITerminalAddon, Terminal } from '@xterm/xterm';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { TerminalCapability } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { PromptInputState } from '../../../../../platform/terminal/common/capabilities/commandDetection/promptInputModel.js';
import type { ITerminalInstance, IXtermTerminal } from '../../../terminal/browser/terminal.js';
import { TerminalTypeAheadSettingId } from '../common/terminalTypeAheadConfiguration.js';

/** Predictions are disposable screen projections, never edits to the parsed buffer or shell model. */
export class TerminalTypeAheadAddon extends Disposable implements ITerminalAddon {
	readonly id = 'terminal.typeAhead';
	private readonly capabilityListeners = this._register(new DisposableStore());
	private readonly element: HTMLDivElement;
	private pending = '';
	private sentAt = 0;
	private latency = 0;
	private promptReady = false;
	private echoConfirmed = false;
	private generation = 0;

	constructor(
		private readonly instance: ITerminalInstance,
		private readonly screen: IXtermTerminal,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
	) {
		super();
		this.element = screen.element.ownerDocument.createElement('div');
		this.element.className = 'ash-terminal-typeahead';
		this.element.setAttribute('aria-hidden', 'true');
		Object.assign(this.element.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden' });
		this._register(toDisposable(() => this.element.remove()));
		const attachment = screen.attachWidget(this);
		if (attachment) this._register(attachment);
	}

	attach(container: HTMLElement): void { container.append(this.element); }

	activate(raw: Terminal): void {
		const bind = (): void => {
			this.capabilityListeners.clear();
			this.reset();
			const detection = this.instance.capabilities?.get(TerminalCapability.CommandDetection);
			this.promptReady = detection?.promptInputModel.state === PromptInputState.Input;
			if (!detection) return;
			this.capabilityListeners.add(detection.promptInputModel.onDidStartInput(() => { this.reset(); this.promptReady = true; }));
			for (const event of [detection.promptInputModel.onDidFinishInput, detection.promptInputModel.onDidInterrupt]) {
				this.capabilityListeners.add(event(() => { this.promptReady = false; this.reset(); }));
			}
		};
		bind();
		if (this.instance.capabilities) this._register(this.instance.capabilities.onDidChangeCapabilities(bind));
		this._register(this.configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('terminal.integrated')) this.reset();
		}));
		this._register(this.instance.onDidChangeState(() => { this.promptReady = false; this.reset(); }));
		this._register(this.instance.onDidExit(() => { this.promptReady = false; this.reset(); }));
		this._register(this.instance.onDidWriteData(event => {
			if (!this.pending) {
				if (event.data) this.reset();
				return;
			}
			// Only exact printable echo can confirm a prediction. Redraws, control
			// sequences, gaps and mismatches discard it; the original bytes still parse.
			if (!event.trackCommit || !event.data || !this.pending.startsWith(event.data)) { this.reset(); return; }
			this.latency = Math.max(0, performance.now() - this.sentAt);
			this.pending = this.pending.slice(event.data.length);
			this.element.replaceChildren();
			const generation = this.generation;
			void Promise.resolve(event.writePromise).then(() => {
				if (!this.isDisposed && generation === this.generation) {
					// A prompt can be active while the shell has disabled echo. Do not
					// project input until this prompt has committed a real printable echo.
					this.echoConfirmed = true;
					this.render(raw);
				}
			}, () => { if (!this.isDisposed && generation === this.generation) this.reset(); });
		}));
		for (const listener of [
			raw.onKey(({ key }) => {
				const model = this.instance.capabilities?.get(TerminalCapability.CommandDetection)?.promptInputModel;
				if (!this.promptReady || this.instance.isReadOnly || this.instance.state !== 'running'
					|| raw.buffer.active.type !== 'normal' || model?.state !== PromptInputState.Input
					|| model.cursorIndex !== model.value.length || model.ghostTextIndex >= 0 || !/^[\x20-\x7e]+$/.test(key)) {
					if (!/^[\x20-\x7e]+$/.test(key)) this.promptReady = false;
					this.reset();
					return;
				}
				if (this.configuration.getValue<string>(TerminalTypeAheadSettingId.LocalEchoEnabled) === 'off') return;
				if (!this.pending) this.sentAt = performance.now();
				this.pending += key;
				if (this.pending.length > 1024) this.reset();
				else this.render(raw);
			}),
			raw.onRender(() => this.render(raw)),
			raw.onResize(() => this.reset()),
			raw.onScroll(() => this.reset()),
			raw.buffer.onBufferChange(() => this.reset()),
		]) this._register(toDisposable(() => listener.dispose()));
	}

	private reset(): void {
		this.generation++;
		this.pending = '';
		this.echoConfirmed = false;
		this.element.replaceChildren();
	}

	private render(raw: Terminal): void {
		this.element.replaceChildren();
		if (!this.echoConfirmed || !this.pending || raw.buffer.active.type !== 'normal' || this.screen.element.hidden || this.screen.isDisposed) return;
		const enabled = this.configuration.getValue<string>(TerminalTypeAheadSettingId.LocalEchoEnabled);
		const threshold = this.configuration.getValue<number>(TerminalTypeAheadSettingId.LocalEchoLatencyThreshold);
		const folder = this.workspace.getWorkspace().folders.find(folder => folder.id === this.instance.dirId);
		const remote = !!folder && folder.uri.scheme !== 'file';
		if (enabled !== 'on' && (enabled !== 'auto' || !remote || threshold < 0 || this.latency < threshold)) return;
		const title = this.instance.title.toLowerCase();
		if (this.configuration.getValue<readonly string[]>(TerminalTypeAheadSettingId.LocalEchoExcludePrograms).some(program => program && title.includes(program.toLowerCase()))) return;
		const bounds = this.screen.element.querySelector('.xterm-screen')?.getBoundingClientRect();
		if (!bounds?.width || !bounds.height) return;
		const parent = this.element.getBoundingClientRect();
		const rowHeight = bounds.height / raw.rows;
		const cellWidth = bounds.width / raw.cols;
		let column = raw.buffer.active.cursorX;
		let row = raw.buffer.active.baseY + raw.buffer.active.cursorY - raw.buffer.active.viewportY;
		let text = this.pending;
		const style = this.configuration.getValue<string>(TerminalTypeAheadSettingId.LocalEchoStyle);
		while (text && row < raw.rows) {
			const segment = this.element.ownerDocument.createElement('span');
			const length = Math.min(text.length, raw.cols - column);
			if (length <= 0) break;
			segment.textContent = text.slice(0, length);
			Object.assign(segment.style, {
				position: 'absolute', left: `${bounds.left - parent.left + column * cellWidth}px`, top: `${bounds.top - parent.top + row * rowHeight}px`,
				fontFamily: raw.options.fontFamily, fontSize: `${raw.options.fontSize}px`, lineHeight: `${rowHeight}px`, whiteSpace: 'pre',
				letterSpacing: `${raw.options.letterSpacing ?? 0}px`, color: style.startsWith('#') ? style : raw.options.theme?.foreground,
				opacity: style === 'dim' ? '0.5' : '1', fontWeight: style === 'bold' ? 'bold' : 'normal',
				fontStyle: style === 'italic' ? 'italic' : 'normal', textDecoration: style === 'underlined' ? 'underline' : 'none',
				background: style === 'inverted' ? raw.options.theme?.foreground : raw.options.theme?.background,
			});
			if (style === 'inverted') segment.style.color = raw.options.theme?.background ?? '';
			this.element.append(segment);
			text = text.slice(length); column = 0; row++;
		}
	}
}
