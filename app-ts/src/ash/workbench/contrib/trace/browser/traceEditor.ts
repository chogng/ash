import './traceEditor.css';
import { addDisposableListener, h, type IDimension } from '../../../../base/browser/dom.js';
import { triggerDownload } from '../../../../base/browser/fileAccess.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import type { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { DialogSeverity, type IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import type { EditorInput } from '../../../services/editor/common/editorService.js';
import { EditorPaneVisibility, type IEditorPane } from '../../../browser/parts/editor/editorPane.js';
import { exportTrace, TraceConnection, type TraceConnectionState, type TraceSpan } from './traceConnection.js';

export const traceEditorId = 'workbench.editor.trace';
let nextListId = 0;

/** Developer trace UI; the connection owns the wire contract and bounded capture. */
export class TraceEditor extends Disposable implements IEditorPane {
	readonly id = traceEditorId;
	private readonly connection = this._register(new TraceConnection());
	private domNode!: HTMLDivElement;
	private listDomNode!: HTMLDivElement;
	private statusDomNode!: HTMLDivElement;
	private countDomNode!: HTMLDivElement;
	private detailsDomNode!: HTMLPreElement;
	private address!: InputBox;
	private token!: InputBox;
	private filter!: InputBox;
	private connectButton!: Button;
	private disconnectButton!: Button;
	private exportButton!: Button;
	private selected: string | undefined;
	private visible: readonly TraceSpan[] = [];
	private readonly rows = new Map<string, { domNode: HTMLDivElement; label: HTMLSpanElement; bar: HTMLSpanElement }>();
	private frame: number | undefined;
	private shown = true;
	private readonly listId = 'ash-trace-list-' + nextListId++;

	constructor(private readonly dialogs: IDialogService, private readonly configuration: IConfigurationService) { super(); }

