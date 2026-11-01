import { Button } from '../../../../../base/browser/ui/button/button.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import type { AgentSession } from '../../../../../platform/agentHost/common/agent.js';
import { Emitter } from '../../../../../base/common/event.js';
import { h } from '../../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { traceOverview, type AgentTrace, type AgentTraceMetric } from '../../common/chatDebugEvents.js';
import { recordingLabel } from './agentTraceModel.js';

/** Renders the domain's capture-scoped summary without reconstructing a ledger in the UI. */
export class ChatDebugOverviewView extends Disposable {
	readonly container: HTMLDetailsElement;
	private readonly body: HTMLDivElement;
	private readonly session: HTMLDivElement;
	private readonly revealButton: Button;
	private readonly reveal = this._register(new Emitter<{ sessionId: string; threadId: string; }>());
	readonly onDidRevealSession = this.reveal.event;
	private currentSession: AgentSession | undefined;
	private sessionError: string | undefined;
	private destination: { sessionId: string; threadId: string; } | undefined;
	private capture: AgentTrace | undefined;
	private narrow = false;
	private content = '';

	constructor(parent: HTMLElement) {
		super();
		this.container = h(parent.ownerDocument, 'details', { className: 'ash-chat-debug-overview' });
		this.container.open = true;
		this.container.hidden = true;
		this.container.setAttribute('aria-label', localize('chatDebug.captureOverview', 'Capture overview'));
		this.container.append(h(parent.ownerDocument, 'summary', localize('chatDebug.captureOverview', 'Capture overview')));
		this.session = h(parent.ownerDocument, 'div', { className: 'ash-chat-debug-session-details' });
		this.revealButton = this._register(new Button(this.container, { ...defaultButtonStyles, presentation: 'secondary', label: localize('chatDebug.revealSession', 'Reveal Chat Session'), onClick: () => { if (this.destination) { this.reveal.fire(this.destination); } } }));
		this.revealButton.domNode.hidden = true;
		this.container.append(this.session);
		this.body = h(parent.ownerDocument, 'div');
		this.container.append(this.body);
		parent.append(this.container);
		this._register(toDisposable(() => this.container.remove()));
	}

	render(trace: AgentTrace | undefined): void {
		if (trace === this.capture) { return; }
		this.capture = trace;
		this.container.hidden = !trace;
		this.content = '';
		this.body.replaceChildren();
		if (!trace) { return; }
		const summary = traceOverview(trace);
		const document = this.container.ownerDocument;
		const metrics = h(document, 'dl', { className: 'ash-chat-debug-metrics' });
		const add = (label: string, value: string | number | undefined, coverage?: AgentTraceMetric): void => {
			const cell = h(document, 'div');
			const formatted = value === undefined || value === null ? localize('chatDebug.unknown', 'Unknown') : BigInt(value).toLocaleString();
			cell.append(h(document, 'dt', label), h(document, 'dd', formatted));
			if (coverage) {
				cell.append(h(document, 'dd', { className: 'ash-chat-debug-metric-coverage' }, localize('chatDebug.metricCoverage', 'Reported by {0}/{1} included calls', coverage.reportedCalls, coverage.reportedCalls + coverage.missingCalls)));
			}
			metrics.append(cell);
		};
		add(localize('chatDebug.modelCalls', 'Committed model calls'), summary?.modelCalls);
		add(localize('chatDebug.toolCalls', 'Tool calls'), summary?.toolCalls);
		add(localize('chatDebug.failedCalls', 'Failed model calls'), summary?.failedModelCalls);
		add(localize('chatDebug.cancelledCalls', 'Cancelled model calls'), summary?.cancelledModelCalls);
		add(localize('chatDebug.inputTokens', 'Input tokens'), summary?.inputTokens.reported ?? undefined, summary?.inputTokens);
		add(localize('chatDebug.outputTokens', 'Output tokens'), summary?.outputTokens.reported ?? undefined, summary?.outputTokens);
		add(localize('chatDebug.cachedTokens', 'Cached input tokens'), summary?.cachedInputTokens.reported ?? undefined, summary?.cachedInputTokens);
		add(localize('chatDebug.totalTokens', 'Input + output tokens'), summary?.totalTokens.reported ?? undefined, summary?.totalTokens);
		const scope = h(document, 'p', localize('chatDebug.overviewScope', 'Loaded capture; display filters do not change metrics. Token values are reported subtotals from included committed calls. Missing reports stay unknown. Cached input is already part of input tokens.'));
		const evidence = h(document, 'p', recordingLabel(trace));
		if (!summary) {
			evidence.textContent += ' ' + localize('chatDebug.overviewUnavailable', 'No backend overview matches this capture. Older imports remain readable; metrics are unknown until a matching overview is available.');
		} else if (summary.excludedModelCalls) {
			evidence.textContent += ' ' + localize('chatDebug.excludedCalls', '{0} conflicting model call identities excluded from metrics.', summary.excludedModelCalls);
		}
		evidence.textContent += ' ' + localize('chatDebug.attemptScope', 'Attempt failures and missing accounting may leave additional usage unknown; these subtotals are not a complete measure of all execution.');
		this.body.append(metrics, scope, evidence);
		this.content = Array.from(this.container.querySelectorAll('summary, dt, dd, p'), node => node.textContent).join('\n');
	}

	setNarrow(narrow: boolean): void {
		if (narrow === this.narrow) { return; }
		this.narrow = narrow;
		this.container.open = !narrow;
	}

	setSession(session: AgentSession | undefined, error?: string): void {
		if (session === this.currentSession && error === this.sessionError) { return; }
		this.currentSession = session; this.sessionError = error;
		this.session.replaceChildren();
		this.destination = undefined; this.revealButton.domNode.hidden = true;
		if (error) { this.session.append(h(this.session.ownerDocument, 'p', error)); return; }
		if (!session) { return; }
		const document = this.session.ownerDocument;
		const title = h(document, 'h3', session.title);
		const labels = {
			idle: localize('chatDebug.sessionIdle', 'Idle'), needsInput: localize('chatDebug.sessionNeedsInput', 'Needs Input'),
			working: localize('chatDebug.sessionWorking', 'Working'), readyForReview: localize('chatDebug.sessionReview', 'Ready for Review'),
			completed: localize('chatDebug.sessionCompleted', 'Completed'), failed: localize('chatDebug.sessionFailed', 'Failed'), stopped: localize('chatDebug.sessionStopped', 'Stopped'),
		};
		this.session.append(title, h(document, 'p', localize('chatDebug.currentSessionState', 'Current backend session · {0} · {1}', session.sessionId, labels[session.manager.status])));
		if (session.executionTarget) {
			const target = session.executionTarget;
			this.session.append(h(document, 'p', target.type === 'ssh' ? `${target.host}:${target.root}` : target.root));
		}
		const root = session.threads.find(thread => !thread.parentThreadId) ?? session.threads[0];
		if (root) {
			this.destination = { sessionId: session.sessionId, threadId: root.threadId };
			this.revealButton.domNode.hidden = false;
			for (const [value, label] of [[root.createdAtUnixMs, localize('chatDebug.sessionCreated', 'Created')], [root.lastActivityAtUnixMs, localize('chatDebug.sessionActivity', 'Last Activity')]] as const) {
				if (value !== undefined) { this.session.append(h(document, 'p', localize('chatDebug.sessionDate', '{0}: {1}', label, new Date(value).toLocaleString()))); }
			}
		}
	}

	getAccessibleContent(): string { return [this.session.textContent, this.content].filter(Boolean).join('\n'); }
}
