import './agentTraceEditor.css';
import { addDisposableListener, h, type IDimension } from '../../../../base/browser/dom.js';
import { triggerDownload } from '../../../../base/browser/fileAccess.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { isRecord } from '../../../../base/common/types.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { localize } from '../../../../nls.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IAccessibleViewService, AccessibilityVerbositySettingId, AccessibleViewType } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import type { IResourceEditorInput, IEditorPane, IEditorControl } from '../../../common/editor.js';
import { IChatService } from '../../../services/chat/common/chatService.js';
import { diagnosticPayload, mergeAgentTrace, mergeAgentTraceDiagnostics, parseAgentTrace, type AgentTrace, type AgentTraceEvent, type AgentTraceGraph } from '../../../services/chat/common/agentTrace.js';

export const agentTraceEditorId = 'ash.agentTrace';

/** Owns a read-only capture and reference-counted subscriptions only while its input is open. */
export class AgentTraceEditor extends EditorPane implements IEditorPane {
	public readonly id = agentTraceEditorId;
	private domNode!: HTMLDivElement;
	private statusDomNode!: HTMLParagraphElement;
	private summaryDomNode!: HTMLParagraphElement;
	private listDomNode!: HTMLDivElement;
	private detailsDomNode!: HTMLPreElement;
	private relationsDomNode!: HTMLDivElement;
	private evidenceButton!: Button;
	private relationsButton!: Button;
	private filter!: InputBox;
	private exportButton!: Button;
	private errorsButton!: Button;
	private trace: AgentTrace | undefined;
	private sessionId: string | undefined;
	private cursors: Readonly<Record<string, number>> = {};
	private diagnosticCursor = 0;
	private readonly diagnosticPoll = this._register(new RunOnceScheduler(() => this.requestRefresh(), 1000));
	private readonly subscriptions = new Set<string>();
	private subscriptionOwner: object = {};
	private revision = 0;
	private loading = false;
	private dirty = false;
	private isShown = true;
	private inputSignal: AbortSignal | undefined;
	private errorsOnly = false;
	private selected: string | undefined;
	private readonly rows = new Map<string, HTMLButtonElement>();
	private readonly threads = new Map<string, { domNode: HTMLElement; label: HTMLElement; children: HTMLElement; }>();
	private readonly turns = new Map<string, { domNode: HTMLElement; label: HTMLElement; }>();
	private readonly pendingInput = this._register(new MutableDisposable<IDisposable>());
	private readonly refreshScheduler = this._register(new RunOnceScheduler(() => { void this.refresh(); }, 100));

	constructor(
		@IChatService private readonly chat: IChatService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IAccessibleViewService private readonly accessibleViews: IAccessibleViewService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService,
	) {
		super(agentTraceEditorId, theme, storage);
		this._register(chat.onDidUpdateThread(event => {
			if (event.sessionId === this.sessionId && event.durableSequence > (this.cursors[event.threadId] ?? 0)) { this.requestRefresh(); }
		}));
		this._register(chat.onDidBecomeReady(() => {
			this.subscriptions.clear();
			this.requestRefresh();
		}));
		this._register(chat.onDidChangeSession(event => {
			if (event.sessionId === this.sessionId) { this.requestRefresh(); }
		}));
		this._register(toDisposable(() => this.clearInput()));
	}

