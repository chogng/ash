import '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { CancellationTokenSource, type CancellationToken } from '../../../../../../base/common/cancellation.js';
import { canceled, isCancellationError } from '../../../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { StandaloneCommandService } from '../../../../../../editor/standalone/browser/standaloneServices.js';
import { ExtensionIdentifier } from '../../../../../../platform/extensions/common/extensions.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { SpeechService } from '../../../../speech/browser/speechService.js';
import { ISpeechService } from '../../../../speech/common/speechService.js';
import '../../../electron-browser/actions/voiceChatActions.js';
import { IChatWidgetService, type IChatWidget } from '../../../browser/chat.js';
import { ChatWidgetService } from '../../../browser/widget/chatWidgetService.js';
import { toDisposable } from '../../../../../../base/common/lifecycle.js';
import { StartVoiceChatAction } from '../../../electron-browser/actions/voiceChatActions.js';
import { setNlsMessages } from '../../../../../../nls.js';
import { initializeTestLocalization } from '../../../../../services/localization/test/common/localizationTestUtils.js';

interface Synthesis { readonly text: string; readonly completed: DeferredPromise<void>; }
function setup(owner: DisposableStore, ignoreCancellation = false) {
	const services = owner.add(new InstantiationService());
	const speech = owner.add(new SpeechService(undefined));
	services.registerInstance(ISpeechService, speech);
	const commands = owner.add(new StandaloneCommandService(services));
	const calls: Synthesis[] = []; const changed = owner.add(new Emitter<Synthesis>());
	let token!: CancellationToken;
	owner.add(speech.registerSpeechProvider('reader', {
		metadata: { extension: new ExtensionIdentifier('example.reader'), displayName: 'Reader' },
		createSpeechToTextSession: () => assert.fail('Unexpected recording'),
		createKeywordRecognitionSession: () => assert.fail('Unexpected keyword recognition'),
		createTextToSpeechSession: current => {
			token = current;
			return {
				onDidChange: Event.None,
				synthesize: async text => {
					const call = { text, completed: new DeferredPromise<void>() };
					using cancellation = token.onCancellationRequested(() => { if (!ignoreCancellation) void call.completed.error(canceled()); });
					calls.push(call); changed.fire(call); await call.completed.p;
				},
			};
		},
	}));
	const next = async (index: number) => {
		if (calls[index]) return calls[index];
		return new Promise<Synthesis>(resolve => {
			const listener = changed.event(call => { listener.dispose(); resolve(call); }); owner.add(listener);
		});
	};
	return { commands, speech, calls, next, get token() { return token; } };
}

