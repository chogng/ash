import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import '../../browser/agentsVoice.contribution.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { IAgentVoiceService } from '../../../../../platform/agentHost/common/agentService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { TestNotificationService } from '../../../../services/notification/test/common/testNotificationService.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { BrowserKeyboardLayoutService } from '../../../../services/keybinding/browser/keyboardLayoutService.js';
import { WorkbenchKeybindingService } from '../../../../services/keybinding/browser/keybindingService.js';
import { KeybindingTestServices } from '../../../../services/keybinding/test/browser/keybindingTestServices.js';
import { AGENTS_VOICE_CONNECTED, AGENTS_VOICE_PUSH_TO_TALK } from '../../common/agentsVoice.js';

test('Voice push to talk shortcut suppresses repeats and releases on keyup and window blur', async () => {
	using resources = new DisposableStore();
	const dom = new JSDOM('<body></body>');
	resources.add(toDisposable(() => dom.window.close()));
	const profiles = resources.add(new KeybindingTestServices());
	const services = resources.add(new InstantiationService());
	const contexts = resources.add(new ContextKeyService());
	AGENTS_VOICE_CONNECTED.bindTo(contexts).set(true);
	AGENTS_VOICE_PUSH_TO_TALK.bindTo(contexts).set(true);
	const controls: { type: string; id: string }[] = [];
	services.registerInstance(IAgentVoiceService, {
		isAvailable: true,
		state: {
			resourceId: 'media',
			sessionId: 'session',
			threadId: 'thread',
			state: 'connected',
			mediaEpoch: 1,
			sequence: 1,
			inputSequence: 0,
			inputMode: 'pushToTalk',
			muted: false,
			listening: false,
			usageMilliseconds: 0,
		},
		onDidChange: Event.None,
		onDidRequestTask: Event.None,
		getOptions: async () => [],
		start: async () => {
			throw new Error('Unexpected start');
		},
		stop: async () => {
			throw new Error('Unexpected stop');
		},
		interrupt: async () => {
			throw new Error('Unexpected interrupt');
		},
		rejectTask: async () => {
			throw new Error('Unexpected task');
		},
		setMuted: async () => {
			throw new Error('Unexpected mute');
		},
		setInputMode: async () => {
			throw new Error('Unexpected mode');
		},
		pttDown: async id => {
			controls.push({ type: 'hold', id });
		},
		pttUp: async id => {
			controls.push({ type: 'release', id });
		},
	});
	const commands = resources.add(new CommandService(services));
	const layouts = resources.add(
		new BrowserKeyboardLayoutService({ navigator: {} as Navigator, operatingSystem: OperatingSystem.Windows }),
	);
	const keybindings = resources.add(
		new WorkbenchKeybindingService(
			{
				ownerDocument: dom.window.document,
				commandService: commands,
				contextKeyService: contexts,
				keyboardLayoutService: layouts,
			},
			resources.add(new TestNotificationService()),
			profiles.files,
			profiles.profiles,
		),
	);
	services.registerInstance(IKeybindingService, keybindings);
	await commands.executeCommand('agentsVoice.pushToTalk');
	assert.equal(controls.length, 0);
	for (const end of ['keyup', 'blur']) {
		controls.length = 0;
		dom.window.document.body.dispatchEvent(
			new dom.window.KeyboardEvent('keydown', {
				key: ' ',
				code: 'Space',
				ctrlKey: true,
				shiftKey: true,
				bubbles: true,
			}),
		);
		dom.window.document.body.dispatchEvent(
			new dom.window.KeyboardEvent('keydown', {
				key: ' ',
				code: 'Space',
				ctrlKey: true,
				shiftKey: true,
				repeat: true,
				bubbles: true,
			}),
		);
		assert.equal(controls.filter(control => control.type === 'hold').length, 1);
		const id = controls[0]!.id;
		if (end === 'blur') dom.window.dispatchEvent(new dom.window.Event('blur'));
		else
			dom.window.document.body.dispatchEvent(
				new dom.window.KeyboardEvent('keyup', {
					key: ' ',
					code: 'Space',
					ctrlKey: true,
					shiftKey: true,
					bubbles: true,
				}),
			);
		for (let i = 0; i < 12; i++) await Promise.resolve();
		assert.ok(controls.some(control => control.type === 'release' && control.id === id));
		assert.ok(controls.every(control => control.id === id));
	}
});
