import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, MutableDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { isRecord } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { Range } from '../../../../editor/common/core/range.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { eventLabel } from '../../../../workbench/contrib/chat/browser/chatDebug/agentTraceModel.js';
import { createAgentTraceResource, readAgentTraceLocation } from '../../../../workbench/contrib/chat/browser/chatDebug/chatDebugEditorInput.js';
import { IOutputService, OUTPUT_VIEW_ID, type IOutputChannel, type IOutputEntryInput } from '../../../../workbench/services/output/common/output.js';
import { IChatDebugService } from '../../../../workbench/contrib/chat/common/chatDebugService.js';
import type { AgentTraceDiagnosticEvent, AgentTraceEvent } from '../../../../workbench/contrib/chat/common/chatDebugEvents.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';

export interface IAgentTraceOutput extends IDisposable {
	showCurrent(): void;
}
export const IAgentTraceOutput = createServiceIdentifier<IAgentTraceOutput>('agentTraceOutput');

/** A bounded text reader of saved execution facts. Clearing Output never rewinds its read cursors. */
export class AgentTraceOutput extends Disposable implements IAgentTraceOutput {
	private readonly channel = this._register(new MutableDisposable<IOutputChannel>());
	private readonly channelListener = this._register(new MutableDisposable<IDisposable>());
	private readonly poll = this._register(
		new RunOnceScheduler(() => {
			void this.refresh();
		}, 1000),
	);
	private target: { readonly sessionId: string; readonly title: string } | undefined;
	private cursors: Readonly<Record<string, number>> = {};
	private diagnosticCursor = 0;
	private pending: object | undefined;
	private pendingRead: 'trace' | 'diagnostics' | undefined;
	private traceCaughtUp = false;
	private diagnosticsCaughtUp = false;
	private suppressTrace = false;
	private suppressDiagnostics = false;
	private failed = false;

	constructor(
		@ISessionsService private readonly sessions: ISessionsService,
		@IOutputService private readonly output: IOutputService,
		@IChatDebugService private readonly traces: IChatDebugService,
		@IViewsService private readonly views: IViewsService,
		@ILanguageFeaturesService languages: ILanguageFeaturesService,
		@IOpenerService openers: IOpenerService,
		@ICommandService commands: ICommandService,
	) {
		super();
		this.createChannel();
		this._register(
			autorun(reader => {
				const selected = sessions.getSelection(reader).activeSelection;
				// Once selected, the reader stays with that Session until Show Agent Output is invoked.
				if (!this.target && selected?.kind === 'session') this.select(selected.active.session);
			}),
		);
		this._register(output.onDidChangeActiveChannel(() => this.updatePolling()));
		this._register(
			views.onDidChangeViewVisibility(event => {
				if (event.id === OUTPUT_VIEW_ID) this.updatePolling();
			}),
		);
		this._register(
			languages.linkProvider.register(
				{ scheme: 'output' },
				{
					provideLinks: (request, signal) => {
						if (signal.aborted || request.resource?.toString() !== this.channel.value?.uri.toString()) return [];
						return request.snapshot
							.getText()
							.split('\n')
							.flatMap((line, index) =>
								[...line.matchAll(/ash-agent-trace:\/[^\s]+/g)].flatMap(match => {
									try {
										const uri = URI.parse(match[0]);
										if (!readAgentTraceLocation(uri)) return [];
										return [
											{
												range: new Range(index + 1, match.index + 1, index + 1, match.index + match[0].length + 1),
												target: uri.toString(),
												tooltip: localize('agentOutput.openTrace', 'Open Execution Trace'),
											},
										];
									} catch {
										return [];
									}
								}),
							);
					},
				},
			),
		);
		this._register(
			openers.registerOpener({
				open: async target => {
					const uri = typeof target === 'string' ? URI.parse(target) : target;
					if (uri.scheme !== 'ash-agent-trace') return false;
					const location = readAgentTraceLocation(uri);
					if (!location) return false;
					await commands.executeCommand('sessions.trace.open', location);
					return true;
				},
			}),
		);
		this.updatePolling();
	}

	showCurrent(): void {
		const selected = this.sessions.activeSelection;
		if (selected?.kind !== 'session') throw new Error(localize('agentOutput.selectSession', 'Select an Agent conversation to show its output.'));
		this.select(selected.active.session);
		this.channel.value!.show();
	}

	private createChannel(): void {
		this.channel.value = this.output.createChannel({
			id: 'agent',
			label: this.target ? localize('agentOutput.namedChannel', 'Agent · {0} ({1})', this.target.title, this.target.sessionId) : localize('agentOutput.channel', 'Agent'),
			kind: 'log',
			source: 'core',
		});
		this.channelListener.value = this.channel.value.onDidChange(change => {
			if (change.kind !== 'clear') return;
			// Skip an unfinished history snapshot after clear while still advancing its cursors.
			this.suppressTrace ||= this.pendingRead === 'trace' || !this.traceCaughtUp;
			this.suppressDiagnostics ||= this.pendingRead === 'diagnostics' || !this.diagnosticsCaughtUp;
		});
		if (!this.target)
			this.channel.value.appendLine({
				text: localize('agentOutput.selectSession', 'Select an Agent conversation to show its output.'),
			});
	}

