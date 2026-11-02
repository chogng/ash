import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { setARIAContainer } from '../../../../../base/browser/ui/aria/aria.js';
import { installEditorTestDom } from '../../../../../editor/test/browser/editorTestGlobals.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { IPreferencesService } from '../../../../services/preferences/common/preferences.js';
import { TestConfigurationService } from '../../../../services/configuration/test/common/testServices.js';
import { registerTestDictationOnboarding, createTestDictationBackend, installTestDictationAudio } from '../../../../test/common/testDictationServices.js';
import { IVoiceCodeTranscriptionBackendService } from '../../../../../platform/dictation/common/dictation.js';
import { IChatSpeechToTextService, ChatSpeechToTextService } from '../../../chat/browser/speechToText/chatSpeechToTextService.js';
import { IDictationOnboardingService } from '../../../chat/browser/speechToText/dictationOnboarding.js';
import { SpeechService } from '../../../speech/browser/speechService.js';
import { ISpeechService } from '../../../speech/common/speechService.js';
import { ChatInputNoticeHost, ChatInputNoticeLane } from '../../../chat/browser/widget/input/notices/chatInputNoticeHost.js';
import { IChatInputNoticeHubService } from '../../../chat/browser/widget/input/notices/chatInputNoticeHub.js';
import { registerChatInputOnboardingHosts } from '../../../chat/browser/widget/input/notices/chatInputOnboardingHosts.js';
import { IVoiceModeOnboardingService } from '../../browser/voiceModeOnboarding.js';
import { AgentsVoiceStorageKeys } from '../../common/agentsVoice.js';
import { AgentsVoiceWidget } from '../../browser/agentsVoiceWidget.js';

function fixture() {
	const owner = new DisposableStore();
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	owner.add(toDisposable(() => dom.window.close()));
	owner.add(installEditorTestDom(dom, ['Node', 'Element', 'HTMLElement', 'HTMLButtonElement', 'Event', 'KeyboardEvent', 'MouseEvent']));
	const window = dom.window as unknown as Window & typeof globalThis;
	owner.add(setARIAContainer(window.document.body));
	const audio = owner.add(installTestDictationAudio(window));
	const services = owner.add(new InstantiationService());
	services.registerSingleton(IConfigurationService, () => new TestConfigurationService({ source: '{"dictation.backend":"cloud"}' }));
	services.registerInstance(IVoiceCodeTranscriptionBackendService, createTestDictationBackend(owner, { start: async () => ({ stop: async () => { }, cancel: async () => { } }) }));
	services.registerInstance(IPreferencesService, { openSettings: async () => { } } as unknown as IPreferencesService);
	services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
	registerTestDictationOnboarding(services, false);
	services.registerSingleton(ISpeechService, () => services.createInstance(SpeechService));
	services.registerSingleton(IChatSpeechToTextService, () => services.createInstance(ChatSpeechToTextService));
	const voice = services.get(IVoiceModeOnboardingService);
	const dictation = services.get(IDictationOnboardingService);
	const storage = services.get(IStorageService);
	const hub = services.get(IChatInputNoticeHubService);
	const surface = () => {
		const root = window.document.createElement('main');
		const input = window.document.createElement('textarea');
		const voiceSlot = window.document.createElement('div');
		const dictationSlot = window.document.createElement('div');
		root.append(voiceSlot, dictationSlot, input);
		window.document.body.append(root);
		root.getClientRects = () => [{ width: 300, height: 100 }] as unknown as DOMRectList;
		const notices = owner.add(new ChatInputNoticeHost(() => input.focus()));
		owner.add(hub.registerHost(notices, root));
		const registration = owner.add(registerChatInputOnboardingHosts(notices, { voice: voiceSlot, dictation: dictationSlot }, root, () => input.focus(), voice, dictation));
		return { root, input, notices, registration };
	};
	return { voice, dictation, storage, hub, surface, audio, window, services, dispose: () => owner.dispose(), [Symbol.dispose]: () => owner.dispose() };
}

