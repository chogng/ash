import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../../base/common/event.js';
import { observableValue, type IReader } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import { createLanguageFeatureRequest } from '../../../../../editor/common/languages.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { createCodeEditorServices } from '../../../../../editor/test/browser/testCodeEditor.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IOutputService, OUTPUT_VIEW_ID } from '../../../../../workbench/services/output/common/output.js';
import { IChatDebugService } from '../../../../../workbench/contrib/chat/common/chatDebugService.js';
import type { AgentTraceDiagnosticEvent, AgentTraceEvent, AgentTracePage } from '../../../../../workbench/contrib/chat/common/chatDebugEvents.js';
import { IViewsService } from '../../../../../workbench/services/views/common/viewsService.js';
import { workbenchInstantiationService } from '../../../../../workbench/test/browser/workbenchTestServices.js';
import { ISessionsService, type SessionsViewSelection } from '../../../../services/sessions/browser/sessionsService.js';
import { AgentTraceOutput } from '../../browser/agentTraceOutput.js';

function selection(sessionId: string): SessionsViewSelection {
	return {
		kind: 'session',
		active: { session: { sessionId, title: sessionId }, threadId: 'root' },
	} as SessionsViewSelection;
}

function record(sequence: number, type: string, extra: Record<string, unknown> = {}): AgentTraceEvent {
	return {
		eventId: `event-${sequence}`,
		sequence,
		recordedAt: sequence,
		event: { type, threadId: 'root', turnId: 'turn', ...extra },
	};
}

function setup(resources: DisposableStore) {
	const parent = workbenchInstantiationService(resources);
	const owner = resources.add(parent.createChild());
	const active = observableValue<SessionsViewSelection | undefined>('selection', selection('first'));
	const visibility = resources.add(new Emitter<{ id: string; visible: boolean }>());
	let visible = true;
	const commands: { id: string; args: readonly unknown[] }[] = [];
	resources.add(
		CommandsRegistry.register('sessions.trace.open', (_accessor, ...args) => {
			commands.push({ id: 'sessions.trace.open', args });
		}),
	);
	owner.registerInstance(ISessionsService, {
		getSelection: (reader?: IReader) => ({ activeSelection: active.read(reader), visibleSelections: [] }),
		get activeSelection() {
			return active.get();
		},
	} as unknown as ISessionsService);
	owner.registerInstance(IViewsService, {
		onDidChangeViewVisibility: visibility.event,
		isViewVisible: () => visible,
	} as unknown as IViewsService);
	const events = [
		record(1, 'turnStarted'),
		record(2, 'itemCompleted', { item: { type: 'agentMessage', text: 'message body stays in Trace' } }),
		record(3, 'itemCompleted', {
			item: { type: 'toolCall', name: 'shell-command', arguments: 'private tool arguments' },
		}),
		record(4, 'itemCompleted', {
			item: { type: 'toolResult', toolCallId: 'call', text: 'private tool result', isError: true },
		}),
		record(5, 'turnCompleted'),
	];
	const diagnostics: AgentTraceDiagnosticEvent[] = [
		{
			eventId: 'attempt',
			sequence: 1,
			recordedAt: 1,
			threadId: 'root',
			turnId: 'turn',
			event: { type: 'modelAttemptStarted', attemptId: 'attempt-1' },
		},
	];
	const reads: { sessionId: string; after: Readonly<Record<string, number>> }[] = [];
	const diagnosticReads: number[] = [];
	let readOverride: ((sessionId: string) => Promise<AgentTracePage>) | undefined;
	owner.registerInstance(IChatDebugService, {
		readTrace: async (sessionId, after) => {
			reads.push({ sessionId, after: { ...after } });
			return readOverride
				? readOverride(sessionId)
				: {
						trace: {
							formatVersion: 3,
							sessionId,
							historyPrefixes: [],
							threads: [
								{
									threadId: 'root',
									events: events.filter(record => record.sequence > (after.root ?? 0)),
								},
							],
						},
						cursors: { root: events.at(-1)?.sequence ?? 0 },
						hasMore: false,
					};
		},
		readTraceDiagnostics: async (_sessionId, after) => {
			diagnosticReads.push(after);
			return {
				diagnostics: {
					formatVersion: 2,
					captureId: 'capture',
					recordingStatus: 'recording',
					droppedRecords: 0,
					pendingRecords: 0,
					events: diagnostics.filter(record => record.sequence > after),
				},
				cursor: diagnostics.at(-1)?.sequence ?? 0,
				hasMore: false,
			};
		},
		readTracePayload: async () => {
			throw new Error('Output must not acquire request or response bodies');
		},
		readTraceGraph: async () => {
			throw new Error('Output must not acquire the execution graph');
		},
	});
	const services = createCodeEditorServices(resources, owner);
	const reader = resources.add(services.createInstance(AgentTraceOutput));
	const output = services.get(IOutputService);
	return {
		reader,
		output,
		services,
		active,
		events,
		diagnostics,
		reads,
		diagnosticReads,
		commands,
		setVisible(value: boolean) {
			visible = value;
			visibility.fire({ id: OUTPUT_VIEW_ID, visible });
		},
		overrideRead(read: typeof readOverride) {
			readOverride = read;
		},
	};
}

