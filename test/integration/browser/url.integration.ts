import '../../../src/ash/editor/editor.all.js';
import '../../../src/ash/workbench/contrib/url/browser/url.contribution.js';
import { MarkdownElement } from '../../../src/ash/base/browser/markdownRenderer.js';
import { addDisposableListener } from '../../../src/ash/base/browser/dom.js';
import { DisposableStore, MutableDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { OpenerService } from '../../../src/ash/editor/browser/services/openerService.js';
import { StandaloneServiceCollection } from '../../../src/ash/editor/standalone/browser/standaloneServices.js';
import { ITextModelService } from '../../../src/ash/editor/common/services/resolverService.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import { IClipboardService } from '../../../src/ash/platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { IContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { IDialogService } from '../../../src/ash/platform/dialogs/common/dialogs.js';
import { FileService } from '../../../src/ash/platform/files/common/fileService.js';
import { IFileService } from '../../../src/ash/platform/files/common/files.js';
import { getSingletonServiceDescriptors } from '../../../src/ash/platform/instantiation/common/extensions.js';
import { INotificationService } from '../../../src/ash/platform/notification/common/notification.js';
import { IOpenerService } from '../../../src/ash/platform/opener/common/opener.js';
import { IQuickInputService } from '../../../src/ash/platform/quickinput/common/quickInput.js';
import { IStorageService } from '../../../src/ash/platform/storage/common/storage.js';
import { bindColorTheme } from '../../../src/ash/platform/theme/browser/themeStyles.js';
import { darkColorTheme, highContrastDarkColorTheme, lightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { IUriIdentityService } from '../../../src/ash/platform/uriIdentity/common/uriIdentity.js';
import { UriIdentityService } from '../../../src/ash/platform/uriIdentity/common/uriIdentityService.js';
import { BrowserDialogHandler } from '../../../src/ash/workbench/browser/parts/dialogs/dialog.js';
import { DialogHandlerContribution } from '../../../src/ash/workbench/browser/parts/dialogs/dialog.web.contribution.js';
import { TextResourceEditor } from '../../../src/ash/workbench/browser/parts/editor/textResourceEditor.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../src/ash/workbench/common/contributions.js';
import { openChatMarkdownLink } from '../../../src/ash/workbench/contrib/chat/browser/widget/chatWidget.js';
import { ITrustedDomainService } from '../../../src/ash/workbench/contrib/url/common/trustedDomainService.js';
import { DialogService } from '../../../src/ash/workbench/services/dialogs/common/dialogService.js';
import { CommandService } from '../../../src/ash/workbench/services/commands/common/commandService.js';
import { IEditorService } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import chineseMessages from '../../../extensions/language-pack-zh-cn/translations/workbench.json' with { type: 'json' };
import { NotificationService } from '../../../src/ash/workbench/services/notification/common/notificationService.js';
import { WorkbenchQuickInputService } from '../../../src/ash/workbench/services/quickinput/browser/quickInputService.js';
import { BrowserStorageService } from '../../../src/ash/workbench/services/storage/browser/storageService.js';
import { BrowserTextModelService } from '../../../src/ash/workbench/services/textmodelResolver/browser/browserTextModelService.js';
import { IFileTextModelService, ITextModelResourceService } from '../../../src/ash/workbench/services/textmodelResolver/common/textModelResourceService.js';
import { TextModelResolverService } from '../../../src/ash/workbench/services/textmodelResolver/common/textModelResolverService.js';
import { getBrowserTextResourceStore } from '../../../src/ash/workbench/contrib/codeEditor/browser/browserTextResourceStore.js';
import { TextFileService } from '../../../src/ash/workbench/services/textfile/browser/textFileService.js';
import { FilesConfigurationService, IFilesConfigurationService } from '../../../src/ash/workbench/services/filesConfiguration/common/filesConfigurationService.js';
import { IWorkspaceContextService } from '../../../src/ash/platform/workspace/common/workspace.js';
import { WorkspaceContextService } from '../../../src/ash/workbench/services/workspaces/browser/workspaceContextService.js';
import { registerTestComponentServices } from '../../../src/ash/workbench/test/common/testEditorServices.js';

declare global {
	interface Window {
		ashURLIntegration: {
			readonly opened: readonly string[];
			readonly contributed: readonly string[];
			readonly copied: readonly string[];
			readonly content: string;
			readonly editorText: string;
			link(target: string): void;
			edit(content: string): void;
			setTheme(index: number): void;
			setChinese(): void;
			disposeContribution(): void;
		};
	}
}

const resources = new DisposableStore();
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
const base = resources.add(new StandaloneServiceCollection({}));
const services = resources.add(base.createChild());
services.registerInstance(ICommandService, resources.add(new CommandService(services)));
const files = resources.add(new FileService());
services.registerInstance(IFileService, files);
services.registerInstance(IUriIdentityService, resources.add(services.createInstance(UriIdentityService)));
const storage = resources.add(new BrowserStorageService({ ownerWindow: window, workspaceId: 'url-integration', flushInterval: 0 }));
services.registerInstance(IStorageService, storage);
services.registerInstance(INotificationService, resources.add(new NotificationService()));
const dialogs = resources.add(new DialogService());
services.registerInstance(IDialogService, dialogs);
resources.add(new DialogHandlerContribution(dialogs.model, new BrowserDialogHandler(document.body)));
const copied: string[] = [];
services.registerInstance(IClipboardService, { writeText: async (value: string) => { copied.push(value); } } as IClipboardService);
services.registerInstance(IQuickInputService, resources.add(new WorkbenchQuickInputService({ container: document.body, contextKeyService: services.get(IContextKeyService) })));
const opener = resources.add(services.createInstance(OpenerService));
services.registerInstance(IOpenerService, opener);
const opened: string[] = [];
const contributed: string[] = [];
opener.setDefaultExternalOpener({ openExternal: async target => { opened.push(target); return true; } });
// OS launch is the observable boundary; no synthetic link leaves the test browser.
resources.add(opener.registerExternalOpener({ openExternal: async target => { contributed.push(target); return true; } }));
const themes = [darkColorTheme, lightColorTheme, highContrastDarkColorTheme];
const theme = resources.add(new TestThemeService(darkColorTheme));
services.registerInstance(IThemeService, theme);
resources.add(bindColorTheme(theme, document.body));
services.registerInstance(IWorkspaceContextService, resources.add(new WorkspaceContextService({ id: 'url-integration', folders: [] })));
registerTestComponentServices(services);
services.registerInstance(IFilesConfigurationService, resources.add(services.createInstance(FilesConfigurationService)));
const textFiles = resources.add(services.createInstance(TextFileService));
const store = getBrowserTextResourceStore(textFiles);
const models = resources.add(services.createInstance(BrowserTextModelService, store, {}));
services.registerInstance(ITextModelResourceService, models);
services.registerInstance(IFileTextModelService, models);
services.registerSingleton(ITextModelService, () => services.createInstance(TextModelResolverService));
const editor = resources.add(services.createInstance(TextResourceEditor, store, { onSaveError: () => false }));
editor.create(document.querySelector<HTMLElement>('#editor')!);
editor.layout({ width: 900, height: 280 });
services.registerInstance(IEditorService, {
	openEditor: async input => {
		await editor.setInput(input, new AbortController().signal);
		editor.focus();
	},
} as IEditorService);
const descriptor = getSingletonServiceDescriptors().find(([id]) => id === ITrustedDomainService)![1];
services.registerSingleton(ITrustedDomainService, () => services.createInstance(descriptor) as ITrustedDomainService);
const host = resources.add(WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['workbench.contrib.url']));
host.advance(WorkbenchPhase.BlockRestore);
const domains = services.get(ITrustedDomainService);
const markdown = resources.add(new MutableDisposable<MarkdownElement>());
function setLink(target: string): void {
	const rendered = new MarkdownElement({
		ownerDocument: document,
		markdown: { value: `[Chat documentation](${target})` },
		linkHandler: href => { void openChatMarkdownLink(href, opener, services.get(IEditorService)); },
	});
	markdown.value = rendered;
	document.querySelector('#chat-link')!.replaceChildren(rendered.element);
}
setLink('https://docs.example.test/guide?q=1#topic');
resources.add(addDisposableListener(document.querySelector('#manage')!, 'click', () => {
	void services.get(ICommandService).executeCommand('workbench.action.manageTrustedDomain');
}));
resources.add(addDisposableListener(document.querySelector('#open-url')!, 'click', () => {
	void services.get(ICommandService).executeCommand('workbench.action.url.openUrl');
}));
resources.add(addDisposableListener(document.querySelector('#save')!, 'click', () => {
	document.querySelector('#save-error')!.textContent = '';
	void editor.save().catch(error => { document.querySelector('#save-error')!.textContent = String(error.message); });
}));
window.ashURLIntegration = {
	opened, contributed, copied,
	get content() { return domains.content; },
	get editorText() { return editor.getValue(); },
	link: setLink,
	edit: content => { editor.getControl()!.getModel()!.setValue(content); },
	setTheme: index => theme.setColorTheme(themes[index]!),
	setChinese: () => {
		setNlsMessages('zh-CN', chineseMessages);
	},
	disposeContribution: () => host.dispose(),
};
