import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';
import type { } from '../../../../../../../test/fixtures/browser/chatInput.page.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { IAgentVoiceService, type IAgentVoiceService as AgentVoiceService } from '../../../../../platform/agentHost/common/agentService.js';
import type { AgentVoiceSessionState } from '../../../../../platform/agentHost/common/agent.js';
import { ChatAIDisabledSettingId } from '../../../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService, ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../../services/storage/browser/storageService.js';
import { TestConfigurationService } from '../../../../services/configuration/test/common/testServices.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../common/contributions.js';
import { AGENTS_VOICE_LISTENING, AGENTS_VOICE_MUTED, AGENTS_VOICE_TOGGLE_MUTE_COMMAND_ID } from '../../../agentsVoice/common/agentsVoice.js';
import '../../../agentsVoice/browser/agentsVoice.contribution.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { IChatSpeechToTextService, ChatSpeechToTextState } from '../../browser/speechToText/chatSpeechToTextService.js';
import { CHAT_VOICE_INPUT_MODE, VoiceInputModeService } from '../../browser/voiceInputMode/voiceInputMode.js';
import '../../browser/chat.shared.contribution.js';

function fixture() {
	const resources = new DisposableStore();
	const dom = new JSDOM('<body></body>', { url: 'https://ash.test' });
	resources.add(toDisposable(() => dom.window.close()));
	const storage = resources.add(new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, flushInterval: 0, workspaceId: 'voice-test' }));
	const configuration = resources.add(new TestConfigurationService());
	const context = resources.add(new ContextKeyService());
	const changes = resources.add(new Emitter<void>());
	const speechChanges = resources.add(new Emitter<ChatSpeechToTextState>());
	let configured = true;
	let available = true;
	let state: AgentVoiceSessionState | undefined;
	const voice: AgentVoiceService = {
		get isAvailable() { return available; }, get state() { return state; },
		onDidChange: changes.event, onDidRequestTask: Event.None,
		getOptions: async () => [], start: async () => { throw new Error('Unexpected connection'); },
		stop: async () => { }, interrupt: async () => { }, rejectTask: async () => { },
		setMuted: async muted => { if (state) state = { ...state, muted, listening: !muted }; changes.fire(); },
		setInputMode: async () => { }, pttDown: async () => { }, pttUp: async () => { },
	};
	const services = resources.add(new InstantiationService());
	services.registerInstance(IStorageService, storage);
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IContextKeyService, context);
	services.registerInstance(IAgentVoiceService, voice);
	services.registerInstance(IChatSpeechToTextService, {
		get isConfigured() { return configured; }, state: ChatSpeechToTextState.Idle,
		onDidChangeState: speechChanges.event,
	} as IChatSpeechToTextService);
	const create = (): VoiceInputModeService => resources.add(services.createInstance(VoiceInputModeService));
	return {
		services, storage, configuration, context, create, voice,
		setAvailable(value: boolean): void { available = value; changes.fire(); },
		setConfigured(value: boolean): void { configured = value; speechChanges.fire(ChatSpeechToTextState.Idle); },
		setState(value: AgentVoiceSessionState): void { state = value; changes.fire(); },
		resources,
		[Symbol.dispose]: () => resources.dispose(),
	};
}

const connected: AgentVoiceSessionState = {
	resourceId: 'media', sessionId: 'session', threadId: 'thread', state: 'connected',
	mediaEpoch: 1, sequence: 1, inputSequence: 0, inputMode: 'openMic', muted: false,
	listening: true, usageMilliseconds: 0,
};