async function waitFor(ready: () => boolean): Promise<void> {
	const deadline = Date.now() + 2000;
	while (!ready()) {
		assert.ok(Date.now() < deadline, 'Agent output did not reach the expected state');
		await new Promise<void>(resolve => setTimeout(resolve, 0));
	}
}

test('Agent Output reads bounded execution summaries and opens exact saved events without loading bodies', async () => {
	using resources = new DisposableStore();
	const fixture = setup(resources);
	await waitFor(() => fixture.output.getChannel('agent')!.getText().includes('Model attempt started'));
	const channel = fixture.output.getChannel('agent')!;
	assert.equal(channel.label, 'Agent · first (first)');
	assert.deepEqual(
		channel.entries.map(entry => [entry.category, entry.severity]),
		[
			[undefined, 'log'],
			['agent', 'information'],
			['tool', 'information'],
			['tool', 'error'],
			['agent', 'information'],
			['model', 'information'],
		],
	);
	assert.doesNotMatch(channel.getText(), /private tool|message body/);
	const model = await channel.loadModel();
	assert.ok(model instanceof TextModel);
	const signal = new AbortController().signal;
	const request = { ...createLanguageFeatureRequest(model, model.getLanguageId(), signal), resource: channel.uri };
	const providers = fixture.services.get(ILanguageFeaturesService).linkProvider.all(model);
	const links = (await Promise.all(providers.map(provider => provider.provideLinks(request, signal)))).flat();
	const target = links.find(link => link.target.includes('eventId=event-4'));
	assert.ok(target);
	await fixture.services.get(IOpenerService).open(URI.parse(target.target), { fromUserGesture: true });
	assert.deepEqual(fixture.commands, [
		{
			id: 'sessions.trace.open',
			args: [{ sessionId: 'first', threadId: 'root', turnId: 'turn', eventId: 'event-4' }],
		},
	]);
});

test('clearing Agent Output preserves durable facts and read positions while newer events keep arriving', async () => {
	using resources = new DisposableStore();
	const fixture = setup(resources);
	await waitFor(() => fixture.diagnosticReads.length === 1 && fixture.output.getChannel('agent')!.getText().includes('Model attempt started'));
	const channel = fixture.output.getChannel('agent')!;
	channel.clear();
	fixture.events.push(record(6, 'turnStarted'));
	fixture.setVisible(false);
	fixture.setVisible(true);
	await waitFor(() => channel.entries.length === 1);
	assert.deepEqual(
		channel.entries.map(entry => [entry.category, entry.severity]),
		[['agent', 'information']],
	);
	assert.deepEqual(fixture.reads.at(-1), { sessionId: 'first', after: { root: 5 } });
	assert.equal(fixture.diagnosticReads.at(-1), 1);
	assert.equal(fixture.events.length, 6);
	fixture.reader.dispose();
	assert.equal(fixture.output.getChannel('agent'), undefined);
});

test('Agent Output stays on its selected Session and rejects reads finishing after an explicit switch or hide', async () => {
	using resources = new DisposableStore();
	const fixture = setup(resources);
	await waitFor(() => fixture.diagnosticReads.length === 1);
	fixture.active.set(selection('second'), undefined);
	assert.equal(fixture.output.getChannel('agent')!.label, 'Agent · first (first)');
	let finish!: (page: AgentTracePage) => void;
	fixture.overrideRead(
		() =>
			new Promise(resolve => {
				finish = resolve;
			}),
	);
	fixture.setVisible(false);
	fixture.setVisible(true);
	await waitFor(() => !!finish);
	fixture.setVisible(false);
	fixture.reader.showCurrent();
	const channel = fixture.output.getChannel('agent')!;
	assert.equal(channel.label, 'Agent · second (second)');
	finish({
		trace: {
			formatVersion: 3,
			sessionId: 'first',
			historyPrefixes: [],
			threads: [{ threadId: 'root', events: [record(100, 'turnFailed')] }],
		},
		cursors: { root: 100 },
		hasMore: false,
	});
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.doesNotMatch(channel.getText(), /Turn failed/);
	const reads = fixture.reads.length;
	fixture.reader.dispose();
	fixture.setVisible(true);
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(fixture.reads.length, reads);
});

test('clear during an outstanding history read consumes its cursor without restoring the cleared snapshot', async () => {
	using resources = new DisposableStore();
	const fixture = setup(resources);
	let finish!: (page: AgentTracePage) => void;
	fixture.overrideRead(
		() =>
			new Promise(resolve => {
				finish = resolve;
			}),
	);
	await waitFor(() => !!finish);
	const channel = fixture.output.getChannel('agent')!;
	channel.clear();
	finish({
		trace: {
			formatVersion: 3,
			sessionId: 'first',
			historyPrefixes: [],
			threads: [{ threadId: 'root', events: fixture.events }],
		},
		cursors: { root: 5 },
		hasMore: false,
	});
	await waitFor(() => fixture.diagnosticReads.length === 1);
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(channel.getText(), '');
	fixture.overrideRead(undefined);
	fixture.events.push(record(6, 'turnCompleted'));
	fixture.setVisible(false);
	fixture.setVisible(true);
	await waitFor(() => channel.entries.length > 0);
	assert.equal(channel.entries.length, 1);
	assert.match(channel.getText(), /eventId=event-6/);
});