	public override create(parent: HTMLElement): void {
		const document = parent.ownerDocument;
		this.domNode = h(document, 'div', { className: 'ash-agent-trace' });
		const context = this._register(this.contextKeys.createScoped(this.domNode));
		context.createKey('agentTraceFocused', true);
		this.domNode.setAttribute('aria-label', localize('agentTrace.title', 'Execution Trace'));
		const updateHint = (): void => {
			const hint = this.accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.AgentTrace);
			if (hint) { this.domNode.setAttribute('aria-description', hint); }
			else { this.domNode.removeAttribute('aria-description'); }
		};
		this._register(this.configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AccessibilityVerbositySettingId.AgentTrace)) { updateHint(); }
		}));
		updateHint();
		const toolbar = h(document, 'div', { className: 'ash-agent-trace-toolbar' });
		this._register(new Button(toolbar, { label: localize('agentTrace.refresh', 'Refresh'), onClick: () => this.requestRefresh() }));
		this.errorsButton = this._register(new Button(toolbar, { label: localize('agentTrace.errors', 'Errors only'), onClick: () => {
			this.errorsOnly = !this.errorsOnly;
			this.errorsButton.checked = this.errorsOnly;
			this.render();
		} }));
		this.errorsButton.checked = false;
		this.exportButton = this._register(new Button(toolbar, { label: localize('agentTrace.export', 'Export trace'), onClick: () => { void this.exportTrace(); } }));
		this.evidenceButton = this._register(new Button(toolbar, { label: localize('agentTrace.evidence', 'View request / response'), onClick: () => { void this.loadEvidence(); } }));
		this.relationsButton = this._register(new Button(toolbar, { label: localize('agentTrace.relations', 'View relationships'), onClick: () => { void this.loadRelationships(); } }));
		const file = h(document, 'input');
		file.type = 'file';
		file.accept = '.json';
		file.hidden = true;
		file.setAttribute('aria-label', localize('agentTrace.import', 'Import trace'));
		this._register(new Button(toolbar, { label: localize('agentTrace.import', 'Import trace'), onClick: () => file.click() }));
		this._register(new Button(toolbar, { label: localize('agentTrace.help', 'Help'), onClick: () => this.accessibleViews.show(AccessibleViewType.Help) }));
		this._register(addDisposableListener(file, 'change', () => {
			const selected = file.files?.[0];
			if (selected) { void this.importFile(selected); }
			file.value = '';
		}));
		this.filter = this._register(new InputBox(toolbar, { ariaLabel: localize('agentTrace.filter', 'Filter execution events'), placeholder: localize('agentTrace.filter', 'Filter execution events') }));
		this._register(this.filter.onDidChange(() => this.render()));
		this.statusDomNode = h(document, 'p', { className: 'ash-agent-trace-status' });
		this.statusDomNode.setAttribute('role', 'status');
		this.summaryDomNode = h(document, 'p', { className: 'ash-agent-trace-summary' });
		const body = h(document, 'div', { className: 'ash-agent-trace-body' });
		this.listDomNode = h(document, 'div', { className: 'ash-agent-trace-list' });
		this.listDomNode.setAttribute('role', 'region');
		this.listDomNode.setAttribute('aria-label', localize('agentTrace.timeline', 'Execution timeline'));
		this.detailsDomNode = h(document, 'pre', { className: 'ash-agent-trace-details' });
		this.detailsDomNode.tabIndex = 0;
		this.detailsDomNode.setAttribute('role', 'region');
		this.detailsDomNode.setAttribute('aria-label', localize('agentTrace.details', 'Execution event details'));
		const detailColumn = h(document, 'div', { className: 'ash-agent-trace-detail-column' });
		this.relationsDomNode = h(document, 'div', { className: 'ash-agent-trace-relations' });
		this.relationsDomNode.setAttribute('aria-label', localize('agentTrace.relations', 'View relationships'));
		this.relationsDomNode.setAttribute('role', 'region');
		detailColumn.append(this.relationsDomNode, this.detailsDomNode);
		body.append(this.listDomNode, detailColumn);
		this.domNode.append(toolbar, file, this.statusDomNode, this.summaryDomNode, body);
		this._register(addDisposableListener(this.listDomNode, 'click', event => {
			const row = (event.target as Element).closest<HTMLButtonElement>('.ash-agent-trace-event');
			if (row?.dataset.key) { this.select(row.dataset.key); }
		}));
		this._register(addDisposableListener(this.relationsDomNode, 'click', event => {
			const key = (event.target as Element).closest<HTMLButtonElement>('.ash-agent-trace-relation')?.dataset.key;
			if (key) {
				this.errorsOnly = false; this.errorsButton.checked = false; this.filter.value = ''; this.render();
				this.select(key); this.rows.get(key)?.focus();
			}
		}));
		this._register(addDisposableListener(this.listDomNode, 'keydown', event => {
			const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
			if (!keys.includes(event.key)) { return; }
			event.preventDefault();
			const rows = [...this.listDomNode.querySelectorAll<HTMLButtonElement>('.ash-agent-trace-event')].filter(row => !row.hidden);
			const index = rows.findIndex(row => row.dataset.key === this.selected);
			const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
			if (rows[next]?.dataset.key) { this.select(rows[next].dataset.key!); rows[next].focus(); }
		}));
		parent.append(this.domNode);
		super.create(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this.render();
	}

	public override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		this.clearInput();
		if (input.resource.path !== '/import') { this.sessionId = input.resource.path.slice(1); }
		this.inputSignal = signal;
		const abort = (): void => { if (this.inputSignal === signal) { this.clearInput(); } };
		signal.addEventListener('abort', abort, { once: true });
		this.pendingInput.value = toDisposable(() => signal.removeEventListener('abort', abort));
		if (signal.aborted) { abort(); return; }
		if (this.sessionId) { await this.refresh(); }
		else { this.render(); }
	}

	public override clearInput(): void {
		this.revision++;
		this.pendingInput.clear();
		this.inputSignal = undefined;
		this.refreshScheduler.cancel();
		this.diagnosticPoll.cancel();
		this.releaseSubscriptions();
		this.sessionId = undefined;
		this.trace = undefined;
		this.cursors = {};
		this.diagnosticCursor = 0;
		this.selected = undefined;
		this.loading = false;
		this.dirty = false;
		this.rows.clear();
		this.threads.clear();
		this.turns.clear();
		this.listDomNode?.replaceChildren();
		this.render();
	}

	private releaseSubscriptions(): void {
		const sessionId = this.sessionId;
		const owner = this.subscriptionOwner;
		for (const threadId of this.subscriptions) {
			if (sessionId) { void this.chat.unsubscribeThread(sessionId, threadId, owner).catch(onUnexpectedError); }
		}
		this.subscriptions.clear();
		this.subscriptionOwner = {};
	}

	private requestRefresh(): void {
		if (!this.sessionId || !this.isShown) { return; }
		this.dirty = true;
		this.refreshScheduler.schedule();
	}

	private async refresh(): Promise<void> {
		if (!this.sessionId || !this.isShown || this.loading || this.isDisposed) { return; }
		const sessionId = this.sessionId;
		const revision = this.revision;
		const owner = this.subscriptionOwner;
		this.loading = true;
		this.dirty = false;
		this.statusDomNode.textContent = localize('agentTrace.loading', 'Loading execution history…');
		try {
			let more = true;
			while (more && revision === this.revision && !this.isDisposed) {
				const page = await this.chat.readTrace(sessionId, this.cursors);
				if (revision !== this.revision || this.isDisposed) { return; }
				this.trace = mergeAgentTrace(this.trace, page.trace);
				this.cursors = page.cursors;
				more = page.hasMore;
				for (const thread of this.trace.threads) {
					if (this.subscriptions.has(thread.threadId)) { continue; }
					this.subscriptions.add(thread.threadId);
					try {
						const subscribed = await this.chat.subscribeThread(sessionId, thread.threadId, this.cursors[thread.threadId] ?? 0, owner);
						// The subscription snapshot closes the read/subscribe gap, including a Turn that
						// finishes before notifications become attached to this editor.
						if (revision === this.revision && subscribed.thread.sequence > (this.cursors[thread.threadId] ?? 0)) { this.dirty = true; }
					} catch (error) {
						if (revision === this.revision) { this.subscriptions.delete(thread.threadId); }
						await this.chat.unsubscribeThread(sessionId, thread.threadId, owner);
						throw error;
					}
					if (revision !== this.revision || this.isDisposed) {
						await this.chat.unsubscribeThread(sessionId, thread.threadId, owner);
						return;
					}
				}
				this.render();
			}
			let diagnosticMore = true;
			while (diagnosticMore && revision === this.revision && !this.isDisposed) {
				const page = await this.chat.readTraceDiagnostics(sessionId, this.diagnosticCursor);
				if (revision !== this.revision || this.isDisposed || !this.trace) { return; }
				this.trace = { ...this.trace, diagnostics: mergeAgentTraceDiagnostics(this.trace.diagnostics, page.diagnostics), graph: page.diagnostics.events.length ? undefined : this.trace.graph };
				this.diagnosticCursor = page.cursor;
				diagnosticMore = page.hasMore;
			}
			this.render();
			this.statusDomNode.textContent = localize('agentTrace.live', 'Live · durable execution history');
		} catch (error) {
			if (revision === this.revision && !this.isDisposed) {
				this.statusDomNode.textContent = localize('agentTrace.failed', 'Could not load trace: {0}', String(error));
			}
		} finally {
			if (revision === this.revision && !this.isDisposed) {
				this.loading = false;
				if (this.dirty) { this.refreshScheduler.schedule(); }
				if (this.isShown && this.sessionId && ['recording', 'incomplete'].includes(this.trace?.diagnostics?.recordingStatus ?? '')) { this.diagnosticPoll.schedule(); }
			}
		}
	}

	private async importFile(file: File): Promise<void> {
		const revision = this.revision;
		try {
			if (file.size > 64 * 1024 * 1024) { throw new Error(localize('agentTrace.fileSize', 'Trace files must be smaller than 64 MiB.')); }
			const trace = parseAgentTrace(JSON.parse(await file.text()));
			if (revision !== this.revision || this.isDisposed) { return; }
			this.clearInput();
			this.trace = trace;
			this.statusDomNode.textContent = localize('agentTrace.imported', 'Imported · {0}', file.name);
			this.render();
		} catch (error) {
			if (revision === this.revision && !this.isDisposed) { this.statusDomNode.textContent = localize('agentTrace.failed', 'Could not load trace: {0}', String(error)); }
		}
	}

	private render(): void {
		if (!this.domNode) { return; }
		this.exportButton.enabled = !!this.trace;
		this.relationsButton.enabled = !!this.trace;
		if (!this.trace) {
			this.statusDomNode.textContent = localize('agentTrace.empty', 'Open a saved conversation or import an evaluation trace.');
			this.summaryDomNode.textContent = '';
			this.detailsDomNode.textContent = '';
			this.relationsDomNode.replaceChildren();
			this.evidenceButton.enabled = false;
			return;
		}
		const document = this.domNode.ownerDocument;
		const query = this.filter.value.toLowerCase();
		let count = 0;
		let shown = 0;
		for (const thread of this.trace.threads) {
			let group = this.threads.get(thread.threadId);
			if (!group) {
				const domNode = h(document, 'section', { className: 'ash-agent-trace-thread' });
				const label = h(document, 'h2');
				const children = h(document, 'div', { className: 'ash-agent-trace-children' });
				domNode.dataset.threadId = thread.threadId;
				domNode.append(label, children);
				group = { domNode, label, children };
				this.threads.set(thread.threadId, group);
				this.listDomNode.append(domNode);
			}
			const created = thread.events.find(record => record.event.type === 'threadCreated')?.event;
			group.label.textContent = localize('agentTrace.thread', 'Thread · {0}', typeof created?.title === 'string' ? created.title : thread.threadId);
			group.label.title = thread.threadId;
			const origin = isRecord(created?.origin) ? created.origin : undefined;
			const parent = typeof origin?.parentThreadId === 'string' ? this.threads.get(origin.parentThreadId) : undefined;
			if (parent && !group.domNode.contains(parent.domNode)) { parent.children.append(group.domNode); }
			let threadShown = false;
			const records = [
				...thread.events.map(record => ({ key: `${thread.threadId}:${record.sequence}`, record })),
				...(this.trace.diagnostics?.events ?? []).filter(record => record.threadId === thread.threadId).map(record => ({ key: `diagnostic:${record.sequence}`, record: { ...record, event: { ...record.event, threadId: record.threadId, turnId: record.turnId } } })),
			];
			for (const { key, record } of records) {
				count++;
				let row = this.rows.get(key);
				if (!row) {
					row = h(document, 'button', { className: 'ash-agent-trace-event' });
					row.type = 'button';
					row.dataset.key = key;
					row.textContent = eventLabel(record);
					row.title = thread.threadId;
					this.rows.set(key, row);
					const turnId = typeof record.event.turnId === 'string' ? record.event.turnId : undefined;
					if (turnId) {
						const turnKey = `${thread.threadId}:${turnId}`;
						let turn = this.turns.get(turnKey);
						if (!turn) {
							const domNode = h(document, 'section', { className: 'ash-agent-trace-turn' });
							const label = h(document, 'h3');
							domNode.dataset.turnId = turnId;
							label.textContent = localize('agentTrace.turn', 'Turn · {0}', turnId);
							domNode.append(label);
							turn = { domNode, label };
							this.turns.set(turnKey, turn);
							group.domNode.insertBefore(domNode, group.children);
						}
						turn.domNode.append(row);
					} else { group.domNode.insertBefore(row, group.children); }
				}
				const isError = eventIsError(record);
				row.classList.toggle('failed', isError);
				row.hidden = (this.errorsOnly && !isError) || !`${thread.threadId} ${JSON.stringify(record.event)}`.toLowerCase().includes(query);
				if (!row.hidden) { shown++; threadShown = true; }
			}
			group.domNode.hidden = !threadShown;
		}
		for (const turn of this.turns.values()) { turn.domNode.hidden = ![...turn.domNode.querySelectorAll<HTMLButtonElement>('button')].some(row => !row.hidden); }
		for (const thread of this.trace.threads) {
			const origin = thread.events.find(record => record.event.type === 'threadCreated')?.event.origin;
			if (!isRecord(origin) || typeof origin.parentThreadId !== 'string') { continue; }
			const group = this.threads.get(thread.threadId)!;
			const parent = this.threads.get(origin.parentThreadId);
			if (parent && !group.domNode.contains(parent.domNode)) { parent.children.append(group.domNode); }
		}
		// Keep ancestors visible when a descendant matches the filter.
		for (const group of this.threads.values()) {
			if ([...group.children.querySelectorAll<HTMLButtonElement>('button')].some(row => !row.hidden)) { group.domNode.hidden = false; }
		}
		this.summaryDomNode.textContent = localize('agentTrace.summary', '{0} Threads · {1} shown / {2} events.', this.trace.threads.length, shown, count) + ' ' + recordingLabel(this.trace);
		if (!this.selected || this.rows.get(this.selected)?.hidden) {
			this.selected = [...this.rows].find(([, row]) => !row.hidden)?.[0];
		}
		if (this.selected) { this.select(this.selected); }
		else { this.detailsDomNode.textContent = localize('agentTrace.noMatches', 'No matching execution events.'); }
	}

	private select(key: string): void {
		this.selected = key;
		for (const [id, row] of this.rows) {
			row.classList.toggle('selected', id === key);
			row.setAttribute('aria-pressed', String(id === key));
			row.tabIndex = id === key ? 0 : -1;
		}
		this.relationsDomNode.replaceChildren();
		this.evidenceButton.enabled = false;
		const diagnostic = this.trace?.diagnostics?.events.find(record => `diagnostic:${record.sequence}` === key);
		if (diagnostic) {
			const payload = diagnosticPayload(diagnostic);
			this.evidenceButton.enabled = payload?.status === 'saved';
			const evidence = payload && this.trace?.diagnostics?.payloads?.[payload.payloadId];
			this.detailsDomNode.textContent = evidence === undefined ? JSON.stringify(diagnostic, null, 2) : `${evidenceLabel(payload!.kind)}\n${JSON.stringify({ ...diagnostic, evidence }, null, 2)}`;
			if (this.trace?.graph) { this.renderRelationships(this.trace.graph); }
			return;
		}
		for (const thread of this.trace?.threads ?? []) {
			const record = thread.events.find(item => `${thread.threadId}:${item.sequence}` === key);
			if (record) {
				const detail = record.event.type === 'historyPrefixBound' ? { ...record, retainedHistoryPrefixes: this.trace?.historyPrefixes } : record;
				this.detailsDomNode.textContent = JSON.stringify(detail, null, 2);
				if (this.trace?.graph) { this.renderRelationships(this.trace.graph); }
				return;
			}
		}
	}

	private async loadEvidence(): Promise<void> {
		const key = this.selected;
		const record = this.trace?.diagnostics?.events.find(record => `diagnostic:${record.sequence}` === key);
		const payload = record && diagnosticPayload(record);
		if (!payload || payload.status !== 'saved' || !this.trace?.diagnostics) { return; }
		const revision = this.revision;
		try {
			let evidence = this.trace.diagnostics.payloads?.[payload.payloadId];
			if (evidence === undefined && this.sessionId && this.trace.diagnostics.captureId) {
				evidence = await this.chat.readTracePayload(this.sessionId, this.trace.diagnostics.captureId, payload.payloadId);
				if (revision !== this.revision || this.isDisposed || !this.trace?.diagnostics) { return; }
				this.trace = { ...this.trace, diagnostics: { ...this.trace.diagnostics, payloads: { ...this.trace.diagnostics.payloads, [payload.payloadId]: evidence } } };
			}
			if (evidence === undefined) { throw new Error(localize('agentTrace.missingEvidence', 'This capture does not include the selected payload.')); }
			if (key === this.selected) { this.select(key!); }
		} catch (error) { if (revision === this.revision && key === this.selected && !this.isDisposed) { this.statusDomNode.textContent = localize('agentTrace.failed', 'Could not load trace: {0}', String(error)); } }
	}

	private async loadRelationships(): Promise<void> {
		if (!this.trace) { return; }
		const revision = this.revision;
		try {
			const graph = this.trace.graph ?? (this.sessionId ? await this.chat.readTraceGraph(this.sessionId) : undefined);
			if (revision !== this.revision || this.isDisposed || !this.trace) { return; }
			if (graph) { this.trace = { ...this.trace, graph }; this.renderRelationships(graph); }
			else { this.relationsDomNode.textContent = localize('agentTrace.noRelationships', 'No saved relationships for this capture.'); }
		} catch (error) { if (revision === this.revision && !this.isDisposed) { this.statusDomNode.textContent = localize('agentTrace.failed', 'Could not load trace: {0}', String(error)); } }
	}

	private renderRelationships(graph: AgentTraceGraph): void {
		this.relationsDomNode.replaceChildren();
		const selected = new Set(Object.values(graph.nodes).filter(node => node.eventKey === this.selected).map(node => node.id));
		const edges = graph.edges.filter(edge => selected.has(edge.from) || selected.has(edge.to));
		if (!edges.length) { this.relationsDomNode.textContent = localize('agentTrace.noRelationships', 'No saved relationships for this capture.'); }
		for (const edge of edges) {
			const target = graph.nodes[selected.has(edge.from) ? edge.to : edge.from];
			const button = h(this.domNode.ownerDocument, 'button', { className: 'ash-agent-trace-relation' });
			button.type = 'button';
			button.textContent = localize('agentTrace.relatedEvent', '{0} · {1}', relationLabel(edge.kind), target.label);
			button.disabled = !target.eventKey || !this.rows.has(target.eventKey);
			if (target.eventKey) { button.dataset.key = target.eventKey; }
			this.relationsDomNode.append(button);
		}
		if (graph.warnings.length) {
			const warning = h(this.domNode.ownerDocument, 'p');
			warning.textContent = localize('agentTrace.graphIncomplete', '{0} relationships have missing evidence. See exported graph warnings.', graph.warnings.length);
			this.relationsDomNode.append(warning);
		}
	}

	private async exportTrace(): Promise<void> {
		if (!this.trace) { return; }
		const revision = this.revision;
		this.exportButton.enabled = false;
		try {
			const capture = this.trace;
			const payloads: Record<string, unknown> = { ...capture.diagnostics?.payloads };
			let incomplete = false;
			for (const record of capture.diagnostics?.events ?? []) {
				const payload = diagnosticPayload(record);
				if (!payload || payload.status !== 'saved' || Object.hasOwn(payloads, payload.payloadId)) { continue; }
				if (!this.sessionId || !capture.diagnostics?.captureId) { incomplete = true; continue; }
				try { payloads[payload.payloadId] = await this.chat.readTracePayload(this.sessionId, capture.diagnostics.captureId, payload.payloadId); }
				catch { incomplete = true; }
				if (revision !== this.revision || this.isDisposed) { return; }
			}
			const graph = capture.graph ?? (this.sessionId ? await this.chat.readTraceGraph(this.sessionId) : undefined);
			if (revision !== this.revision || this.isDisposed) { return; }
			const artifact = { ...capture, graph, diagnostics: capture.diagnostics && { ...capture.diagnostics, payloads, recordingStatus: incomplete ? 'incomplete' : capture.diagnostics.recordingStatus } };
			const serialized = JSON.stringify(artifact, null, 2);
			const blob = new Blob([serialized], { type: 'application/json' });
			if (blob.size > 64 * 1024 * 1024) { throw new Error(localize('agentTrace.fileSize', 'Trace files must be smaller than 64 MiB.')); }
			triggerDownload(blob, 'session.agent-trace.json', this.domNode.ownerDocument);
		} catch (error) { if (revision === this.revision && !this.isDisposed) { this.statusDomNode.textContent = localize('agentTrace.failed', 'Could not load trace: {0}', String(error)); } }
		finally { if (revision === this.revision && !this.isDisposed) { this.exportButton.enabled = !!this.trace; } }
	}

	public getAccessibleContent(): string {
		const timeline = [...this.listDomNode.querySelectorAll<HTMLElement>('.ash-agent-trace-thread, .ash-agent-trace-turn, .ash-agent-trace-event')]
			.filter(node => !node.closest('[hidden]'))
			.map(node => node.classList.contains('ash-agent-trace-event') ? node.textContent : node.firstElementChild?.textContent)
			.join('\n');
		return `${this.statusDomNode.textContent}\n${this.summaryDomNode.textContent}\n${timeline}\n${this.relationsDomNode.textContent}\n${this.detailsDomNode.textContent}`;
	}
	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.isShown = visible;
		if (visible) { this.requestRefresh(); }
		else {
			this.revision++;
			this.refreshScheduler.cancel();
			this.diagnosticPoll.cancel();
			this.releaseSubscriptions();
			this.loading = false;
			this.dirty = false;
			if (this.trace && this.sessionId) { this.statusDomNode.textContent = localize('agentTrace.paused', 'Paused · show the editor to follow new events'); }
		}
	}
	public override layout(dimension: IDimension): void { this.domNode.style.width = `${dimension.width}px`; this.domNode.style.height = `${dimension.height}px`; }
	public override focus(): void { (this.selected && this.rows.get(this.selected) || this.filter.inputElement).focus(); }
	public override getControl(): IEditorControl | undefined { return undefined; }
}

