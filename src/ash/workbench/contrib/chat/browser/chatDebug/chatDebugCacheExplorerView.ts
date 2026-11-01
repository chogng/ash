import { IDiffService } from '../../../../services/diff/common/diffService.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import type { DiffEditorWidget } from '../../../../../editor/browser/widget/diffEditor/diffEditorWidget.js';
import { h } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { ScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { isRecord } from '../../../../../base/common/types.js';
import { localize } from '../../../../../nls.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { traceOverview, diagnosticPayload, type AgentTrace, type AgentTraceDiagnosticEvent } from '../../common/chatDebugEvents.js';
import { IChatDebugService } from '../../common/chatDebugService.js';

/** Compares saved semantic requests within one Thread and evidence boundary.
 * Differences describe recorded input; they cannot establish a provider's token-cache decisions. */
export class ChatDebugCacheExplorerView extends Disposable {
	readonly container: HTMLElement;
	private readonly navigate = this._register(new Emitter<AgentTraceDiagnosticEvent>());
	readonly onDidSelectEvent = this.navigate.event;
	private readonly rows = this._register(new DisposableStore());
	private readonly diffResources = this._register(new MutableDisposable<DisposableStore>());
	private diffOperation: object | undefined;
	private diffEditor: DiffEditorWidget | undefined;
	private diffHost: HTMLElement | undefined;
	private readonly details = this._register(new DisposableStore());
	private pairKey: string | undefined;
	private readonly list: HTMLElement;
	private readonly content: HTMLElement;
	private readonly notice: HTMLElement;
	private readonly metrics: HTMLElement;
	private readonly scroll: ScrollableElement;
	private readonly boundaries = new Map<string, Button>();
	private trace: AgentTrace | undefined;
	private selected: string | undefined;
	private boundary = 'coreRequest';
	private revision = 0;
	private limit = 100;
	private readonly more: Button;

	constructor(parent: HTMLElement, @IChatDebugService private readonly service: IChatDebugService, @IInstantiationService private readonly instantiation: IInstantiationService, @IDiffService private readonly diffs: IDiffService) {
		super();
		const document = parent.ownerDocument;
		this.container = h(document, 'section', { className: 'ash-chat-debug-cache' });
		this.container.hidden = true;
		this.container.setAttribute('aria-label', localize('chatDebug.cacheExplorer', 'Cache Explorer'));
		const toolbar = h(document, 'div', { className: 'ash-chat-debug-view-navigation' });
		for (const [kind, label] of [['coreRequest', localize('chatDebug.coreRequests', 'Core Requests')], ['materializedRequest', localize('chatDebug.materializedRequests', 'Materialized Requests')]]) {
			const button = this._register(new Button(toolbar, {
				...defaultButtonStyles, presentation: 'secondary', label,
				onClick: () => { this.boundary = kind; this.selected = undefined; this.render(); },
			}));
			this.boundaries.set(kind, button);
		}
		this.notice = h(document, 'p', { className: 'ash-chat-debug-notice' });
		this.notice.setAttribute('aria-live', 'polite');
		this.metrics = h(document, 'p', { className: 'ash-chat-debug-notice' });
		this.list = h(document, 'div', { className: 'ash-chat-debug-cache-requests' });
		this.content = h(document, 'div', { className: 'ash-chat-debug-cache-comparison' });
		const body = h(document, 'div');
		body.append(this.list, this.content);
		this.scroll = this._register(new ScrollableElement(this.container, { direction: 'vertical', tabIndex: 0, ariaLabel: localize('chatDebug.requestComparison', 'Request Comparison') }));
		this.scroll.setContent(body);
		this.scroll.element.classList.add('ash-chat-debug-cache-host');
		this.more = this._register(new Button(this.container, {
			...defaultButtonStyles, presentation: 'secondary', label: localize('chatDebug.moreRequests', 'Show More Requests'),
			onClick: () => { this.limit += 100; this.render(); },
		}));
		this.container.prepend(toolbar, this.notice, this.metrics, this.scroll.element);
		parent.append(this.container);
		this._register(toDisposable(() => this.container.remove()));
	}

	show(trace: AgentTrace, sessionId: string | undefined): void {
		if (!this.container.hidden && this.trace === trace) { return; }
		this.container.hidden = false;
		this.trace = trace;
		this.liveSessionId = sessionId;
		this.render();
	}
	hide(): void {
		this.revision++;
		this.clearDiff();
		this.pairKey = undefined;
		this.container.hidden = true;
	}
	clear(): void {
		this.hide();
		this.trace = undefined;
		this.metrics.textContent = "";
		this.liveSessionId = undefined;
		this.boundary = 'coreRequest';
		this.selected = undefined;
		this.limit = 100;
		this.rows.clear();
		this.details.clear();
		this.list.replaceChildren();
		this.content.replaceChildren();
	}
	layout(width: number): void {
		this.container.classList.toggle('narrow', width < 640);
		this.diffEditor?.layout({ width: Math.max(0, width - 24), height: 360 });
		this.scroll.layout();
	}
	getControl(): DiffEditorWidget | undefined { return this.diffEditor; }
	focus(): void { this.boundaries.get(this.boundary)?.focus(); }
	getAccessibleContent(): string { return this.container.textContent ?? ''; }

	private render(): void {
		this.rows.clear(); this.list.replaceChildren();
		const overview = this.trace && traceOverview(this.trace);
		this.metrics.textContent = localize('chatDebug.cacheReported', 'Reported cache usage in this Session capture: {0} cached input / {1} input tokens. These are backend subtotals; missing reports remain unknown.', overview?.cachedInputTokens.reported ?? localize('chatDebug.unknown', 'Unknown'), overview?.inputTokens.reported ?? localize('chatDebug.unknown', 'Unknown'));
		for (const [kind, button] of this.boundaries) { button.checked = kind === this.boundary; }
		const requests = (this.trace?.diagnostics?.events ?? []).filter(record => diagnosticPayload(record)?.kind === this.boundary);
		let selected = requests.find(record => record.eventId === this.selected);
		selected ??= requests.at(-1);
		this.selected = selected?.eventId;
		// Keep the selected request reachable even while the initial rail is bounded.
		const visible = requests.slice(-this.limit);
		if (selected && !visible.includes(selected)) { visible.unshift(selected); }
		for (const record of visible) {
			const button = this.rows.add(new Button(this.list, {
				...defaultButtonStyles, presentation: 'secondary',
				label: localize('chatDebug.requestLabel', '{0} · {1} · {2}', record.threadId, record.turnId ?? '', String(record.event.attemptId ?? record.eventId)),
				onClick: () => { this.selected = record.eventId; this.render(); },
			}));
			button.checked = record === selected;
			button.domNode.dataset.requestEvent = record.eventId;
		}
		this.more.domNode.hidden = visible.length >= requests.length;
		this.notice.textContent = localize('chatDebug.cacheEvidence', 'Compare saved semantic requests. Core and materialized requests are separate. A changed input does not prove a cache miss; provider tokenization and cache state are unknown.');
		if (!selected) {
			this.revision++; this.pairKey = undefined; this.details.clear(); this.content.replaceChildren();
			this.content.append(h(this.content.ownerDocument, 'p', localize('chatDebug.noRequests', 'No requests were recorded for this boundary. Enable request evidence for future calls, or import a capture containing saved requests.')));
		} else {
			const previous = requests.slice(0, requests.indexOf(selected)).reverse().find(record => record.threadId === selected.threadId);
			const key = JSON.stringify([this.trace?.sessionId, this.trace?.diagnostics?.captureId, selected.eventId, previous?.eventId]);
			if (key !== this.pairKey) {
				this.pairKey = key;
				this.clearDiff();
				this.details.clear(); this.content.replaceChildren();
				void this.compare(selected, previous, ++this.revision);
			}
		}
		this.scroll.layout();
	}

	private async readBody(record: AgentTraceDiagnosticEvent, trace: AgentTrace): Promise<unknown> {
		const payload = diagnosticPayload(record)!;
		if (payload.status !== 'saved') { throw new Error(localize('agentTrace.payloadOmitted', 'Payload omitted by the recording limit.')); }
		if (trace.diagnostics?.payloads && Object.hasOwn(trace.diagnostics.payloads, payload.payloadId)) { return trace.diagnostics.payloads[payload.payloadId]; }
		if (!trace.diagnostics?.captureId) { throw new Error(localize('agentTrace.missingEvidence', 'This capture does not include the selected payload.')); }
		// Imports have no authority to read live Sessions, even if their capture ID matches.
		if (!this.liveSessionId) { throw new Error(localize('agentTrace.missingEvidence', 'This capture does not include the selected payload.')); }
		return this.service.readTracePayload(this.liveSessionId, trace.diagnostics.captureId, payload.payloadId);
	}

	private clearDiff(): void {
		this.diffOperation = undefined; this.diffEditor = undefined; this.diffResources.clear(); this.diffHost?.remove(); this.diffHost = undefined;
	}

	private async showDiff(before: string, current: string, pair: HTMLElement, revision: number): Promise<void> {
		if (this.diffEditor) { this.diffEditor.modifiedEditor.focus(); return; }
		if (this.diffOperation) { return; }
		const operation = {}; this.diffOperation = operation;
		const resources = new DisposableStore();
		try {
			const [{ TextModel }, { DiffModel }, { DiffEditorWidget }] = await Promise.all([
				import('../../../../../editor/common/model/textModel.js'), import('../../../../../editor/common/diff/diffModel.js'),
				import('../../../../../editor/browser/widget/diffEditor/diffEditorWidget.js'),
			]);
			if (this.isDisposed || revision !== this.revision || this.container.hidden) { resources.dispose(); return; }
			const original = resources.add(new TextModel(before, { languageId: 'json', isForSimpleWidget: true }));
			const modified = resources.add(new TextModel(current, { languageId: 'json', isForSimpleWidget: true }));
			const provider = resources.add(this.diffs.createComputationService());
			const model = resources.add(new DiffModel({ original, modified, diffProvider: provider, diffOptions: { ignoreTrimWhitespace: false, maxComputationTimeMs: 3000, computeMoves: false } }));
			this.diffHost = h(this.content.ownerDocument, 'div', { className: 'ash-chat-debug-cache-diff' }); this.content.append(this.diffHost);
			this.diffEditor = resources.add(this.instantiation.createInstance(DiffEditorWidget, {
				container: this.diffHost, model, readOnly: true, renderMarginRevertIcon: false, wordWrap: 'on',
				originalAriaLabel: localize('chatDebug.previousRequest', 'Previous Request'), modifiedAriaLabel: localize('chatDebug.selectedRequest', 'Selected Request'),
			}));
			this.diffEditor.layout({ width: Math.max(0, this.container.clientWidth - 24), height: 360 });
			this.diffResources.value = resources;
			pair.hidden = true;
			this.diffEditor.modifiedEditor.focus(); this.scroll.layout();
		} catch (error) {
			resources.dispose(); this.clearDiff();
			if (revision === this.revision && !this.container.hidden && !this.isDisposed) { this.content.append(h(this.content.ownerDocument, 'p', localize('chatDebug.diffFailed', 'Could not open request comparison: {0}', String(error)))); }
		} finally { if (this.diffOperation === operation) { this.diffOperation = undefined; } }
	}

	private liveSessionId: string | undefined;

	private async compare(selected: AgentTraceDiagnosticEvent, previous: AgentTraceDiagnosticEvent | undefined, revision: number): Promise<void> {
		const trace = this.trace!;
		const document = this.content.ownerDocument;
		this.content.append(h(document, 'p', localize('chatDebug.loadingRequests', 'Loading selected request evidence…')));
		try {
			const [currentResult, beforeResult] = await Promise.allSettled([this.readBody(selected, trace), previous ? this.readBody(previous, trace) : undefined]);
			if (this.isDisposed || revision !== this.revision || this.container.hidden) { return; }
			if (currentResult.status === 'rejected') { throw currentResult.reason; }
			const current = currentResult.value;
			const before = beforeResult.status === 'fulfilled' ? beforeResult.value : undefined;
			this.content.replaceChildren();
			if (beforeResult.status === 'rejected') {
				this.content.append(h(document, 'p', localize('chatDebug.previousUnavailable', 'The earlier request is unavailable; the selected request is still shown.')));
			}
			const format = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => {
				if (!isRecord(item)) { return item; }
				return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
			}, 2) ?? '';
			const a = before === undefined ? undefined : format(before);
			const b = format(current);
			let summary: string;
			if (beforeResult.status === 'rejected') {
				summary = localize('chatDebug.comparisonUnavailable', 'A complete request comparison is unavailable.');
			} else if (a === undefined) {
				summary = localize('chatDebug.noPreviousRequest', 'No earlier request from this Thread and boundary is included in this capture.');
			} else if (a === b) {
				summary = localize('chatDebug.sameRequest', 'The saved requests are identical.');
			} else {
				summary = localize('chatDebug.changedRequest', 'The saved requests differ. Compare the recorded fields below.');
			}
			this.content.append(h(document, 'p', summary));
			const pair = h(document, 'div', { className: 'ash-chat-debug-request-pair' });
			const bodies: readonly [AgentTraceDiagnosticEvent | undefined, string, string | undefined][] = [
				[previous, localize('chatDebug.previousRequest', 'Previous Request'), a],
				[selected, localize('chatDebug.selectedRequest', 'Selected Request'), b],
			];
			for (const [record, label, text] of bodies) {
				const section = h(document, 'section');
				section.setAttribute('aria-label', label);
				section.append(h(document, 'h3', label));
				if (record) { section.append(h(document, 'p', localize('chatDebug.requestMetadata', '{0} · {1} bytes · {2}', new Date(record.recordedAt).toISOString(), diagnosticPayload(record)!.byteLength, String(record.event.attemptId ?? record.eventId)))); }
				section.append(h(document, 'pre', text ?? localize('chatDebug.unknown', 'Unknown')));
				pair.append(section);
			}
			this.content.append(pair);
			if (a !== undefined) {
				this.details.add(new Button(this.content, { ...defaultButtonStyles, presentation: 'secondary', label: localize('chatDebug.compareDiff', 'Compare in Diff Editor'), onClick: () => { void this.showDiff(a, b, pair, revision); } }));
			}
			this.details.add(new Button(this.content, {
				...defaultButtonStyles, presentation: 'secondary', label: localize('chatDebug.openRequestEvent', 'Show Request in Logs'),
				onClick: () => this.navigate.fire(selected),
			}));
		} catch (error) {
			if (revision === this.revision && !this.isDisposed && !this.container.hidden) {
				this.content.replaceChildren(h(document, 'p', localize('chatDebug.requestUnavailable', 'Request evidence is unavailable: {0}', String(error))));
				this.details.add(new Button(this.content, {
					...defaultButtonStyles,
					presentation: 'secondary',
					label: localize('agentTrace.refresh', 'Refresh'),
					onClick: () => { this.pairKey = undefined; this.render(); },
				}));
			}
		}
		if (revision === this.revision && !this.isDisposed) { this.scroll.layout(); }
	}
}
