import '../../../../../editor/test/browser/testEditorDom.js';
import '../../browser/accessibilitySignal.contribution.js';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { suite, test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAccessibilitySignalService } from '../../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../common/contributions.js';
import { IChatService, type ThreadUpdateEnvelope } from '../../../../services/chat/common/chatService.js';
import { ChatSpeechToTextState, IChatSpeechToTextService } from '../../../chat/browser/speechToText/chatSpeechToTextService.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { type ITextFileSaveEvent } from '../../../../services/textfile/common/textFileService.js';
import { IDebugService, type IDebugSession, type DebugSessionState } from '../../../../services/debug/common/debugService.js';
import { IMarkerService, MarkerService, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import type { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { ITerminalService, type ITerminalInstance, type ITerminalCommandStatusEvent } from '../../../terminal/browser/terminal.js';
import { ITaskService, type ITaskRun } from '../../../../services/tasks/common/taskService.js';

suite('Accessibility signal production contributions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function services(owner: DisposableStore): { services: InstantiationService; cues: string[]; } {
		const services = owner.add(new InstantiationService());
		const cues: string[] = [];
		services.registerInstance(IAccessibilitySignalService, { playSignal: async signal => { cues.push(signal.settingsKey); }, playSignalLoop: () => Disposable.None });
		return { services, cues };
	}

	test('terminal outcomes consume backend events, suppress task results, and release instance listeners', () => {
		using owner = new DisposableStore();
		const fixture = services(owner);
		const changed = owner.add(new Emitter<ITerminalCommandStatusEvent>());
		const removed = owner.add(new Emitter<ITerminalInstance>());
		const started = owner.add(new Emitter<ITaskRun>());
		const instance = { id: 'terminal', onDidChangeCommandStatus: changed.event } as ITerminalInstance;
		fixture.services.registerInstance(ITerminalService, { instances: [instance], onDidCreateInstance: Event.None, onDidDisposeInstance: removed.event } as unknown as ITerminalService);
		fixture.services.registerInstance(ITaskService, { activeRuns: [], onDidStartTask: started.event } as unknown as ITaskService);
		using host = WorkbenchContributionsRegistry.createHost(fixture.services, error => { throw error; }, ['workbench.contrib.terminalAccessibilitySignals']);
		host.advance(WorkbenchPhase.AfterRestored);
		changed.fire({ commandId: 'command1', status: 'running', exitCode: undefined });
		changed.fire({ commandId: 'command1', status: 'succeeded', exitCode: 0 });
		changed.fire({ commandId: 'command2', status: 'failed', exitCode: 7 });
		changed.fire({ commandId: 'command3', status: 'canceled', exitCode: undefined });
		started.fire({ terminalId: instance.id } as ITaskRun);
		changed.fire({ commandId: 'task', status: 'succeeded', exitCode: 0 });
		removed.fire(instance);
		changed.fire({ commandId: 'removed', status: 'failed', exitCode: 7 });
		assert.deepEqual(fixture.cues, ['accessibility.signals.terminalCommandSucceeded', 'accessibility.signals.terminalCommandFailed']);
	});

	test('Chat signals use committed transitions, ignore duplicate notifications, and release the window listener', () => {
		using owner = new DisposableStore();
		const fixture = services(owner);
		const updates = owner.add(new Emitter<ThreadUpdateEnvelope>());
		fixture.services.registerInstance(IChatService, { onDidUpdateThread: updates.event, onDidBecomeReady: Event.None } as IChatService);
		using host = WorkbenchContributionsRegistry.createHost(fixture.services, error => { throw error; }, ['workbench.contrib.chatAccessibilitySignals']);
		host.advance(WorkbenchPhase.AfterRestored);
		const send = (sequence: number, event: ThreadUpdateEnvelope['update']): void => updates.fire({ sessionId: 'session', threadId: 'thread', durableSequence: sequence, update: event });
		send(1, { type: 'committed', event: { type: 'turnAccepted' } });
		send(1, { type: 'committed', event: { type: 'turnAccepted' } });
		send(2, { type: 'itemDelta', itemId: 'message', delta: { type: 'agentMessage', text: 'streaming response' } });
		send(3, { type: 'committed', event: { type: 'interactionRequested', interaction: { requestId: 'question', request: { type: 'userInput', request: { questions: [] } } } } });
		send(4, { type: 'committed', event: { type: 'turnCompleted' } });
		send(5, { type: 'committed', event: { type: 'turnInterrupted' } });
		assert.deepEqual(fixture.cues, ['accessibility.signals.chatRequestSent', 'accessibility.signals.chatUserActionRequired', 'accessibility.signals.chatResponseReceived']);
		host.dispose();
		send(6, { type: 'committed', event: { type: 'turnFailed' } });
		assert.equal(fixture.cues.length, 3);
	});

	test('recording cues follow successful capture, stay quiet on startup failure, and stop once', () => {
		using owner = new DisposableStore();
		const fixture = services(owner);
		const changes = owner.add(new Emitter<ChatSpeechToTextState>());
		let starting = true;
		fixture.services.registerInstance(IChatSpeechToTextService, { state: ChatSpeechToTextState.Idle, get isStarting() { return starting; }, onDidChangeState: changes.event } as IChatSpeechToTextService);
		using host = WorkbenchContributionsRegistry.createHost(fixture.services, error => { throw error; }, ['workbench.contrib.voiceRecordingAccessibilitySignals']);
		host.advance(WorkbenchPhase.AfterRestored);
		changes.fire(ChatSpeechToTextState.Recording);
		changes.fire(ChatSpeechToTextState.Idle);
		assert.deepEqual(fixture.cues, []);
		changes.fire(ChatSpeechToTextState.Recording);
		starting = false;
		changes.fire(ChatSpeechToTextState.Recording);
		changes.fire(ChatSpeechToTextState.Recording);
		changes.fire(ChatSpeechToTextState.Transcribing);
		changes.fire(ChatSpeechToTextState.Idle);
		changes.fire(ChatSpeechToTextState.Idle);
		assert.deepEqual(fixture.cues, ['accessibility.signals.voiceRecordingStarted', 'accessibility.signals.voiceRecordingStopped']);
	});

	test('saving and debugger pauses follow their owners and release replaced session listeners', () => {
		using owner = new DisposableStore();
		const fixture = services(owner);
		const saves = owner.add(new Emitter<ITextFileSaveEvent>());
		const selection = owner.add(new Emitter<IDebugSession | undefined>());
		const first = owner.add(new Emitter<DebugSessionState>());
		const second = owner.add(new Emitter<DebugSessionState>());
		fixture.services.registerInstance(ITextFileService, { onDidSave: saves.event } as ITextFileService);
		fixture.services.registerInstance(IDebugService, { session: undefined, onDidChangeSession: selection.event } as IDebugService);
		using host = WorkbenchContributionsRegistry.createHost(fixture.services, error => { throw error; }, ['workbench.contrib.saveAccessibilitySignals', 'workbench.contrib.debugAccessibilitySignals']);
		host.advance(WorkbenchPhase.AfterRestored);
		saves.fire({ resource: URI.file('/document'), content: 'saved', revision: 'revision' });
		const session = { onDidChangeState: first.event } as IDebugSession;
		selection.fire(session);
		first.fire('stopped');
		selection.fire(session);
		selection.fire({ onDidChangeState: second.event } as IDebugSession);
		first.fire('stopped');
		second.fire('running');
		second.fire('stopped');
		assert.deepEqual(fixture.cues, ['accessibility.signals.save', 'accessibility.signals.onDebugBreak', 'accessibility.signals.onDebugBreak']);
		host.dispose();
		saves.fire({ resource: URI.file('/document'), content: 'saved', revision: 'revision' });
		second.fire('stopped');
		assert.equal(fixture.cues.length, 3);
	});

	test('cursor cues read current markers, suppress repeats, and cancel delayed work when an editor is removed', () => {
		mock.timers.enable({ apis: ['setTimeout'] });
		using owner = new DisposableStore();
		try {
			const fixture = services(owner);
			const positionChanged = owner.add(new Emitter<void>());
			const removed = owner.add(new Emitter<ICodeEditor>());
			const markers = owner.add(new MarkerService());
			let position = { lineNumber: 1, column: 1 };
			const resource = URI.file('/document');
			const editor = {
				getModel: () => ({ uri: resource }), getPosition: () => position,
				onDidChangeCursorPosition: positionChanged.event, onDidFocusEditorText: Event.None,
				onDidBlurEditorText: Event.None, onDidChangeModel: Event.None,
			} as unknown as ICodeEditor;
			fixture.services.registerInstance(ICodeEditorService, { onCodeEditorAdd: Event.None, onCodeEditorRemove: removed.event, listCodeEditors: () => [editor], getFocusedCodeEditor: () => editor } as unknown as ICodeEditorService);
			fixture.services.registerInstance(IMarkerService, markers);
			fixture.services.registerInstance(IDebugService, { breakpoints: [], onDidChangeBreakpoints: Event.None } as unknown as IDebugService);
			using host = WorkbenchContributionsRegistry.createHost(fixture.services, error => { throw error; }, ['workbench.contrib.editorTextPropertySignals']);
			host.advance(WorkbenchPhase.AfterRestored);
			markers.changeOne('diagnostics', resource, [{ severity: MarkerSeverity.Error, message: 'Error', range: { start: { lineIndex: 0, columnIndex: 2 }, end: { lineIndex: 0, columnIndex: 4 } } }]);
			mock.timers.tick(250);
			position = { lineNumber: 1, column: 3 };
			positionChanged.fire();
			mock.timers.tick(250);
			position = { lineNumber: 1, column: 4 };
			positionChanged.fire();
			mock.timers.tick(250);
			assert.deepEqual(fixture.cues, ['accessibility.signals.errorOnLine', 'accessibility.signals.errorAtPosition']);
			markers.remove('diagnostics', resource);
			mock.timers.tick(250);
			markers.changeOne('diagnostics', resource, [{ severity: MarkerSeverity.Warning, message: 'Warning', range: { start: { lineIndex: 0, columnIndex: 2 }, end: { lineIndex: 0, columnIndex: 4 } } }]);
			removed.fire(editor);
			mock.timers.tick(1000);
			assert.equal(fixture.cues.length, 2);
		} finally { mock.timers.reset(); }
	});
});
