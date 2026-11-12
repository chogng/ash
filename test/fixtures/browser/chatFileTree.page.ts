import { languagePackCatalog as chineseCatalog } from '../../../.build/desktop/localization/localizationCatalog.zh-CN.js';
import '../../../src/ash/platform/theme/common/sizes/baseSizes.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { CommandsRegistry } from '../../../src/ash/platform/commands/common/commands.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { IAgentThreadService } from '../../../src/ash/platform/agentHost/common/agentService.js';
import type { ChatContentPart } from '../../../src/ash/platform/agentHost/common/agent.js';
import { IClipboardService } from '../../../src/ash/platform/clipboard/common/clipboardService.js';
import { INotificationService } from '../../../src/ash/platform/notification/common/notification.js';
import { FileService } from '../../../src/ash/platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../src/ash/platform/files/common/inMemoryFilesystemProvider.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { lightColorTheme, darkColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { bindTestColorTheme } from './themeFixture.js';
import { IEditorService } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import { ChatResourceGroupWidget } from '../../../src/ash/workbench/contrib/chat/browser/widget/chatContentParts/chatResourceGroupWidget.js';
import { ChatResponseResourceFileSystemProvider, IChatResponseResourceFileSystemProvider } from '../../../src/ash/workbench/contrib/chat/common/widget/chatResponseResourceFileSystemProvider.js';
import { registerChatFileTreeActions } from '../../../src/ash/workbench/contrib/chat/browser/actions/chatFileTreeActions.js';
import { IChatWidgetService, type IChatWidget, type IChatWidgetService as WidgetService } from '../../../src/ash/workbench/contrib/chat/browser/chat.js';
import type { IChatListItem } from '../../../src/ash/workbench/contrib/chat/common/model/chatViewModel.js';
import { setNlsMessages } from '../../../src/ash/nls.js';

if (new URLSearchParams(location.search).has('zh')) setNlsMessages('zh-CN', chineseCatalog.bundles);
const resources = new DisposableStore();
const services = resources.add(new InstantiationService());
const files = resources.add(new FileService());
const provider = resources.add(new InMemoryFileSystemProvider());
resources.add(files.registerProvider('file', provider));
await files.createDirectory(URI.file('/workspace/src'));
await files.writeFile({ resource: URI.file('/workspace/src/main.ts'), content: 'const captured = 1;' }, { create: true, overwrite: false });
let reads = 0;
const read = provider.readFile.bind(provider);
provider.readFile = async resource => { reads++; return read(resource); };
services.registerInstance(IEditorService, {
	openEditor: async (input: { resource: URI; }) => { document.querySelector('#opened')!.textContent = (await files.readFile(input.resource)).content; },
} as unknown as IEditorService);
services.registerInstance(IAgentThreadService, { readToolResource: async () => { throw new Error('The tree must use captured bytes'); } } as unknown as IAgentThreadService);
const snapshots = resources.add(new ChatResponseResourceFileSystemProvider());
services.registerInstance(IChatResponseResourceFileSystemProvider, snapshots);
const errors: string[] = [];
services.registerInstance(INotificationService, { error: (message: string) => errors.push(message) } as unknown as INotificationService);
services.registerInstance(IClipboardService, { writeText: async () => { } } as unknown as IClipboardService);
services.registerInstance(IConfigurationService, { getValue: () => false } as unknown as IConfigurationService);
const theme = resources.add(new TestThemeService(lightColorTheme));
resources.add(bindTestColorTheme(theme, document.body));
document.body.style.cssText = 'background:var(--ash-editor-background);color:var(--ash-foreground);font:var(--ash-fontSize-body) sans-serif';
const container = document.querySelector<HTMLElement>('main')!;
container.style.width = '320px';
const group = resources.add(services.createInstance(ChatResourceGroupWidget, document));
container.append(group.domNode);
let content: readonly ChatContentPart[] = [];
const item = (): IChatListItem => ({ id: 'result', type: 'toolResult', content, text: '', transient: false });
const widget = {
	visible: true, domNode: container, get model() { return { items: [item()] }; }, getFocus: () => item(),
	reveal: () => { }, getFileTreeInfosForResponse: () => group.getFileTreeInfos(), getLastFocusedFileTreeForResponse: () => group.getLastFocusedFileTree(),
} as unknown as IChatWidget;
services.registerInstance(IChatWidgetService, { lastFocusedWidget: widget } as WidgetService);
registerChatFileTreeActions();
declare global {
	interface Window {
		chatFileTreeFixture: {
			render(json: readonly string[]): void;
			navigate(reverse?: boolean): Promise<void>;
			state(): { reads: number; errors: readonly string[]; };
			setTheme(theme: string): void;
			dispose(): void;
		};
	}
}
window.chatFileTreeFixture = {
	render: json => {
		content = json.map((json, index) => ({ type: 'artifact', artifact: { source: { type: 'structuredResult' }, mimeType: 'application/json', data: { type: 'json', json }, contentDigest: `sha256:${index}:${json.length}`, truncated: false } }));
		group.render(content, 'source');
	},
	navigate: async reverse => { await services.invokeFunction(CommandsRegistry.getCommand(reverse ? 'workbench.action.chat.previousFileTree' : 'workbench.action.chat.nextFileTree')!); },
	state: () => ({ reads, errors }),
	setTheme: value => theme.setColorTheme(value === 'dark' ? darkColorTheme : value === 'hc' ? highContrastDarkColorTheme : value === 'hcLight' ? highContrastLightColorTheme : lightColorTheme),
	dispose: () => { group.dispose(); },
};
resources.add(toDisposable(() => { group.dispose(); }));
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