	private select(target: { readonly sessionId: string; readonly title: string }): void {
		if (target.sessionId === this.target?.sessionId) return;
		const selected = this.output.activeChannel === this.channel.value;
		this.poll.cancel();
		this.pending = undefined;
		this.target = { sessionId: target.sessionId, title: target.title };
		this.cursors = {};
		this.diagnosticCursor = 0;
		this.traceCaughtUp = this.diagnosticsCaughtUp = false;
		this.suppressTrace = this.suppressDiagnostics = false;
		this.pendingRead = undefined;
		this.failed = false;
		this.channel.clear();
		this.createChannel();
		this.channel.value!.appendLine({
			text: localize('agentOutput.context', 'Session: {0} ({1})', target.title, target.sessionId) + '\n' + createAgentTraceResource(target.sessionId).toString(),
		});
		if (selected) this.output.selectChannel('agent');
		this.updatePolling();
	}

	private get reading(): boolean {
		return !this.isDisposed && !!this.target && this.output.activeChannel === this.channel.value && this.views.isViewVisible(OUTPUT_VIEW_ID);
	}

	private updatePolling(): void {
		if (this.reading) {
			if (!this.pending) this.poll.schedule(0);
		} else {
			this.poll.cancel();
			this.pending = undefined;
			this.pendingRead = undefined;
		}
	}

	private async refresh(): Promise<void> {
		if (!this.reading || this.pending) return;
		const operation = {};
		this.pending = operation;
		const current = (): boolean => this.pending === operation && this.reading;
		const sessionId = this.target!.sessionId;
		let more = false;
		try {
			this.pendingRead = 'trace';
			const page = await this.traces.readTrace(sessionId, this.cursors);
			if (!current()) return;
			for (const thread of page.trace.threads) {
				for (const record of thread.events) {
					if (this.suppressTrace || record.sequence <= (this.cursors[thread.threadId] ?? 0)) continue;
					const summary = outputSummary(sessionId, record);
					if (summary) this.channel.value!.appendLine(summary);
				}
			}
			this.cursors = page.cursors;
			this.traceCaughtUp = !page.hasMore;
			if (this.traceCaughtUp) this.suppressTrace = false;
			more = page.hasMore;
			this.pendingRead = 'diagnostics';
			const diagnostics = await this.traces.readTraceDiagnostics(sessionId, this.diagnosticCursor);
			if (!current()) return;
			for (const record of diagnostics.diagnostics.events) {
				if (this.suppressDiagnostics || record.sequence <= this.diagnosticCursor) continue;
				const summary = outputSummary(sessionId, diagnosticRecord(record));
				if (summary) this.channel.value!.appendLine(summary);
			}
			this.diagnosticCursor = diagnostics.cursor;
			this.diagnosticsCaughtUp = !diagnostics.hasMore;
			if (this.diagnosticsCaughtUp) this.suppressDiagnostics = false;
			more ||= diagnostics.hasMore;
			this.failed = false;
		} catch (error) {
			if (current() && !this.failed) {
				this.channel.value!.appendLine({
					severity: 'error',
					text: localize(
						'agentOutput.readFailed',
						'Could not read Agent output: {0}',
						String(error)
							.replace(/[\r\n]+/g, ' ')
							.slice(0, 500),
					),
				});
				this.failed = true;
			}
		} finally {
			if (this.pending === operation) {
				this.pending = undefined;
				this.pendingRead = undefined;
				if (this.reading) this.poll.schedule(this.failed ? 5000 : more ? 0 : 1000);
			}
		}
	}
}

function diagnosticRecord(record: AgentTraceDiagnosticEvent): AgentTraceEvent {
	return { ...record, event: { ...record.event, threadId: record.threadId, turnId: record.turnId } };
}

function outputSummary(sessionId: string, record: AgentTraceEvent): IOutputEntryInput | undefined {
	const event = record.event;
	const item = isRecord(event.item) ? event.item : undefined;
	const tool = event.type === 'toolExecutionStarted' || (event.type === 'itemCompleted' && (item?.type === 'toolCall' || item?.type === 'toolResult'));
	const model = [
		'modelAttemptStarted',
		'modelAttemptCompleted',
		'modelAttemptFailed',
		'modelAttemptCancelled',
		'modelAttemptAbandoned',
		'modelInvocationRecorded',
		'modelResponseEvaluated',
	].includes(event.type);
	const agent = [
		'threadCreated',
		'turnAccepted',
		'turnStarted',
		'turnCompleted',
		'turnFailed',
		'turnCancelling',
		'turnInterrupted',
		'delegationRequested',
		'delegationStarted',
		'delegationResultProduced',
		'delegationResultReceived',
		'agentJoinRequested',
		'agentJoinSatisfied',
		'contextOverflowRecoveryCommitted',
		'contextCheckpointCommitted',
	].includes(event.type);
	if (!tool && !model && !agent) return undefined;
	const failed =
		event.type === 'turnFailed' ||
		event.type === 'modelAttemptFailed' ||
		event.type === 'modelAttemptAbandoned' ||
		item?.isError === true ||
		(isRecord(event.record) && event.record.outcome === 'failed') ||
		(isRecord(event.decision) && event.decision.action === 'fail');
	const cancelled = event.type === 'turnInterrupted' || event.type === 'turnCancelling' || event.type === 'modelAttemptCancelled';
	const location = createAgentTraceResource({
		sessionId,
		threadId: event.threadId,
		...(typeof event.turnId === 'string' ? { turnId: event.turnId } : {}),
		eventId: record.eventId,
	});
	return {
		timestamp: record.recordedAt,
		severity: failed ? 'error' : cancelled ? 'warning' : 'information',
		category: tool ? 'tool' : model ? 'model' : 'agent',
		text: `${event.threadId} · ${eventLabel(record)
			.replace(/[\r\n\t]+/g, ' ')
			.slice(0, 500)}\n${location.toString()}`,
	};
}