	create(parent: HTMLElement): void {
		const document = parent.ownerDocument;
		this.domNode = h(document, 'div');
		this.domNode.className = 'ash-trace';
		parent.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		const toolbar = h(document, 'div');
		toolbar.className = 'ash-trace-toolbar';
		this.domNode.append(toolbar);
		this.address = this.field(toolbar, localize('trace.address', 'Trace address'));
		this.address.value = 'ws://127.0.0.1:4319/';
		this.token = this.field(toolbar, localize('trace.token', 'Trace token'), 'password');
		this.connectButton = this._register(new Button(toolbar, { label: localize('trace.connect', 'Connect'), presentation: 'primary', onClick: () => {
			this.selected = undefined;
			this.connection.connect(this.address.value, this.token.value);
		} }));
		this.disconnectButton = this._register(new Button(toolbar, { label: localize('trace.disconnect', 'Disconnect'), onClick: () => this.connection.disconnect() }));
		this._register(new Button(toolbar, { label: localize('trace.clear', 'Clear'), onClick: () => { this.selected = undefined; this.connection.clear(); } }));
		this.exportButton = this._register(new Button(toolbar, { label: localize('trace.export', 'Export filtered OTLP'), onClick: () => {
			triggerDownload(new Blob([exportTrace(this.filtered())], { type: 'application/json' }), 'ash-traces.json', document);
		} }));
		this._register(new Button(toolbar, { label: localize('trace.help', 'Help'), onClick: () => { void this.showHelp(); } }));
		this.filter = this.field(this.domNode, localize('trace.filter', 'Filter by name, outcome or trace ID'), 'search');
		this._register(this.filter.onDidChange(() => this.scheduleRender()));
		this.statusDomNode = h(document, 'div');
		this.statusDomNode.className = 'ash-trace-status';
		this.statusDomNode.setAttribute('role', 'status');
		this.countDomNode = h(document, 'div');
		this.countDomNode.className = 'ash-trace-count';
		const body = h(document, 'div');
		body.className = 'ash-trace-body';
		this.listDomNode = h(document, 'div');
		this.listDomNode.className = 'ash-trace-list';
		this.listDomNode.id = this.listId;
		this.listDomNode.tabIndex = 0;
		this.listDomNode.setAttribute('role', 'listbox');
		this.listDomNode.setAttribute('aria-label', localize('trace.timeline', 'Trace timeline'));
		this.detailsDomNode = h(document, 'pre');
		this.detailsDomNode.className = 'ash-trace-details';
		this.detailsDomNode.tabIndex = 0;
		this.detailsDomNode.setAttribute('role', 'region');
		this.detailsDomNode.setAttribute('aria-label', localize('trace.details', 'Span details'));
		body.append(this.listDomNode, this.detailsDomNode);
		this.domNode.append(this.statusDomNode, this.countDomNode, body);
		this._register(addDisposableListener(this.listDomNode, 'click', event => {
			const row = (event.target as Element).closest<HTMLElement>('.ash-trace-row');
			if (row) { this.select(row.dataset.key!); this.listDomNode.focus(); }
		}));
		this._register(addDisposableListener(this.listDomNode, 'keydown', event => {
			if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || !this.visible.length) { return; }
			event.preventDefault();
			event.stopPropagation();
			const current = this.visible.findIndex(span => span.key === this.selected);
			const index = event.key === 'Home' ? 0 : event.key === 'End' ? this.visible.length - 1 :
				Math.max(0, Math.min(this.visible.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)));
			this.select(this.visible[index]!.key);
			this.rows.get(this.selected!)!.domNode.scrollIntoView({ block: 'nearest' });
		}));
		this._register(addDisposableListener(this.domNode, 'keydown', event => {
			if (event.altKey && event.key === 'F1') { event.preventDefault(); event.stopPropagation(); void this.showHelp(); }
		}));
		this._register(this.connection.onDidChange(() => this.scheduleRender()));
		this._register(toDisposable(() => {
			if (this.frame !== undefined) { document.defaultView!.cancelAnimationFrame(this.frame); }
			this.token.value = '';
		}));
		this.render();
	}

	async setInput(_input: EditorInput, signal: AbortSignal): Promise<void> { signal.throwIfAborted(); }
	clearInput(): void { this.connection.disconnect(); this.connection.clear(); this.token.value = ''; }
	layout(dimension: IDimension): void { this.domNode.style.width = dimension.width + 'px'; this.domNode.style.height = dimension.height + 'px'; }
	setVisible(visibility: EditorPaneVisibility): void { this.shown = visibility === EditorPaneVisibility.Visible; if (this.shown) { this.scheduleRender(); } }
	focus(): void {
		this.address.focus();
		if (this.configuration.getValue<boolean>('accessibility.verbosity.trace')) {
			this.statusDomNode.textContent = localize('trace.hint', 'Trace viewer. Press Alt+F1 for keyboard and connection help.');
		}
	}

	private field(container: HTMLElement, text: string, type: 'text' | 'password' | 'search' = 'text'): InputBox {
		const label = h(container.ownerDocument, 'label');
		label.className = 'ash-trace-field';
		const caption = h(container.ownerDocument, 'span');
		caption.textContent = text;
		label.append(caption);
		container.append(label);
		return this._register(new InputBox(label, { type, ariaLabel: text, presentation: 'field' }));
	}

	private filtered(): readonly TraceSpan[] {
		const query = this.filter.value.trim().toLowerCase();
		return this.connection.buffer.spans.filter(span => [span.name, span.outcome, outcomeLabel(span.outcome), span.traceId].some(value => value.toLowerCase().includes(query)));
	}

	private scheduleRender(): void {
		if (this.frame !== undefined || !this.shown || this.isDisposed) { return; }
		this.frame = this.domNode.ownerDocument.defaultView!.requestAnimationFrame(() => { this.frame = undefined; this.render(); });
	}

	private render(): void {
		this.visible = this.filtered();
		const spans = this.connection.buffer.spans;
		const busy = this.connection.state === 'connected' || this.connection.state === 'connecting';
		this.connectButton.enabled = !busy;
		this.disconnectButton.enabled = busy;
		this.address.enabled = this.token.enabled = !busy;
		this.exportButton.enabled = this.visible.length > 0;
		const status = connectionLabel(this.connection.state);
		if (this.statusDomNode.textContent !== status) { this.statusDomNode.textContent = status; }
		this.countDomNode.textContent = localize('trace.count', '{0} shown / {1} retained · {2} dropped', this.visible.length, spans.length, this.connection.buffer.dropped);
		const keys = new Set(this.visible.map(span => span.key));
		for (const [key, row] of this.rows) { if (!keys.has(key)) { row.domNode.remove(); this.rows.delete(key); } }
		if (!this.selected || !keys.has(this.selected)) { this.selected = this.visible[0]?.key; }
		const byKey = new Map(spans.map(span => [span.key, span]));
		const start = spans[0]?.start ?? 0n;
		const end = spans.reduce((end, span) => span.end > end ? span.end : end, start + 1n);
		const range = Number(end - start);
		let previous: HTMLElement | undefined;
		for (const span of this.visible) {
			let row = this.rows.get(span.key);
			if (!row) {
				const domNode = h(this.domNode.ownerDocument, 'div');
				domNode.className = 'ash-trace-row';
				domNode.dataset.key = span.key;
				domNode.id = this.listId + '-' + span.key;
				domNode.setAttribute('role', 'option');
				const label = h(this.domNode.ownerDocument, 'span');
				label.className = 'ash-trace-label';
				const track = h(this.domNode.ownerDocument, 'span');
				track.className = 'ash-trace-track';
				track.setAttribute('aria-hidden', 'true');
				const bar = h(this.domNode.ownerDocument, 'span');
				bar.className = 'ash-trace-bar';
				track.append(bar);
				domNode.append(label, track);
				row = { domNode, label, bar };
				this.rows.set(span.key, row);
			}
			let depth = 0;
			let ancestor = span;
			const seen = new Set([span.key]);
			while (ancestor.parentSpanId) {
				const parent = byKey.get(ancestor.traceId + ':' + ancestor.parentSpanId);
				if (!parent || seen.has(parent.key)) { break; }
				seen.add(parent.key); ancestor = parent; depth++;
			}
			row.label.textContent = localize('trace.row', '{0} · {1} · +{2} ms · {3} ms', span.name, outcomeLabel(span.outcome), (Number(span.start - start) / 1e6).toFixed(3), (Number(span.end - span.start) / 1e6).toFixed(3));
			row.label.style.paddingInlineStart = Math.min(depth, 12) * 12 + 'px';
			row.bar.style.marginInlineStart = Number(span.start - start) / range * 100 + '%';
			row.bar.style.width = Number(span.end - span.start) / range * 100 + '%';
			const next = previous ? previous.nextSibling : this.listDomNode.firstChild;
			if (next !== row.domNode) { this.listDomNode.insertBefore(row.domNode, next); }
			previous = row.domNode;
		}
		this.updateSelection();
	}

	private select(key: string): void { this.selected = key; this.updateSelection(); }
	private updateSelection(): void {
		for (const [key, row] of this.rows) {
			row.domNode.classList.toggle('selected', key === this.selected);
			row.domNode.setAttribute('aria-selected', String(key === this.selected));
		}
		const span = this.visible.find(span => span.key === this.selected);
		if (span) { this.listDomNode.setAttribute('aria-activedescendant', this.rows.get(span.key)!.domNode.id); }
		else { this.listDomNode.removeAttribute('aria-activedescendant'); }
		const details = span ? exportTrace([span]) : localize('trace.empty', 'No spans. Connect, then perform an action in Ash.');
		if (this.detailsDomNode.textContent !== details) { this.detailsDomNode.textContent = details; }
	}

	private async showHelp(): Promise<void> {
		const focus = this.domNode.ownerDocument.activeElement as HTMLElement | null;
		await this.dialogs.showMessage({
			severity: DialogSeverity.Info, title: localize('trace.helpTitle', 'Trace viewer help'),
			message: localize('trace.helpText', 'Enable tracing before starting App Server: set ASH_TRACE_WEBSOCKET_ADDR to 127.0.0.1:4319 and ASH_TRACE_WEBSOCKET_TOKEN to a random 64-digit hexadecimal token. Enter that address and token here. Only new completed spans are received. Connect starts a new capture; Disconnect keeps the capture. Up to 2,000 spans and 8 MiB are retained; dropped spans are counted. Tab moves between controls. Arrow keys, Home and End select spans. The timeline gives each span’s name, result, relative start and duration as text; Span details contains selectable OTLP JSON with trace and parent IDs. Filtering also limits the OTLP export. Tokens and captures are kept only in this editor. Escape closes this help dialog.'),
		});
		if (focus?.isConnected) { focus.focus(); }
	}
}

function outcomeLabel(outcome: string): string {
	switch (outcome) {
		case 'succeeded': return localize('trace.succeeded', 'Succeeded');
		case 'failed': return localize('trace.failed', 'Failed');
		case 'cancelled': return localize('trace.cancelled', 'Cancelled');
		default: return outcome;
	}
}
function connectionLabel(state: TraceConnectionState): string {
	switch (state) {
		case 'disconnected': return localize('trace.disconnected', 'Disconnected');
		case 'connecting': return localize('trace.connecting', 'Connecting…');
		case 'connected': return localize('trace.connected', 'Connected · listening for completed spans');
		case 'configurationError': return localize('trace.configurationError', 'Use a loopback ws:// address with no query and a 64-digit hexadecimal token.');
		case 'connectionError': return localize('trace.connectionError', 'Connection failed. Check the running App Server, address and token.');
		case 'protocolError': return localize('trace.protocolError', 'Invalid trace stream. The connection was closed.');
	}
}