suite('Desktop Chat response Speech commands', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('reads plaintext through the registered provider and releases its token after completion', async () => {
		using owner = new DisposableStore(); const fixture = setup(owner); const source = owner.add(new CancellationTokenSource());
		const reading = fixture.commands.executeCommand('workbench.action.chat.readChatResponseAloud', { type: 'agentMessage', text: '**Hello** [world](https://example.com)', source });
		const call = await fixture.next(0); assert.equal(call.text, 'Hello world');
		assert.equal(fixture.speech.hasActiveTextToSpeechSession, true); await call.completed.complete(); await reading;
		assert.equal(fixture.token.isCancellationRequested, true); assert.equal(fixture.speech.hasActiveTextToSpeechSession, false);
	});
	test('chunks wait for completion, preserve emoji at the boundary and reject overlapping reading', async () => {
		using owner = new DisposableStore(); const fixture = setup(owner); const source = owner.add(new CancellationTokenSource());
		const text = `${'x'.repeat(16383)}😀second`;
		const reading = fixture.commands.executeCommand('workbench.action.chat.readChatResponseAloud', { type: 'agentMessage', text, source });
		const first = await fixture.next(0); assert.equal(first.text, 'x'.repeat(16383));
		await assert.rejects(fixture.commands.executeCommand('workbench.action.chat.readChatResponseAloud', { type: 'agentMessage', text: 'overlap', source }), /already in progress/);
		assert.equal(fixture.calls.length, 1); await first.completed.complete();
		const second = await fixture.next(1); assert.equal(second.text, '😀second'); await second.completed.complete(); await reading;
	});
	test('Stop uses the row cancellation source and ignores a JSON object pretending to be a token', async () => {
		using owner = new DisposableStore(); const fixture = setup(owner); const source = owner.add(new CancellationTokenSource());
		await fixture.commands.executeCommand('workbench.action.chat.readChatResponseAloud', { type: 'userMessage', text: 'private', source });
		await fixture.commands.executeCommand('workbench.action.chat.readChatResponseAloud', { type: 'agentMessage', text: 'fake', source: { token: {} } });
		assert.deepEqual(fixture.calls, []);
		const reading = fixture.commands.executeCommand('workbench.action.chat.readChatResponseAloud', { type: 'agentMessage', text: 'pending', source });
		const cancelled = assert.rejects(reading, isCancellationError); await fixture.next(0);
		await fixture.commands.executeCommand('workbench.action.chat.stopReadChatItemAloud', { source }); await cancelled;
		assert.equal(source.token.isCancellationRequested, true); assert.equal(fixture.speech.hasActiveTextToSpeechSession, false);
	});

	test('window Stop command cannot stop another window reading through its own provider', async () => {
		using owner = new DisposableStore();
		const first = setup(owner); const second = setup(owner);
		const firstSource = owner.add(new CancellationTokenSource()); const secondSource = owner.add(new CancellationTokenSource());
		const firstReading = first.commands.executeCommand('workbench.action.chat.readChatResponseAloud', { type: 'agentMessage', text: 'first', source: firstSource });
		const cancelled = assert.rejects(firstReading, isCancellationError);
		const secondReading = second.commands.executeCommand('workbench.action.chat.readChatResponseAloud', { type: 'agentMessage', text: 'second', source: secondSource });
		await first.next(0); const secondCall = await second.next(0);
		await first.commands.executeCommand('workbench.action.speech.stopReadAloud'); await cancelled;
		assert.equal(first.speech.hasActiveTextToSpeechSession, false);
		assert.equal(second.speech.hasActiveTextToSpeechSession, true); assert.equal(second.token.isCancellationRequested, false);
		await secondCall.completed.complete(); await secondReading;
	});

	test('a cancelled provider waiting for a late receipt cannot retain or erase the replacement window owner', async () => {
		using owner = new DisposableStore(); const fixture = setup(owner, true);
		const old = owner.add(new CancellationTokenSource());
		const first = fixture.commands.executeCommand('workbench.action.chat.readChatResponseAloud', { type: 'agentMessage', text: 'old', source: old });
		const cancelledFirst = assert.rejects(first, isCancellationError); const firstCall = await fixture.next(0);
		old.cancel(); assert.equal(fixture.speech.hasActiveTextToSpeechSession, false);
		const current = owner.add(new CancellationTokenSource());
		const second = fixture.commands.executeCommand('workbench.action.chat.readChatResponseAloud', { type: 'agentMessage', text: 'current', source: current });
		const cancelledSecond = assert.rejects(second, isCancellationError); const secondCall = await fixture.next(1);
		await firstCall.completed.complete(); await cancelledFirst;
		assert.equal(fixture.speech.hasActiveTextToSpeechSession, true); assert.equal(fixture.token.isCancellationRequested, false);
		await fixture.commands.executeCommand('workbench.action.speech.stopReadAloud');
		assert.equal(fixture.token.isCancellationRequested, true);
		await secondCall.completed.complete(); await cancelledSecond;
	});
});

suite('Desktop built-in Voice Mode command', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('uses the installed Chinese catalog for the Voice Mode command', () => {
		initializeTestLocalization('zh-CN');
		try { assert.deepEqual(new StartVoiceChatAction().desc.title, { original: 'Start Voice Mode', value: '启动语音模式' }); }
		finally { setNlsMessages('en', {}); }
	});
	test('starts through the focused registered Chat owner and rejects retired or foreign targets', async () => {
		using owner = new DisposableStore();
		const services = owner.add(new InstantiationService());
		const widgets = owner.add(new ChatWidgetService());
		services.registerInstance(IChatWidgetService, widgets);
		const commands = owner.add(new StandaloneCommandService(services));
		const input = document.createElement('input');
		document.body.append(input);
		owner.add(toDisposable(() => input.remove()));
		let starts = 0;
		const widget: IChatWidget & { visible: boolean; isTranscriptProgressActive: boolean; } = {
			sessionId: undefined, threadId: undefined, onDidChangeVisibility: Event.None,
			domNode: input, visible: true, inputEditor: undefined, isTranscriptProgressActive: false,
			onDidHide: Event.None, onDidChangeViewModel: Event.None,
			acquireContext: async () => { throw new Error('Unexpected context preparation'); },
			startVoiceConversation: async () => { starts++; },
		};
		const registration = owner.add(widgets.register(widget));
		input.focus();
		await commands.executeCommand('workbench.action.chat.startVoiceChat');
		assert.equal(starts, 1);
		widget.visible = false;
		await commands.executeCommand('workbench.action.chat.startVoiceChat');
		widget.visible = true;
		widget.isTranscriptProgressActive = true;
		await commands.executeCommand('workbench.action.chat.startVoiceChat', { widget });
		widget.isTranscriptProgressActive = false;
		await commands.executeCommand('workbench.action.chat.startVoiceChat', { widget: { ...widget } });
		registration.dispose();
		await commands.executeCommand('workbench.action.chat.startVoiceChat', { widget });
		assert.equal(starts, 1);
	});
});
