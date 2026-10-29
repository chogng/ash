import { IExtensionService } from '../../../src/ash/workbench/services/extensions/common/extensionService.js';
import { ChatAttachmentsContentPart } from '../../../src/ash/workbench/contrib/chat/browser/widget/chatContentParts/chatAttachmentsContentPart.js';
import { ChatResponseResourceFileSystemProvider, IChatResponseResourceFileSystemProvider } from '../../../src/ash/workbench/contrib/chat/common/widget/chatResponseResourceFileSystemProvider.js';
import { IAgentThreadService } from '../../../src/ash/platform/agentHost/common/agentService.js';
import { IEditorService } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import { AccessibleViewRegistry } from '../../../src/ash/platform/accessibility/browser/accessibleViewRegistry.js';
import { AccessibleViewType } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../src/ash/workbench/services/configuration/test/common/testServices.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { registerTestComponentServices, createTestFileService } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import { IFileService } from '../../../src/ash/platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../src/ash/platform/files/common/inMemoryFilesystemProvider.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { MainThreadClientEditors } from '../../../src/ash/workbench/api/browser/mainThreadClientEditors.js';
import { loadExtensionEditorModule } from '../../../src/ash/workbench/services/extensions/browser/extensionEditorModules.js';
import { IExtensionApi, normalizeExtensionCatalog } from '../../../src/ash/platform/extensions/common/extensionApi.js';
import { ExtensionResourceLoaderService } from '../../../src/ash/platform/extensionResourceLoader/browser/extensionResourceLoaderService.js';
import { IExtensionHostApi, type ExtensionHostFleetSnapshot } from '../../../src/ash/platform/agentHost/common/extensionHostApi.js';
import { EditorPanes } from '../../../src/ash/workbench/browser/editor.js';
import type { EditorPane } from '../../../src/ash/workbench/browser/parts/editor/editorPane.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import editorMessages from '../../../extensions/language-pack-zh-cn/translations/editor.json' with { type: 'json' };
import workbenchMessages from '../../../extensions/language-pack-zh-cn/translations/workbench.json' with { type: 'json' };
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import '../../../src/ash/base/browser/ui/button/button.css';
import '../../../src/ash/base/browser/ui/toolbar/toolbar.css';
import { bindTestColorTheme } from '../../fixtures/browser/themeFixture.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { darkColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';