function eventIsError(record: AgentTraceEvent): boolean {
	const event = record.event;
	return event.type === 'modelAttemptFailed' || event.type === 'modelAttemptAbandoned' || event.type === 'turnFailed' || (event.type === 'turnInterrupted' && isRecord(event.error)) || (isRecord(event.item) && event.item.isError === true) || (isRecord(event.record) && event.record.outcome === 'failed');
}

function eventLabel(record: AgentTraceEvent): string {
	const event = record.event;
	const item = isRecord(event.item) ? event.item : undefined;
	const invocation = isRecord(event.record) ? event.record : undefined;
	let detail: string;
	switch (item?.type ?? event.type) {
		case 'modelAttemptStarted': detail = localize('agentTrace.attemptStarted', 'Model attempt started · {0}', String(event.attemptId)); break;
		case 'modelRequestPrepared': detail = localize('agentTrace.requestPrepared', 'Model request prepared · {0}', String(event.attemptId)); break;
		case 'modelAttemptCompleted': detail = localize('agentTrace.attemptCompleted', 'Model attempt completed · {0}', String(event.attemptId)); break;
		case 'modelAttemptFailed': detail = localize('agentTrace.attemptFailed', 'Model attempt failed · {0}', String(event.error)); break;
		case 'modelAttemptCancelled': detail = localize('agentTrace.attemptCancelled', 'Model attempt cancelled · {0}', String(event.reason)); break;
		case 'modelAttemptAbandoned': detail = localize('agentTrace.attemptAbandoned', 'Model attempt abandoned'); break;
		case 'threadCreated': detail = localize('agentTrace.created', 'Thread created'); break;
		case 'turnAccepted': detail = localize('agentTrace.accepted', 'Turn accepted · instructions and model selection'); break;
		case 'turnStarted': detail = localize('agentTrace.started', 'Turn started'); break;
		case 'turnCompleted': detail = localize('agentTrace.completed', 'Turn completed'); break;
		case 'turnFailed': detail = localize('agentTrace.turnFailed', 'Turn failed'); break;
		case 'turnCancelling': detail = localize('agentTrace.cancelling', 'Cancelling Turn'); break;
		case 'turnInterrupted': detail = localize('agentTrace.interrupted', 'Turn interrupted'); break;
		case 'userMessage': detail = localize('agentTrace.input', 'User input · {0}', String(item?.text ?? '').slice(0, 100)); break;
		case 'agentMessage': detail = localize('agentTrace.output', 'Agent output · {0}', String(item?.text ?? '').slice(0, 100)); break;
		case 'toolCall': detail = localize('agentTrace.toolCall', 'Tool call · {0}', String(item?.name ?? '')); break;
		case 'toolResult': detail = item?.isError ? localize('agentTrace.toolFailed', 'Tool failed · {0}', String(item?.toolCallId ?? '')) : localize('agentTrace.toolResult', 'Tool result · {0}', String(item?.toolCallId ?? '')); break;
		case 'toolExecutionStarted': detail = localize('agentTrace.toolStarted', 'Tool execution started'); break;
		case 'contextCheckpointCommitted': detail = localize('agentTrace.compacted', 'Context checkpoint committed'); break;
		case 'contextOverflowRecoveryCommitted': detail = localize('agentTrace.recovery', 'Context overflow recovery'); break;
		case 'modelInvocationRecorded': {
			const model = isRecord(invocation?.requestedModel) ? invocation.requestedModel : undefined;
			const usage = isRecord(invocation?.usage) ? invocation.usage : undefined;
			detail = localize('agentTrace.modelCall', 'Model call · {0} · {1}', String(invocation?.resolvedModel ?? model?.model ?? ''), String(invocation?.outcome ?? ''));
			if (typeof usage?.inputTokens === 'number' && typeof usage.outputTokens === 'number') {
				detail += localize('agentTrace.tokens', ' · {0} input / {1} output tokens', usage.inputTokens, usage.outputTokens);
			}
			break;
		}
		default: detail = typeof item?.type === 'string' ? item.type : event.type;
	}
	const duration = invocation && typeof invocation.startedAtUnixMs === 'number' && typeof invocation.completedAtUnixMs === 'number' ? ` · ${invocation.completedAtUnixMs - invocation.startedAtUnixMs} ms` : '';
	return `${record.sequence} · ${detail} · ${new Date(record.recordedAt).toISOString()}${duration}`;
}

