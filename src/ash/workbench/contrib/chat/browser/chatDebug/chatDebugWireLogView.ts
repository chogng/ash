import { triggerDownload } from '../../../../../base/browser/fileAccess.js';
import { AgentWireLogCaptureUnavailableError } from '../../../../../platform/agentHost/common/agentService.js';
import { h } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputbox.js';
import { ScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import type { AgentWireLogFrame, AgentWireLogPage } from '../../../../../platform/agentHost/common/agent.js';
import { defaultButtonStyles, defaultInputBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IChatDebugService } from '../../common/chatDebugService.js';

interface Capture {
	readonly sessionId: string;
	readonly id: string;
	readonly started: Promise<void>;
	stopped?: Promise<void>;
}
interface Entry { readonly frame: AgentWireLogFrame; readonly response?: AgentWireLogFrame; }

/** A replaceable projection of backend evidence. Capture and transport pairing remain backend-owned. */
export class ChatDebugWireLogView extends Disposable {
	readonly container: HTMLElement;
	private readonly notice: HTMLElement;
	private readonly summary: HTMLElement;
	private readonly rows: HTMLElement;
	private readonly details: HTMLElement;
	private readonly scroll: ScrollableElement;
	private readonly filter: InputBox;
	private readonly startButton: Button;
	private readonly stopButton: Button;
	private readonly more: Button;
	private readonly exportButton: Button;
	private exportOperation: object | undefined;
	private readonly rowDisposables = this._register(new DisposableStore());
	private readonly poll = this._register(new RunOnceScheduler(() => { void this.refresh(); }, 1000));
	private capture: Capture | undefined;
	private page: AgentWireLogPage | undefined;
	private sessionId: string | undefined;
	private selected: number | undefined;
	private detailKey: string | undefined;
	private visibleLimit = 100;
	private revision = 0;
	private readOperation: object | undefined;
	private direction: AgentWireLogFrame['direction'] | undefined;
	private error = '';

	constructor(parent: HTMLElement, @IChatDebugService private readonly service: IChatDebugService) {
		super();
		const document = parent.ownerDocument;
		this.container = h(document, 'section', { className: 'ash-chat-debug-wire' });
		this.container.hidden = true;
		this.container.setAttribute('aria-label', localize('chatDebug.wireLog', 'Wire Log'));
		const scope = h(document, 'p', { className: 'ash-chat-debug-notice' });
		scope.textContent = localize('chatDebug.wireScope', 'App Server connection · includes all sessions on this connection. Capture is off by default; contents stay in backend memory until replaced or disconnected. Leaving this view stops capture.');
		const toolbar = h(document, 'div', { className: 'ash-chat-debug-view-navigation' });
		this.startButton = this._register(new Button(toolbar, { ...defaultButtonStyles, label: localize('chatDebug.wireStart', 'Start New Capture'), onClick: () => { void this.start(); } }));
		this.stopButton = this._register(new Button(toolbar, { ...defaultButtonStyles, presentation: 'secondary', label: localize('chatDebug.wireStop', 'Stop Capture'), onClick: () => { void this.stop(); } }));
		this.exportButton = this._register(new Button(toolbar, { ...defaultButtonStyles, presentation: 'secondary', label: localize('chatDebug.wireExport', 'Export Capture'), onClick: () => { void this.exportCapture(); } }));
		this._register(new Button(toolbar, { ...defaultButtonStyles, presentation: 'secondary', label: localize('chatDebug.wireRefresh', 'Refresh Frames'), onClick: () => { void this.refresh(); } }));
		const filterHost = h(document, 'div', { className: 'ash-chat-debug-wire-filter' });
		this.filter = this._register(new InputBox(filterHost, { ...defaultInputBoxStyles, placeholder: localize('chatDebug.wireFilter', 'Filter by method, type, or ID'), ariaLabel: localize('chatDebug.wireFilter', 'Filter by method, type, or ID') }));
		this._register(this.filter.onDidChange(() => this.render()));
		const directions = new Map<AgentWireLogFrame['direction'] | undefined, Button>();
		for (const [direction, label] of [[undefined, localize('chatDebug.wireAll', 'Both Directions')], ['clientToServer', localize('chatDebug.wireC2S', 'Client → Server')], ['serverToClient', localize('chatDebug.wireS2C', 'Server → Client')]] as const) {
			const button = this._register(new Button(toolbar, {
				...defaultButtonStyles, presentation: 'secondary', label, onClick: () => {
					this.direction = direction;
					for (const [value, button] of directions) { button.checked = value === direction; }
					this.render();
				}
			}));
			button.checked = direction === undefined;
			directions.set(direction, button);
		}
		this.notice = h(document, 'p', { className: 'ash-chat-debug-notice' });
		this.notice.setAttribute('role', 'status');
		this.summary = h(document, 'p', { className: 'ash-chat-debug-notice' });
		this.rows = h(document, 'div', { className: 'ash-chat-debug-wire-rows' });
		this.rows.setAttribute('aria-label', localize('chatDebug.wireFrames', 'Protocol Frames'));
		this.details = h(document, 'div', { className: 'ash-chat-debug-wire-details' });
		this.details.setAttribute('role', 'region');
		this.details.setAttribute('aria-label', localize('chatDebug.wireDetails', 'Frame Details'));
		const body = h(document, 'div', { className: 'ash-chat-debug-wire-body' });
		body.append(this.rows, this.details);
		this.scroll = this._register(new ScrollableElement(this.container, { direction: 'vertical', tabIndex: 0, ariaLabel: localize('chatDebug.wireFrames', 'Protocol Frames') }));
		this.scroll.setContent(body);
		this.scroll.element.classList.add('ash-chat-debug-wire-host');
		this.more = this._register(new Button(this.container, { ...defaultButtonStyles, presentation: 'secondary', label: localize('chatDebug.wireMore', 'Show More Frames'), onClick: () => { this.visibleLimit += 100; this.render(); } }));
		this.container.prepend(scope, toolbar, filterHost, this.notice, this.summary, this.scroll.element);
		parent.append(this.container);
		this._register(toDisposable(() => { this.clear(); this.container.remove(); }));
	}

	show(sessionId: string | undefined): void {
		if (this.sessionId !== sessionId) { this.clear(); this.sessionId = sessionId; }
		const wasHidden = this.container.hidden;
		this.container.hidden = false;
		this.render();
		if (wasHidden && this.capture) { void this.refresh(); }
	}
	hide(): void {
		if (this.container.hidden) { return; }
		this.container.hidden = true;
		this.revision++;
		this.readOperation = undefined;
		this.poll.cancel();
		void this.stop();
	}
	clear(): void {
		this.hide();
		this.revision++;
		this.capture = undefined;
		this.page = undefined;
		this.exportOperation = undefined;
		this.sessionId = undefined;
		this.selected = undefined;
		this.detailKey = undefined;
		this.readOperation = undefined;
		this.error = '';
		this.rowDisposables.clear();
		this.rows.replaceChildren(); this.details.replaceChildren();
	}
	layout(width: number): void { this.container.classList.toggle('narrow', width < 640); this.scroll.layout(); }
	focus(): void { this.startButton.focus(); }
	getAccessibleContent(): string { return [this.notice.textContent, this.summary.textContent, ...this.entries().map(entry => this.label(entry)), this.details.textContent].join('\n'); }

	private async start(): Promise<void> {
		if (!this.sessionId || this.readOperation || (this.capture && !this.capture.stopped)) { return; }
		const sessionId = this.sessionId;
		const id = generateUuid();
		// Install the lifetime before awaiting start: hiding while it is in flight must still stop it.
		const capture: Capture = { sessionId, id, started: this.service.startWireLog(sessionId, id) };
		this.capture = capture;
		this.page = undefined; this.selected = undefined; this.visibleLimit = 100; this.error = '';
		this.render();
		try {
			await capture.started;
			if (this.capture === capture && !this.container.hidden) { await this.refresh(); }
		} catch (error) {
			if (this.capture === capture) { this.capture = undefined; this.error = localize('chatDebug.wireFailure', 'Wire Log failed: {0}', String(error)); this.render(); }
		}
	}

	private async stop(): Promise<void> {
		const capture = this.capture;
		if (!capture) { return; }
		capture.stopped ??= capture.started.then(() => this.service.stopWireLog(capture.sessionId, capture.id));
		try {
			await capture.stopped;
			if (this.capture === capture && !this.container.hidden) { await this.refresh(); }
		} catch (error) {
			if (this.capture === capture) {
				capture.stopped = undefined;
				this.error = localize('chatDebug.wireStopFailure', 'Could not stop capture: {0}. Retry Stop Capture.', String(error));
				this.render();
			}
		}
	}

	private async exportCapture(): Promise<void> {
		const capture = this.capture;
		if (!capture || this.exportOperation) { return; }
		const operation = {};
		const revision = this.revision;
		this.exportOperation = operation; this.render();
		let bytes: Uint8Array | undefined;
		const stopped = capture.started.then(async () => { bytes = await this.service.exportWireLog(capture.sessionId, capture.id); });
		capture.stopped = stopped;
		try {
			await stopped;
			if (!this.isDisposed && revision === this.revision && capture === this.capture) {
				triggerDownload(new Blob([bytes!.slice().buffer], { type: 'application/json' }), `ash-wire-${capture.id}.json`, this.container.ownerDocument);
				await this.refresh();
			}
		} catch (error) {
			if (capture === this.capture && !this.isDisposed) {
				capture.stopped = undefined;
				this.error = localize('chatDebug.wireExportFailed', 'Could not export capture: {0}', String(error)); this.render();
			}
		} finally {
			if (this.exportOperation === operation) { this.exportOperation = undefined; if (!this.isDisposed) { this.render(); } }
		}
	}

	private async refresh(): Promise<void> {
		const capture = this.capture;
		if (!capture || this.readOperation || this.container.hidden) { return; }
		const revision = this.revision;
		const operation = {};
		this.readOperation = operation;
		try {
			await capture.started;
			const frames = new Map<number, AgentWireLogFrame>();
			let page: AgentWireLogPage;
			let cursor = 0;
			// Backend pages are byte-bounded as well as count-bounded. A refresh is a replaceable snapshot.
			for (let count = 0; count < 32; count++) {
				page = await this.service.readWireLog(capture.sessionId, capture.id, cursor);
				if (revision !== this.revision || capture !== this.capture || this.container.hidden) { return; }
				for (const frame of page.frames) { frames.set(frame.sequence, frame); }
				cursor = page.cursor;
				this.page = { ...page, frames: [...frames.values()].filter(frame => frame.sequence > page.droppedFrames) };
				if (!page.hasMore) { break; }
			}
			this.error = '';
			this.render();
			if (this.page?.recording) { this.poll.schedule(); }
		} catch (error) {
			if (revision === this.revision && capture === this.capture) {
				if (error instanceof AgentWireLogCaptureUnavailableError) {
					this.capture = undefined; this.page = undefined;
					this.error = localize('chatDebug.wireUnavailable', 'The backend capture is no longer available. Start a new capture on the current connection.');
				} else { this.error = localize('chatDebug.wireFailure', 'Wire Log failed: {0}', String(error)); }
				this.render();
			}
		} finally { if (this.readOperation === operation) { this.readOperation = undefined; } }
	}

	private entries(): Entry[] {
		const frames = this.page?.frames ?? [];
		const requests = new Set(frames.filter(frame => frame.kind === 'request').map(frame => frame.sequence));
		const responses = new Map(frames.filter(frame => frame.requestSequence !== null).map(frame => [frame.requestSequence!, frame]));
		const query = this.filter.value.trim().toLowerCase();
		return frames.filter(frame => frame.requestSequence === null || !requests.has(frame.requestSequence))
			.map(frame => ({ frame, response: responses.get(frame.sequence) }))
			.filter(({ frame, response }) => (!this.direction || frame.direction === this.direction)
				&& `${frame.method ?? ''} ${frame.kind} ${this.kind(frame)} ${response ? this.kind(response) : ''} ${frame.requestId ?? ''} ${frame.isError || response?.isError ? localize('chatDebug.wireError', ' · Error') : ''}`.toLowerCase().includes(query));
	}

	private render(): void {
		const entries = this.entries();
		const active = this.container.ownerDocument.activeElement;
		const focused = this.rows.contains(active) ? active?.getAttribute('data-wire-sequence') : null;
		this.rowDisposables.clear(); this.rows.replaceChildren();
		this.exportButton.enabled = !!this.capture && !this.exportOperation;
		this.startButton.enabled = !this.exportOperation && !!this.sessionId && (!this.capture || (!!this.capture.stopped && this.page?.recording === false));
		this.stopButton.enabled = !!this.capture && this.page?.recording !== false;
		let notice = this.error || (!this.sessionId ? localize('chatDebug.wireLiveOnly', 'Open a saved session to select its App Server connection. Imported traces do not contain Wire Log frames.') : !this.capture ? localize('chatDebug.wireDisabled', 'Capture is off. Start capture, reproduce the issue, then stop to inspect the frames.') : this.page?.recording ? localize('chatDebug.wireRecording', 'Recording transport frames…') : this.page ? localize('chatDebug.wireStopped', 'Capture stopped. No additional frames will be recorded.') : localize('chatDebug.wireStarting', 'Starting capture…'));
		if (this.page?.hasMore) { notice += ' ' + localize('chatDebug.wirePartial', 'More frames are available on the backend. Refresh to read the latest capture.'); }
		if (this.notice.textContent !== notice) { this.notice.textContent = notice; }
		this.summary.textContent = this.page ? localize('chatDebug.wireSummary', 'Connection {0} · {1} frames · {2} matching calls · {3} older frames dropped', this.page.connectionId, this.page.frames.length, entries.length, this.page.droppedFrames) : '';
		if (this.page) {
			const frames = this.page.frames;
			const requests = frames.filter(frame => frame.kind === 'request');
			const answered = new Set(frames.map(frame => frame.requestSequence));
			const durations = frames.flatMap(frame => frame.elapsedMs === null ? [] : [frame.elapsedMs]);
			this.summary.textContent += ' · ' + localize('chatDebug.wireStatistics', '{0} requests · {1} error frames · {2} unanswered in capture · slowest {3}', requests.length, frames.filter(frame => frame.isError).length, requests.filter(frame => !answered.has(frame.sequence)).length, durations.length ? localize('chatDebug.wireLatency', '{0} ms', Math.max(...durations)) : localize('chatDebug.unknown', 'Unknown'));
		}
		this.selected = entries.find(entry => entry.frame.sequence === this.selected)?.frame.sequence ?? entries[0]?.frame.sequence;
		for (const entry of entries.slice(0, this.visibleLimit)) {
			const frame = entry.frame;
			const button = this.rowDisposables.add(new Button(this.rows, { ...defaultButtonStyles, presentation: 'secondary', label: this.label(entry), onClick: () => { this.selected = frame.sequence; this.render(); } }));
			button.domNode.dataset.wireSequence = String(frame.sequence);
			button.checked = frame.sequence === this.selected;
			if (focused === String(frame.sequence)) { button.focus(); }
		}
		this.more.domNode.hidden = entries.length <= this.visibleLimit;
		const entry = entries.find(entry => entry.frame.sequence === this.selected);
		const detailKey = entry ? `${this.capture?.id}:${entry.frame.sequence}:${entry.response?.sequence}` : undefined;
		if (this.detailKey !== detailKey) {
			this.detailKey = detailKey;
			this.details.replaceChildren();
			if (entry) {
				const summary = h(this.container.ownerDocument, 'p', { className: 'ash-chat-debug-notice' });
				summary.textContent = this.label(entry); this.details.append(summary);
				this.detail(entry.frame); if (entry.response) { this.detail(entry.response); }
			}
		}
		this.scroll.layout();
	}

	private label({ frame, response }: Entry): string {
		const direction = frame.direction === 'clientToServer' ? localize('chatDebug.wireC2S', 'Client → Server') : localize('chatDebug.wireS2C', 'Server → Client');
		const state = response ? localize('chatDebug.wireLatency', '{0} ms', response.elapsedMs ?? 0) : frame.kind === 'request' ? localize('chatDebug.wireUnanswered', 'No response in capture') : this.kind(frame);
		return localize('chatDebug.wireRow', '#{0} · {1} · {2} · {3} · {4}{5}', frame.sequence, direction, frame.method ?? this.kind(frame), frame.requestId ?? '', state, (frame.isError || response?.isError) ? localize('chatDebug.wireError', ' · Error') : '');
	}
	private kind(frame: AgentWireLogFrame): string {
		return frame.kind === 'request' ? localize('chatDebug.wireRequest', 'Request') : frame.kind === 'response' ? localize('chatDebug.wireResponse', 'Response') : localize('chatDebug.wireNotification', 'Notification');
	}
	private detail(frame: AgentWireLogFrame): void {
		const document = this.container.ownerDocument;
		const title = h(document, 'h3');
		title.textContent = localize('chatDebug.wireDetailTitle', '#{0} · {1} · {2} · {3} bytes', frame.sequence, this.kind(frame), new Date(frame.timestampMs).toISOString(), frame.byteLength);
		this.details.append(title);
		if (frame.truncated) {
			const warning = h(document, 'p', { className: 'ash-chat-debug-notice' });
			warning.textContent = localize('chatDebug.wireTruncated', 'Truncated at the backend frame limit. This is the original UTF-8 prefix, not a complete JSON document.');
			this.details.append(warning);
		}
		const raw = h(document, 'pre'); raw.textContent = frame.raw; raw.tabIndex = 0;
		raw.setAttribute('aria-label', localize('chatDebug.wireRaw', 'Raw Protocol Frame'));
		this.details.append(raw);
	}
}