const locale = new URLSearchParams(location.search).get('locale') ?? 'en';
setNlsMessages(locale, locale === 'zh-CN' ? { ash: { ...editorMessages.ash, ...workbenchMessages.ash } } : {});
const services = new InstantiationService();
const memory = new InMemoryFileSystemProvider();
const files = createTestFileService(memory);
services.registerInstance(IFileService, files);
registerTestComponentServices(services);
services.registerInstance(IConfigurationService, new TestConfigurationService());
const theme = bindTestColorTheme(services.get(IThemeService), document.body);
const uri = URI.file('/fixture/paper.pdf');
await memory.createDirectory(URI.file('/fixture'));
const bytes = new Uint8Array(await (await fetch('/__pdf_bytes')).arrayBuffer());
await memory.writeFile(uri, bytes, { create: true, overwrite: true });
const resources = new ExtensionResourceLoaderService(async request => {
	const response = await fetch(`/__pdf_resource?generation=${request.generation}&path=${encodeURIComponent(request.path)}`);
	if (!response.ok) throw new Error('PDF package resource unavailable');
	return new Uint8Array(await response.arrayBuffer());
});
let enabled = false;
const packages: IExtensionApi = {
	list: async (_mode, options) => {
		const response = await fetch('/__pdf_catalog');
		const catalog = normalizeExtensionCatalog(await response.json());
		return enabled || options?.includeDisabled ? catalog : { ...catalog, extensions: [] };
	},
	resources,
};
services.registerInstance(IExtensionService, {
	getExtensionPointContributions: () => [],
} as unknown as IExtensionService);
services.registerInstance(IExtensionApi, packages);
services.registerInstance(IExtensionHostApi, {
	invoke: async (request, signal) => {
		const response = await fetch('/__pdf_invoke', {
			method: 'POST',
			signal,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(request.payload),
		});
		if (!response.ok) throw new Error('PDF provider request failed');
		return response.json();
	},
} as IExtensionHostApi);
const bridge = services.createInstance(MainThreadClientEditors, 30000, loadExtensionEditorModule);
const responseFiles = new ChatResponseResourceFileSystemProvider();
services.registerInstance(IChatResponseResourceFileSystemProvider, responseFiles);
services.registerInstance(IAgentThreadService, {} as IAgentThreadService);
services.registerInstance(IEditorService, {} as IEditorService);
let chat: ChatAttachmentsContentPart | undefined;
let pane: EditorPane | undefined;
const container = document.getElementById('viewer')!;
window.pdfExtensionTest = {
	available: () => EditorPanes.getEditorPanesForInput({ resource: uri }).some(pane => pane.id === 'ash.workbench.pdfViewer'),
	async enable(value: boolean) {
		enabled = value;
		const response = await fetch(`/__pdf_extension?locale=${locale}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ enabled: value }),
		});
		await bridge.update((await response.json()) as ExtensionHostFleetSnapshot);
	},
	async open(readOnly = false) {
		pane?.dispose();
		container.replaceChildren();
		const input = { resource: uri, readOnly };
		const descriptor = EditorPanes.getEditorPane(input);
		if (!descriptor) throw new Error('No admitted PDF extension');
		pane = await descriptor.create({ input, instantiationService: services });
		pane.create(container);
		pane.setVisible(true);
		await pane.setInput(input, new AbortController().signal);
	},
	async verbosity(enabled: boolean) {
		await services.get(IConfigurationService).updateValue('accessibility.verbosity.resourceEditor', enabled);
	},
	setTheme(theme: 'dark' | 'hcDark' | 'hcLight') {
		(services.get(IThemeService) as TestThemeService).setColorTheme(theme === 'hcDark' ? highContrastDarkColorTheme : theme === 'hcLight' ? highContrastLightColorTheme : darkColorTheme);
	},
	previewChat() {
		chat?.dispose();
		pane?.dispose();
		pane = undefined;
		chat = services.createInstance(ChatAttachmentsContentPart, {
			ownerDocument: document,
			variables: [
				{
					type: 'resource',
					resource: uri,
					name: 'paper.pdf',
					presentation: 'document',
					mimeType: 'application/pdf',
				},
			],
			readResource: async () => new Blob([bytes], { type: 'application/pdf' }),
		});
		container.replaceChildren(chat.domNode);
	},
	accessible(help = false) {
		return AccessibleViewRegistry.getImplementations()
			.filter(item => item.name.startsWith('resource-editor-') && item.type === (help ? AccessibleViewType.Help : AccessibleViewType.View))
			.map(item => item.getProvider(services)?.provideContent() ?? '')
			.join('');
	},
	async saved() {
		try {
			return JSON.parse(new TextDecoder().decode((await memory.readFile(URI.file('/fixture/paper.pdf.ash-annotations.json'))).bytes));
		} catch {
			return undefined;
		}
	},
	async unchanged() {
		return String((await memory.readFile(uri)).bytes) === String(bytes);
	},
	close() {
		chat?.dispose();
		chat = undefined;
		pane?.dispose();
		pane = undefined;
		container.replaceChildren();
	},
	dispose() {
		chat?.dispose();
		pane?.dispose();
		responseFiles.dispose();
		bridge.dispose();
		theme.dispose();
		services.dispose();
		files.dispose();
		memory.dispose();
	},
};

declare global {
	interface Window {
		pdfExtensionTest: {
			setTheme(theme: 'dark' | 'hcDark' | 'hcLight'): void;
			accessible(help?: boolean): string;
			verbosity(enabled: boolean): Promise<void>;
			previewChat(): void;
			available(): boolean;
			enable(value: boolean): Promise<void>;
			open(readOnly?: boolean): Promise<void>;
			saved(): Promise<{ annotations: unknown[] } | undefined>;
			unchanged(): Promise<boolean>;
			close(): void;
			dispose(): void;
		};
	}
}