suite('Voice and dictation shared onboarding hosts', () => {
	test('notifications defer voice creation; newer dictation yields back to the same voice card and shared focus target', () => {
		using f = fixture();
		const { root, input, notices } = f.surface();
		input.focus();
		using notification = notices.occupy(ChatInputNoticeLane.Notification);
		f.voice.showIfNeeded();
		assert.equal(root.querySelector('.ash-agents-voice-introduction'), null);
		assert.equal(f.storage.getBoolean(AgentsVoiceStorageKeys.IntroBannerShown, StorageScope.PROFILE, false), false);
		notification.dispose();
		const voiceCard = root.querySelector<HTMLElement>('.ash-agents-voice-introduction')!;
		assert.ok(voiceCard);
		assert.equal(voiceCard.hidden, false);
		assert.equal(f.storage.getBoolean(AgentsVoiceStorageKeys.IntroBannerShown, StorageScope.PROFILE, false), false);
		f.dictation.show();
		assert.equal(voiceCard.hidden, true);
		const dictationCard = root.querySelector<HTMLElement>('.ash-dictation-onboarding')!;
		dictationCard.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		assert.equal(root.querySelector('.ash-agents-voice-introduction'), voiceCard);
		assert.equal(voiceCard.hidden, false);
		input.focus();
		assert.equal(f.hub.toggleNoticeFocus(), true);
		assert.equal(f.window.document.activeElement, voiceCard);
		assert.equal(f.hub.toggleNoticeFocus(), true);
		assert.equal(f.window.document.activeElement, input);
		const acknowledge = voiceCard.querySelector<HTMLButtonElement>('button')!;
		acknowledge.focus(); acknowledge.click();
		assert.equal(root.querySelector('.ash-agents-voice-introduction'), null);
		assert.equal(f.storage.getBoolean(AgentsVoiceStorageKeys.IntroBannerShown, StorageScope.PROFILE, false), true);
		assert.equal(f.window.document.activeElement, input);
		f.voice.showIfNeeded();
		assert.equal(root.querySelector('.ash-agents-voice-introduction'), null);
		assert.equal(f.audio.requests.length, 0);
	});

	test('Escape and retirement preserve the unacknowledged preference and cannot acknowledge a stale card', () => {
		using f = fixture();
		const first = f.surface();
		const second = f.surface();
		second.input.focus();
		assert.equal(f.voice.show(), true);
		assert.equal(first.root.querySelector('.ash-agents-voice-introduction'), null);
		const card = second.root.querySelector<HTMLElement>('.ash-agents-voice-introduction')!;
		assert.equal(f.window.document.activeElement, card);
		card.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		assert.equal(f.window.document.activeElement, second.input);
		assert.equal(f.storage.getBoolean(AgentsVoiceStorageKeys.IntroBannerShown, StorageScope.PROFILE, false), false);
		f.voice.showIfNeeded();
		const stale = second.root.querySelector<HTMLButtonElement>('.ash-agents-voice-introduction button')!;
		second.registration.dispose();
		assert.equal(second.root.querySelector('.ash-agents-voice-introduction'), null);
		stale.click();
		assert.equal(f.storage.getBoolean(AgentsVoiceStorageKeys.IntroBannerShown, StorageScope.PROFILE, false), false);
		first.root.hidden = true;
		assert.equal(f.voice.show(), false);
	});

	test('existing profile acknowledgement is shared by automatic and manually opened introductions', () => {
		using f = fixture();
		const { root, input } = f.surface();
		f.storage.store(AgentsVoiceStorageKeys.IntroBannerShown, true, StorageScope.PROFILE, StorageTarget.USER);
		input.focus(); f.voice.showIfNeeded();
		assert.equal(root.querySelector('.ash-agents-voice-introduction'), null);
		assert.equal(f.voice.show(), true);
		assert.ok(root.querySelector('.ash-agents-voice-introduction'));
		assert.equal(f.audio.requests.length, 0);
	});

	test('an unacknowledged first-use request follows the newly focused input with one card owner', () => {
		using f = fixture();
		const first = f.surface();
		first.input.focus(); f.voice.showIfNeeded();
		assert.ok(first.root.querySelector('.ash-agents-voice-introduction'));
		const second = f.surface();
		second.input.focus(); f.voice.showIfNeeded();
		assert.equal(first.root.querySelector('.ash-agents-voice-introduction'), null);
		assert.ok(second.root.querySelector('.ash-agents-voice-introduction'));
		assert.equal(f.window.document.querySelectorAll('.ash-agents-voice-introduction').length, 1);
		assert.equal(f.storage.getBoolean(AgentsVoiceStorageKeys.IntroBannerShown, StorageScope.PROFILE, false), false);
	});

	test('floating voice controls use the same introduction owner and release their host on disposal', () => {
		using f = fixture();
		const first = f.surface();
		first.input.focus(); f.voice.showIfNeeded();
		const prototype = f.window.HTMLElement.prototype;
		const getClientRects = prototype.getClientRects;
		prototype.getClientRects = () => [{ width: 300, height: 100 }] as unknown as DOMRectList;
		try {
			let operations = 0;
			const unexpected = () => { operations++; };
			using widget = f.services.createInstance(AgentsVoiceWidget, f.window.document.body, {
				openSession: unexpected, connect: unexpected, toggleMute: unexpected, toggleInputMode: unexpected,
				pttDown: unexpected, pttUp: unexpected, disconnect: unexpected, stopPlayback: unexpected,
				closeWindow: unexpected, showSessionsPicker: unexpected,
			}, {});
			const card = widget.element.querySelector<HTMLElement>('.ash-agents-voice-introduction')!;
			assert.ok(card);
			assert.equal(first.root.querySelector('.ash-agents-voice-introduction'), null);
			assert.equal(f.hub.toggleNoticeFocus(), true);
			assert.equal(f.window.document.activeElement, card);
			widget.dispose();
			assert.equal(f.window.document.querySelector('.ash-agents-voice-introduction'), null);
			assert.equal(f.storage.getBoolean(AgentsVoiceStorageKeys.IntroBannerShown, StorageScope.PROFILE, false), false);
			first.input.focus(); f.voice.showIfNeeded();
			assert.ok(first.root.querySelector('.ash-agents-voice-introduction'));
			assert.equal(operations, 0);
			assert.equal(f.audio.requests.length, 0);
		} finally {
			prototype.getClientRects = getClientRects;
		}
	});
});