function recordingLabel(trace: AgentTrace): string {
	switch (trace.diagnostics?.recordingStatus) {
		case 'recording': return localize('agentTrace.recording', 'Local diagnostic evidence enabled.');
		case 'incomplete': return localize('agentTrace.incomplete', 'Diagnostic evidence incomplete · {0} records omitted.', trace.diagnostics.droppedRecords);
		case 'unavailable': return localize('agentTrace.unavailable', 'Diagnostic storage unavailable; execution history remains readable.');
		case 'disabled': case undefined: return localize('agentTrace.disabled', 'Request evidence was not enabled. Set ASH_ROLLOUT_TRACE_ROOT before starting App Server.');
	}
}
function evidenceLabel(kind: string): string {
	switch (kind) {
		case 'coreRequest': return localize('agentTrace.coreRequest', 'Core semantic request · before attachment materialization');
		case 'materializedRequest': return localize('agentTrace.materializedRequest', 'Model service semantic request · after attachment materialization');
		case 'modelResponse': return localize('agentTrace.response', 'Model service response');
		case 'partialOutput': return localize('agentTrace.partialOutput', 'Partial output received before termination');
		default: return kind;
	}
}
function relationLabel(kind: string): string {
	switch (kind) {
		case 'childThread': return localize('agentTrace.childThread', 'Child Thread');
		case 'owns': return localize('agentTrace.owns', 'Owner');
		case 'executes': return localize('agentTrace.executes', 'Execution');
		case 'nestedTool': return localize('agentTrace.nestedTool', 'Nested tool');
		case 'result': return localize('agentTrace.result', 'Tool result');
		case 'deliversMessage': return localize('agentTrace.deliversMessage', 'Message delivery');
		case 'delegates': return localize('agentTrace.delegates', 'Delegation');
		case 'invokes': return localize('agentTrace.invokes', 'Runtime call');
		case 'requestsTool': return localize('agentTrace.requestsTool', 'Model requested tool');
		default: return kind;
	}
}