suite('Voice input mode', () => {
	test('selection persists and external storage changes update the context without changing media', () => {
		using f = fixture();
		const service = f.create();
		assert.equal(service.selectedMode.get(), 'voice');
		assert.equal(f.context.getValue(CHAT_VOICE_INPUT_MODE.key), 'voice');
		service.setSelectedMode('dictation');
		assert.equal(f.storage.get('chat.voiceInputMode.selected', StorageScope.PROFILE), 'dictation');
		assert.equal(f.context.getValue(CHAT_VOICE_INPUT_MODE.key), 'dictation');
		service.dispose();
		const restarted = f.create();
		assert.equal(restarted.selectedMode.get(), 'dictation');
		f.setState(connected);
		f.storage.store('chat.voiceInputMode.selected', 'voice', StorageScope.PROFILE, StorageTarget.USER);
		assert.equal(restarted.selectedMode.get(), 'voice');
		assert.equal(f.context.getValue(CHAT_VOICE_INPUT_MODE.key), 'voice');
		assert.equal(f.voice.state, connected);
		f.storage.store('chat.voiceInputMode.selected', 'invalid', StorageScope.PROFILE, StorageTarget.USER);
		assert.equal(restarted.selectedMode.get(), 'voice');
	});

	test('availability follows configuration, providers and backend changes', async () => {
		using f = fixture();
		const service = f.create();
		const observed: unknown[] = [];
		using reaction = autorun(reader => observed.push([service.voiceAvailable.read(reader), service.dictationAvailable.read(reader)]));
		assert.deepEqual(observed.at(-1), [true, true]);
		f.setAvailable(false);
		assert.deepEqual(observed.at(-1), [false, true]);
		await f.configuration.updateValue('dictation.showButton', false);
		assert.deepEqual(observed.at(-1), [false, false]);
		f.setAvailable(true);
		await f.configuration.updateValue('dictation.showButton', true);
		await f.configuration.updateValue('agents.voice.showButton', false);
		assert.deepEqual(observed.at(-1), [false, true]);
		await f.configuration.updateValue('agents.voice.showButton', true);
		f.setConfigured(false);
		assert.deepEqual(observed.at(-1), [true, false]);
		f.setConfigured(true);
		await f.configuration.updateValue(ChatAIDisabledSettingId, true);
		assert.deepEqual(observed.at(-1), [false, false]);
	});

	test('hands-free projects the existing media input mode', () => {
		using f = fixture();
		const service = f.create();
		assert.equal(service.handsFree.get(), true);
		f.setState({ ...connected, inputMode: 'pushToTalk' });
		assert.equal(service.handsFree.get(), false);
		f.setState(connected);
		assert.equal(service.handsFree.get(), true);
	});

	test('production construction rejects an unregistered media capability', () => {
		using f = fixture();
		using services = new InstantiationService();
		services.registerInstance(IStorageService, f.storage);
		services.registerInstance(IConfigurationService, f.configuration);
		services.registerInstance(IContextKeyService, f.context);
		services.registerInstance(IChatSpeechToTextService, f.services.get(IChatSpeechToTextService));
		assert.throws(() => services.createInstance(VoiceInputModeService), /agentVoiceService/);
	});

	test('common listening and mute keys follow the single media owner and shared command', async () => {
		using f = fixture();
		using host = WorkbenchContributionsRegistry.createHost(f.services, error => { throw error; }, ['workbench.contrib.agentsVoice']);
		host.advance(WorkbenchPhase.BlockRestore);
		f.setState(connected);
		assert.equal(f.context.getValue(AGENTS_VOICE_LISTENING.key), true);
		assert.equal(f.context.getValue(AGENTS_VOICE_MUTED.key), false);
		using commands = new CommandService(f.services);
		await commands.executeCommand(AGENTS_VOICE_TOGGLE_MUTE_COMMAND_ID);
		assert.equal(f.voice.state?.muted, true);
		assert.equal(f.context.getValue(AGENTS_VOICE_LISTENING.key), false);
		assert.equal(f.context.getValue(AGENTS_VOICE_MUTED.key), true);
		f.setState({ ...connected, state: 'ended' });
		assert.equal(f.context.getValue(AGENTS_VOICE_MUTED.key), false);
		host.dispose();
		f.setState(connected);
		assert.equal(f.context.getValue(AGENTS_VOICE_LISTENING.key), false);
	});
});

