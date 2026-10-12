import '../../browser/speech.contribution.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAccessibilitySignalService } from '../../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { IDictationService, type IDictationSession } from '../../../../../platform/dictation/common/dictationService.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../common/contributions.js';
import { ISpeechService, SpeechToTextState, type ISpeechToTextTranscript } from '../../common/speechService.js';

suite('Workbench speech ownership', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function services(owner: DisposableStore, start: IDictationService['start']) {
		const registrations = getSingletonServiceDescriptors().filter(([id]) => id === ISpeechService);
		assert.equal(registrations.length, 1);
		const services = owner.add(new InstantiationService(new ServiceCollection(...registrations)));
		services.registerInstance(IDictationService, {
			onDidChangePreparation: Event.None,
			getPreparation: async () => undefined,
			prepareModel: async () => { },
			cancelPreparation: async () => { },
			getOptions: async () => ({ inputDevices: [], languages: [] }),
			start,
		});
		const cues: string[] = [];
		services.registerInstance(IAccessibilitySignalService, {
			playSignal: async signal => { cues.push(signal.settingsKey); },
			playSignalLoop: () => Disposable.None,
		});
		const host = owner.add(WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['workbench.contrib.speechAccessibilitySignal']));
		host.advance(WorkbenchPhase.AfterRestored);
		return { services, cues, speech: services.get(ISpeechService), host };
	}

	test('production registration shares capture across consumers and flushes the final phrase before idle', async () => {
		using owner = new DisposableStore();
		let transcript!: (text: string, isFinal: boolean) => void;
		let ended!: (error?: string) => void;
		let stops = 0;
		const fixture = services(owner, async (onTranscript, onEnded) => {
			transcript = onTranscript;
			ended = onEnded;
			return { stop: async () => { stops++; transcript('second', true); ended(); } };
		});
		const first = owner.add(fixture.services.createChild());
		const second = owner.add(fixture.services.createChild());
		assert.equal(first.get(ISpeechService), second.get(ISpeechService));
		const updates: ISpeechToTextTranscript[] = [];
		const observations: (SpeechToTextState | string)[] = [];
		owner.add(fixture.speech.onDidUpdateTranscript(update => { updates.push(update); observations.push(update.text); }));
		owner.add(fixture.speech.onDidChangeState(state => observations.push(state)));
		await first.get(ISpeechService).start();
		await assert.rejects(second.get(ISpeechService).start(), /Dictation is already active/);
		transcript('first', true);
		transcript('draft', false);
		const stopped = fixture.speech.stopAndTranscribe();
		assert.equal(fixture.speech.stopAndTranscribe(), stopped);
		assert.equal(await stopped, 'first second');
		assert.deepEqual(updates, [
			{ text: 'first', finalizedText: 'first' },
			{ text: 'first draft', finalizedText: 'first' },
			{ text: 'first second', finalizedText: 'first second' },
		]);
		assert.deepEqual(observations.slice(-3), [SpeechToTextState.Transcribing, 'first second', SpeechToTextState.Idle]);
		assert.equal(stops, 1);
		assert.deepEqual(fixture.cues, ['accessibility.signals.voiceRecordingStarted', 'accessibility.signals.voiceRecordingStopped']);
		fixture.host.dispose();
		await fixture.speech.start();
		await fixture.speech.cancel();
		assert.equal(fixture.cues.length, 2);
	});

	test('cancel while acquiring the microphone closes the acquired session and discards its final text', async () => {
		using owner = new DisposableStore();
		let acquired!: (session: IDictationSession) => void;
		let transcript!: (text: string, isFinal: boolean) => void;
		let stops = 0;
		const fixture = services(owner, onTranscript => {
			transcript = onTranscript;
			return new Promise(resolve => { acquired = resolve; });
		});
		const updates: ISpeechToTextTranscript[] = [];
		owner.add(fixture.speech.onDidUpdateTranscript(update => updates.push(update)));
		const starting = fixture.speech.start();
		assert.equal(fixture.speech.isStarting, true);
		const cancelled = fixture.speech.cancel();
		acquired({ stop: async () => { stops++; transcript('discarded', true); } });
		await starting;
		await cancelled;
		assert.equal(stops, 1);
		assert.equal(fixture.speech.state, SpeechToTextState.Idle);
		assert.deepEqual(updates, []);
		assert.deepEqual(fixture.cues, []);
	});

	test('failed microphone acquisition releases capture without announcing a recording', async () => {
		using owner = new DisposableStore();
		let fail = true;
		const fixture = services(owner, async () => {
			if (fail) { throw new Error('microphone unavailable'); }
			return { stop: async () => { } };
		});
		await assert.rejects(fixture.speech.start(), /microphone unavailable/);
		assert.equal(fixture.speech.state, SpeechToTextState.Idle);
		assert.deepEqual(fixture.cues, []);
		fail = false;
		await fixture.speech.start();
		await fixture.speech.cancel();
		assert.deepEqual(fixture.cues, ['accessibility.signals.voiceRecordingStarted', 'accessibility.signals.voiceRecordingStopped']);
	});
});
