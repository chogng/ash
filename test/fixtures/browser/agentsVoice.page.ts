import '../../../src/ash/base/browser/ui/styles.css';
import '../../../src/ash/workbench/browser/media/style.css';
import { Event, Emitter } from '../../../src/ash/base/common/event.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { DeferredPromise } from '../../../src/ash/base/common/async.js';
import { h } from '../../../src/ash/base/browser/dom.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import translations from '../../../extensions/language-pack-zh-cn/translations/chat.json' with { type: 'json' };
import { IAgentVoiceService, type IAgentVoiceService as AgentVoiceService } from '../../../src/ash/platform/agentHost/common/agentService.js';
import { type AgentVoiceSessionState, type ThreadTranscriptSnapshot, type ThreadTranscriptUpdateEnvelope } from '../../../src/ash/platform/agentHost/common/agent.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../src/ash/platform/instantiation/common/serviceCollection.js';
import { getSingletonServiceDescriptors } from '../../../src/ash/platform/instantiation/common/extensions.js';
import { IContextKeyService, ContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../src/ash/platform/configuration/common/inMemoryConfigurationService.js';
import { IStorageService } from '../../../src/ash/platform/storage/common/storage.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { lightColorTheme, darkColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { bindTestColorTheme } from './themeFixture.js';
import { BrowserStorageService } from '../../../src/ash/workbench/services/storage/browser/storageService.js';
import { IAuxiliaryWindowService, BrowserAuxiliaryWindowService } from '../../../src/ash/workbench/services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { IChatService } from '../../../src/ash/workbench/services/chat/common/chatService.js';
import { IChatSessionNavigationService } from '../../../src/ash/workbench/services/chat/common/chatSessionNavigationService.js';
import { IQuickInputService } from '../../../src/ash/platform/quickinput/common/quickInput.js';
import { QuickInputService } from '../../../src/ash/platform/quickinput/browser/quickInputService.js';
import { IContextMenuService } from '../../../src/ash/platform/contextview/browser/contextView.js';
import { ILayoutService, BrowserLayoutService } from '../../../src/ash/platform/layout/browser/layoutService.js';
import { INotificationService } from '../../../src/ash/platform/notification/common/notification.js';
import { TestNotificationService } from './notificationFixture.js';
import { CommandService } from '../../../src/ash/workbench/services/commands/common/commandService.js';
import { AccessibleViewRegistry } from '../../../src/ash/platform/accessibility/browser/accessibleViewRegistry.js';
import { AccessibleViewType } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { IAgentsVoiceWindowService } from '../../../src/ash/workbench/contrib/agentsVoice/common/agentsVoice.js';

const parameters = new URLSearchParams(location.search);
if (parameters.get('locale') === 'zh-CN') { setNlsMessages('zh-CN', translations); document.documentElement.lang = 'zh-CN'; }
await import('../../../src/ash/workbench/contrib/agentsVoice/browser/agentsVoice.contribution.js');
const resources = new DisposableStore();
const collection = new ServiceCollection();
for (const [id, descriptor] of getSingletonServiceDescriptors()) if (id === IAgentsVoiceWindowService) collection.set(id, descriptor);
const services = resources.add(new InstantiationService(collection));
const root = h(document, 'main');
root.className = 'ash-workbench';
root.style.cssText = 'height:100vh;position:relative';
document.body.append(root);
const theme = resources.add(new TestThemeService(({ dark: darkColorTheme, hcDark: highContrastDarkColorTheme, hcLight: highContrastLightColorTheme } as const)[parameters.get('theme') as 'dark'] ?? lightColorTheme));
// Auxiliary windows mirror this stylesheet and share the Workbench root class.
resources.add(bindTestColorTheme(theme, root, '.ash-workbench'));
services.registerInstance(IThemeService, theme);
services.registerInstance(IStorageService, resources.add(new BrowserStorageService({ ownerWindow: window, workspaceId: 'voice-test', flushInterval: 0 })));
services.registerInstance(IContextKeyService, resources.add(new ContextKeyService()));
services.registerInstance(IConfigurationService, resources.add(new InMemoryConfigurationService()));
services.registerInstance(ILayoutService, resources.add(new BrowserLayoutService({ root })));
services.registerInstance(IContextMenuService, {
	contextMenuStyle: 'custom', onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None,
	showContextMenu() { throw new Error('Unexpected Quick Input context menu'); }, hideContextMenu() { },
});
services.registerInstance(IQuickInputService, resources.add(services.createInstance(QuickInputService)));
services.registerInstance(IAuxiliaryWindowService, resources.add(services.createInstance(BrowserAuxiliaryWindowService, window, root)));
const notifications = resources.add(new TestNotificationService());
services.registerInstance(INotificationService, notifications);
const changed = resources.add(new Emitter<void>());
const updates = resources.add(new Emitter<ThreadTranscriptUpdateEnvelope>());
let state: AgentVoiceSessionState | undefined = parameters.has('connected') ? {
	sessionId: 'session', threadId: 'thread', resourceId: 'media', mediaEpoch: 1, sequence: 1, state: 'connected', inputMode: 'openMic' as const, muted: false, listening: true, inputSequence: 0, usageMilliseconds: 0,
} : undefined;
const controls: string[] = [];
const voice: AgentVoiceService = {
	isAvailable: true, get state() { return state; }, onDidChange: changed.event, onDidRequestTask: Event.None,
	getOptions: async () => [], start: async () => { throw new Error('The floating window must use the original Chat controller to start.'); },
	stop: async () => { controls.push('stop'); if (state) state = { ...state, state: 'ended' }; changed.fire(); },
	setMuted: async muted => { controls.push('mute:' + muted); if (state) state = { ...state, muted, listening: !muted && state.inputMode === 'openMic' }; changed.fire(); },
	setInputMode: async inputMode => { controls.push('mode:' + inputMode); if (state) state = { ...state, inputMode, listening: !state.muted && inputMode === 'openMic' }; changed.fire(); },
	pttDown: async () => { controls.push('hold'); if (state) state = { ...state, listening: true }; changed.fire(); },
	pttUp: async () => { controls.push('release'); if (state) state = { ...state, listening: false }; changed.fire(); },
	interrupt: async () => { controls.push('interrupt'); }, rejectTask: async () => { },
};
services.registerInstance(IAgentVoiceService, voice);
const navigations: string[] = [];
services.registerInstance(IChatSessionNavigationService, {
	revision: 0,
	getConversations: () => [{ sessionId: 'session', threadId: 'thread', title: 'Original Chat' }, { sessionId: 'second', threadId: 'second-thread', title: 'Other Chat' }],
	getActiveConversation: () => ({ sessionId: 'session', threadId: 'thread' }),
	openConversation: async (session, thread) => { navigations.push(`${session}/${thread}`); },
	startVoiceConversation: async () => { controls.push('startFromChat'); },
	appendToActiveDraft() { throw new Error('Do not change the Chat draft'); }, captureActiveDraft: async () => undefined,
});
let snapshot: ThreadTranscriptSnapshot = { sessionId: 'session', threadId: 'thread', revision: 0, durableSequence: 0, entries: [] };
const owners = new Set<object>();
let held: DeferredPromise<void> | undefined = parameters.has('hold') ? new DeferredPromise<void>() : undefined;
let acquisitions = 0;
let releases = 0;
services.registerInstance(IChatService, {
	onDidUpdateThreadTranscript: updates.event,
	subscribeThread: async (_session: string, _thread: string, _sequence: number, owner: object) => {
		const gate = held; held = undefined; acquisitions++;
		if (gate) await gate.p;
		owners.add(owner);
		return { transcript: snapshot };
	},
	unsubscribeThread: async (_session: string, _thread: string, owner: object) => { owners.delete(owner); releases++; },
	readThread: async () => ({ transcript: snapshot }),
} as unknown as IChatService);
const commands = resources.add(new CommandService(services));
const open = h(document, 'button');
open.textContent = 'Open voice window';
root.append(open);
const gate = held;
open.addEventListener('click', () => { void commands.executeCommand('_agentsVoice.openWindow'); });

declare global {
	interface Window {
		ashAgentsVoice: {
			controls(): readonly string[];
			navigations(): readonly string[];
			owners(): { acquisitions: number; releases: number; active: number; };
			update(text: string, revision?: number): void;
			release(): void;
			close(): void;
			help(): { help: string; view: string; };
			notifications(): readonly string[];
		};
	}
}
window.ashAgentsVoice = {
	controls: () => controls, navigations: () => navigations,
	owners: () => ({ acquisitions, releases, active: owners.size }),
	update: (text, revision = snapshot.revision + 1) => {
		const entry = {
			type: 'voiceTranscript' as const, entryId: 'speech', transcript: {
				itemId: 'speech', voiceSessionId: 'media', mediaEpoch: 1, speaker: 'user' as const, text, startMs: 0, endMs: 100, afterItemId: null,
			}
		};
		snapshot = { ...snapshot, revision, entries: [entry] };
		updates.fire({ ...snapshot, changes: [{ type: 'upsert', entry }] });
	},
	release: () => { void gate?.complete(); },
	close: () => services.get(IAgentsVoiceWindowService).closeWindow(),
	help: () => {
		const providers = AccessibleViewRegistry.getImplementations().filter(provider => provider.name.startsWith('agentsVoice-'));
		return {
			help: providers.find(provider => provider.type === AccessibleViewType.Help)?.getProvider(services)?.provideContent() ?? '',
			view: providers.find(provider => provider.type === AccessibleViewType.View)?.getProvider(services)?.provideContent() ?? '',
		};
	},
	notifications: () => notifications.model.getNotifications().map(notification => notification.message),
};
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