suite('Voice input mode browser', () => {
	const browser = useBrowserTests();
	browser.use({ hasTouch: true });
	for (const locale of ['en', 'zh-CN']) test(`keyboard and touch route to the owning input (${locale})`, async () => {
		const { page } = browser;
		await page.goto(`/chatInput.html?inlineCode&dictation&voiceInput&locale=${locale}`);
		await page.evaluate(() => window.ashChatInputIntegration.appendToDraft('Keep this draft'));
		const group = page.getByRole('group', { name: locale === 'en' ? 'Voice input' : '语音输入' });
		const power = group.getByRole('button', { name: locale === 'en' ? 'Voice conversation' : '语音对话', exact: true });
		await expect(power).toBeVisible();
		await power.focus();
		await power.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.voiceInputState().starts)).toBe(1);
		const stop = group.getByRole('button', { name: locale === 'en' ? 'Stop voice conversation' : '停止语音对话', exact: true });
		await stop.focus();
		await stop.press('ArrowRight');
		const mute = group.getByRole('button', { name: locale === 'en' ? 'Mute microphone' : '麦克风静音', exact: true });
		await expect(mute).toBeFocused();
		await mute.press('Space');
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.voiceInputState().muted)).toBe(true);
		await expect(group.getByRole('button', { name: locale === 'en' ? 'Unmute microphone' : '取消麦克风静音', exact: true })).toHaveAttribute('aria-pressed', 'true');
		const dictate = group.getByRole('button', { name: locale === 'en' ? 'Dictate message' : '听写', exact: true });
		await dictate.tap();
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.voiceInputState().stops)).toBe(1);
		await expect(group.getByRole('button', { name: locale === 'en' ? 'Stop dictation' : '结束听写', exact: true })).toBeVisible();
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.isDictationReady())).toBe(true);
		await page.evaluate(() => window.ashChatInputIntegration.emitDictation('Draft speech', false));
		await expect(page.locator('.ash-chat-dictation-preview')).toHaveText('Draft speech');
		await group.getByRole('button', { name: locale === 'en' ? 'Voice conversation' : '语音对话', exact: true }).tap();
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.voiceInputState())).toEqual({ starts: 2, stops: 1, muted: false, dictationCancelled: 1 });
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.dropState().text)).toBe('Keep this draft');
	});

	test('stopping dictation waits for the final transcript without sending the draft', async () => {
		const { page } = browser;
		await page.goto('/chatInput.html?inlineCode&dictation&voiceInput');
		const group = page.getByRole('group', { name: 'Voice input' });
		await group.getByRole('button', { name: 'Dictate message', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.isDictationReady())).toBe(true);
		await page.evaluate(() => window.ashChatInputIntegration.emitDictation('Spoken task', false));
		await group.getByRole('button', { name: 'Stop dictation', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.dictationState().stops)).toBe(1);
		await page.evaluate(() => window.ashChatInputIntegration.finishDictation('Spoken task'));
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.dropState().text)).toBe('Spoken task');
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.historyState())).toMatchObject({ submissions: [] });
	});

	test('hiding the input while disconnecting does not start replacement dictation', async () => {
		const { page } = browser;
		await page.goto('/chatInput.html?inlineCode&dictation&voiceInput&hideOnVoiceStop');
		const group = page.getByRole('group', { name: 'Voice input' });
		await group.getByRole('button', { name: 'Voice conversation', exact: true }).click();
		await expect(group.getByRole('button', { name: 'Stop voice conversation', exact: true })).toBeVisible();
		await group.getByRole('button', { name: 'Dictate message', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.voiceInputState().stops)).toBe(1);
		expect(await page.evaluate(() => window.ashChatInputIntegration.isDictationReady())).toBe(false);
	});

	test('voice alone gains a mute cell only while connected', async () => {
		const { page } = browser;
		await page.goto('/chatInput.html?inlineCode&dictation&voiceInput&hideDictation');
		const group = page.getByRole('group', { name: 'Voice input' });
		await expect(page.getByRole('button', { name: 'Voice conversation', exact: true })).toBeVisible();
		await expect(group).toHaveCount(0);
		await page.getByRole('button', { name: 'Voice conversation', exact: true }).click();
		await expect(group).toBeVisible();
		await expect(group.getByRole('button')).toHaveCount(2);
		await group.getByRole('button', { name: 'Stop voice conversation', exact: true }).click();
		await expect(group).toHaveCount(0);
	});

	test('hidden voice controls leave a standalone dictation button', async () => {
		const { page } = browser;
		await page.goto('/chatInput.html?inlineCode&dictation&voiceInput&hideVoice');
		await expect(page.getByRole('button', { name: 'Dictate message', exact: true })).toBeVisible();
		await expect(page.getByRole('group', { name: 'Voice input' })).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Voice conversation', exact: true })).toHaveCount(0);
	});

	for (const theme of ['dark', 'light', 'hcDark', 'hcLight']) test(`segmented controls keep geometry and focus in ${theme}`, async () => {
		const { page } = browser;
		await page.goto(`/chatInput.html?inlineCode&dictation&voiceInput&theme=${theme}`);
		const group = page.getByRole('group', { name: 'Voice input' });
		const power = group.getByRole('button', { name: 'Voice conversation', exact: true });
		await power.focus();
		await power.press('ArrowLeft');
		await expect(group.getByRole('button', { name: 'Dictate message', exact: true })).toBeFocused();
		const geometry = await group.evaluate(root => {
			const rect = root.getBoundingClientRect();
			const buttons = [...root.querySelectorAll('button')].filter(button => !button.hidden && getComputedStyle(button).display !== 'none');
			const focused = root.ownerDocument.activeElement!;
			const style = getComputedStyle(focused);
			return {
				count: buttons.length,
				contained: buttons.every(button => { const bounds = button.getBoundingClientRect(); return bounds.left >= rect.left && bounds.right <= rect.right && bounds.top >= rect.top && bounds.bottom <= rect.bottom; }),
				focus: style.outlineStyle !== 'none' && style.outlineColor !== 'rgba(0, 0, 0, 0)',
				selectedBackground: getComputedStyle(buttons[1]!).backgroundColor,
			};
		});
		expect(geometry.count).toBe(2);
		expect(geometry.contained).toBe(true);
		expect(geometry.focus).toBe(true);
		expect(geometry.selectedBackground).not.toBe('rgba(0, 0, 0, 0)');
		await page.evaluate(() => window.ashChatInputIntegration.setVoiceAvailable(false));
		await expect(group).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Dictate message', exact: true })).toBeVisible();
	});
});
