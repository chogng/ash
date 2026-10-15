import { DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { VSBuffer } from '../../../src/ash/base/common/buffer.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../src/ash/platform/configuration/common/inMemoryConfigurationService.js';
import { IContextKeyService, ContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../src/ash/platform/instantiation/common/serviceCollection.js';
import { IStorageService } from '../../../src/ash/platform/storage/common/storage.js';
import { IOpenerService } from '../../../src/ash/platform/opener/common/opener.js';
import { IEditorService } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import { IAccessibleViewService } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { ChatGPTService, IChatGPTService } from '../../../src/ash/sessions/contrib/chatgptweb/browser/chatGPTService.js';
import { ChatGPTNavigationView } from '../../../src/ash/sessions/contrib/chatgptweb/browser/chatGPTNavigationView.js';
import { ChatGPTWidget } from '../../../src/ash/sessions/contrib/chatgptweb/browser/chatGPTWidget.js';
import { IChatGPTTransport } from '../../../src/ash/sessions/contrib/chatgptweb/common/chatGPTTransport.js';
import { productLanguagePackCatalogs } from '../../../src/ash/workbench/services/localization/common/localizationCatalogs.js';

setNlsMessages('zh-CN', productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!.bundles);
const resources = new DisposableStore();
const requests = new Map<string, { controller: AbortController; reader?: ReadableStreamDefaultReader<Uint8Array>; }>();
const values = new Map<string, string>();
let widget: ChatGPTWidget;
const services = resources.add(new InstantiationService(new ServiceCollection(
	[IChatGPTTransport, {
		async request(id, request) {
			const controller = new AbortController();
			const pending = { controller, reader: undefined as ReadableStreamDefaultReader<Uint8Array> | undefined };
			requests.set(id, pending);
			const response = await fetch(request.path, { method: request.method, headers: request.headers, body: request.body, signal: controller.signal });
			pending.reader = response.body?.getReader();
			return { status: response.status, headers: Object.fromEntries(response.headers) };
		},
		async read(id) { const result = await requests.get(id)?.reader?.read(); return !result || result.done ? null : VSBuffer.wrap(new Uint8Array(result.value)); },
		async cancel(id) { const pending = requests.get(id); requests.delete(id); pending?.controller.abort(); await pending?.reader?.cancel().catch(() => { }); },
	} satisfies IChatGPTTransport],
	[IStorageService, { get: (key: string) => values.get(key), store: (key: string, value: string) => { values.set(key, value); }, remove: (key: string) => { values.delete(key); } } as unknown as IStorageService],
	[IConfigurationService, resources.add(new InMemoryConfigurationService())],
	[IContextKeyService, resources.add(new ContextKeyService())],
	[IOpenerService, { open: async () => true } as unknown as IOpenerService],
	[IEditorService, { focusActiveEditor: () => widget.focus() } as unknown as IEditorService],
	[IAccessibleViewService, { show: () => true } as unknown as IAccessibleViewService],
)));
const chat = resources.add(services.createInstance(ChatGPTService));
services.registerInstance(IChatGPTService, chat);
widget = resources.add(services.createInstance(ChatGPTWidget, document.getElementById('editor')!));
const host = document.getElementById('navigation')!;
const view = resources.add(services.createInstance(ChatGPTNavigationView, host, { id: 'chatgpt-navigation-fixture', title: 'ChatGPT' }));
view.setVisible(true);
const resize = new ResizeObserver(() => view.layout(host.clientHeight, 0, host.clientWidth));
resize.observe(host);
resources.add(toDisposable(() => resize.disconnect()));
chat.initialize();
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
