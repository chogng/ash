import { IChatSpeechToTextService, ChatSpeechToTextService } from '../../../src/ash/workbench/contrib/chat/browser/speechToText/chatSpeechToTextService.js';
import { DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { VSBuffer } from '../../../src/ash/base/common/buffer.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import { Registry } from '../../../src/ash/platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../../src/ash/platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../src/ash/platform/configuration/common/inMemoryConfigurationService.js';
import { IContextKeyService, ContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../src/ash/platform/instantiation/common/serviceCollection.js';
import { IStorageService } from '../../../src/ash/platform/storage/common/storage.js';
import { IOpenerService } from '../../../src/ash/platform/opener/common/opener.js';
import { IEditorService } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import { ChatGPTService, IChatGPTService } from '../../../src/ash/sessions/contrib/chatgptweb/browser/chatGPTService.js';
import { ChatGPTNavigationView } from '../../../src/ash/sessions/contrib/chatgptweb/browser/chatGPTNavigationView.js';
import { ChatGPTWidget } from '../../../src/ash/sessions/contrib/chatgptweb/browser/chatGPTWidget.js';
import { IChatGPTTransport } from '../../../src/ash/sessions/contrib/chatgptweb/common/chatGPTTransport.js';
import { productLanguagePackCatalogs } from '../../../src/ash/workbench/services/localization/common/localizationCatalogs.js';
import { registerTestComponentServices } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import { IExtensionHostApi } from '../../../src/ash/platform/agentHost/common/extensionHostApi.js';
import { createDisconnectedExtensionHostApi } from '../../../src/ash/platform/agentHost/browser/extensionHostApi.js';
import { normalizeExtensionHostSnapshot } from '../../../src/ash/platform/agentHost/browser/extensionHostProtocol.js';
import { IAgentThreadService } from '../../../src/ash/platform/agentHost/common/agentService.js';
import { ChatResponseResourceFileSystemProvider, IChatResponseResourceFileSystemProvider } from '../../../src/ash/workbench/contrib/chat/common/widget/chatResponseResourceFileSystemProvider.js';
import { bindColorTheme } from '../../../src/ash/platform/theme/browser/themeStyles.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { IContextViewService } from '../../../src/ash/platform/contextview/browser/contextView.js';
import { BrowserContextViewService } from '../../../src/ash/platform/contextview/browser/contextViewService.js';
import { registerCodeEditorServices } from '../../../src/ash/editor/test/browser/testCodeEditor.js';
import { Event } from '../../../src/ash/base/common/event.js';
import { IDictationBackendService, type IDictationBackendService as DictationService } from '../../../src/ash/platform/renderer/common/dictation.js';
import { ISpeechService } from '../../../src/ash/workbench/contrib/speech/common/speechService.js';
import { SpeechService } from '../../../src/ash/workbench/contrib/speech/browser/speechService.js';
import { registerTestDictationOnboarding } from '../../../src/ash/workbench/test/common/testDictationServices.js';
import { IPreferencesService } from '../../../src/ash/workbench/services/preferences/common/preferences.js';
import type { ChatGPTVoiceConnection } from '../../../src/ash/sessions/contrib/chatgptweb/browser/chatGPTClient.js';

declare global {
	interface Window { ashChatGPTIntegration: { draft(): string; dictate(text: string, final: boolean): void; dictationStops(): number; setVisible(visible: boolean): void; connectVoicePeer(connection: ChatGPTVoiceConnection): Promise<void>; setMathEnabled(enabled: boolean): Promise<void>; setMathMacros(macros: Record<string, string>): Promise<void>; }; }
}

const parameters = new URLSearchParams(location.search);
const locale = parameters.get('locale') ?? 'zh-CN';
if (locale !== 'en') { setNlsMessages(locale, productLanguagePackCatalogs.find(catalog => catalog.locale === locale)!.bundles); }
const resources = new DisposableStore();
const themes = { light: lightColorTheme, dark: darkColorTheme, hcDark: highContrastDarkColorTheme, hcLight: highContrastLightColorTheme };
const theme = resources.add(new TestThemeService(themes[(parameters.get('theme') ?? 'dark') as keyof typeof themes]));
const requests = new Map<string, { controller: AbortController; reader?: ReadableStreamDefaultReader<Uint8Array>; }>();
const values = new Map<string, string>();
let widget: ChatGPTWidget;
let transcript: ((text: string, final: boolean) => void) | undefined;
let dictationStops = 0;
const dictation: DictationService | undefined = parameters.has('dictation') ? {
	onDidChangeAvailability: Event.None, getOptions: async () => ({ inputDevices: [], languages: [] }),
	start: async (_options, onTranscript, onEnded) => {
		transcript = onTranscript;
		return { stop: async () => { dictationStops++; onTranscript('final words', true); onEnded(); }, cancel: async () => { dictationStops++; onEnded(); } };
	},
} : undefined;
const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
configurationRegistry.registerConfiguration({ key: 'markdown.math.enabled', defaultValue: true, parse: value => Boolean(value) });
configurationRegistry.registerConfiguration({ key: 'markdown.math.macros', defaultValue: {}, parse: value => value });
const configuration = resources.add(new InMemoryConfigurationService());
if (dictation) await configuration.updateValue('dictation.backend', 'cloud');
const services = resources.add(new InstantiationService(new ServiceCollection(
	[IChatGPTTransport, {
		async request(id, request) {
			const controller = new AbortController();
			const pending = { controller, reader: undefined as ReadableStreamDefaultReader<Uint8Array> | undefined };
			requests.set(id, pending);
			const response = await fetch(request.path, { method: request.method, headers: request.headers, body: request.body instanceof VSBuffer ? new Uint8Array(request.body.buffer) : request.body, signal: controller.signal });
			pending.reader = response.body?.getReader();
			return { status: response.status, headers: Object.fromEntries(response.headers) };
		},
		async read(id) { const result = await requests.get(id)?.reader?.read(); return !result || result.done ? null : VSBuffer.wrap(new Uint8Array(result.value)); },
		async cancel(id) { const pending = requests.get(id); requests.delete(id); pending?.controller.abort(); await pending?.reader?.cancel().catch(() => { }); },
	} satisfies IChatGPTTransport],
	[IStorageService, {
		get: (key: string) => values.get(key),
		getBoolean: (key: string, _scope: number, fallback: boolean) => values.has(key) ? values.get(key) === 'true' : fallback,
		store: (key: string, value: unknown) => { values.set(key, String(value)); },
		remove: (key: string) => { values.delete(key); },
	} as unknown as IStorageService],
	[IExtensionHostApi, {
		...createDisconnectedExtensionHostApi(async () => { throw new Error('No host'); }),
		list: async () => {
			const response = await fetch('/__chat_math');
			if (!response.ok) { throw new Error('Math provider unavailable'); }
			return normalizeExtensionHostSnapshot(await response.json());
		},
		invoke: async (request, signal) => {
			const response = await fetch('/__chat_math', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request.payload), signal });
			if (!response.ok) { throw new Error('Math rendering failed'); }
			return response.json();
		},
	} satisfies IExtensionHostApi],
	[IConfigurationService, configuration],
	[IContextKeyService, resources.add(new ContextKeyService())],
	[IOpenerService, { open: async () => true } as unknown as IOpenerService],
	[IEditorService, { focusActiveEditor: () => widget.focus() } as unknown as IEditorService],
	[IAgentThreadService, {} as IAgentThreadService],
	[IThemeService, theme],
	[IContextViewService, resources.add(new BrowserContextViewService(document.body))],
	[IDictationBackendService, dictation],
	[IPreferencesService, { openSettings: async () => undefined } as unknown as IPreferencesService],
)));
services.registerSingleton(ISpeechService, () => services.createInstance(SpeechService));
if (!services.has(IChatSpeechToTextService)) services.registerSingleton(IChatSpeechToTextService, () => services.createInstance(ChatSpeechToTextService));
registerTestDictationOnboarding(services);
registerTestComponentServices(services);
registerCodeEditorServices(services);
resources.add(bindColorTheme(services.get(IThemeService), document.body));
services.registerInstance(IChatResponseResourceFileSystemProvider, resources.add(new ChatResponseResourceFileSystemProvider()));
const chat = resources.add(services.createInstance(ChatGPTService));
services.registerInstance(IChatGPTService, chat);
window.ashChatGPTIntegration = {
	setMathEnabled: enabled => services.get(IConfigurationService).updateValue('markdown.math.enabled', enabled),
	setMathMacros: macros => services.get(IConfigurationService).updateValue('markdown.math.macros', macros),
	draft: () => chat.state.get().draft,
	dictate: (text, final) => transcript?.(text, final),
	dictationStops: () => dictationStops,
	setVisible: visible => widget.setVisible(visible),
	connectVoicePeer: async connection => {
		const { ChatGPTVoiceSession } = await import('../../../src/ash/sessions/contrib/chatgptweb/browser/chatGPTVoiceSession.js');
		const media = resources.add(new ChatGPTVoiceSession(window, () => { }, error => { if (error) { console.error(error); } }));
		await media.connect(connection, new AbortController().signal);
	},
};
widget = resources.add(services.createInstance(ChatGPTWidget, document.getElementById('editor')!));
const host = document.getElementById('navigation')!;
const view = resources.add(services.createInstance(ChatGPTNavigationView, host, { id: 'chatgpt-navigation-fixture', title: 'ChatGPT' }));
view.setVisible(true);
const resize = new ResizeObserver(() => view.layout(host.clientHeight, 0, host.clientWidth));
resize.observe(host);
resources.add(toDisposable(() => resize.disconnect()));
chat.initialize();
if (parameters.has('focus')) { widget.focus(); }
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
