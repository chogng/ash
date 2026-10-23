import { registerTestCodeEditorFeatures } from '../../../../../../../../test/fixtures/codeEditorFeatures.js';
const codeFeatures = registerTestCodeEditorFeatures();
import '../../../../../../editor/editor.all.js';
import '../../../browser/url.contribution.js';
import { renderMarkdown, type IRenderedMarkdown } from '../../../../../../base/browser/markdownRenderer.js';
import { addDisposableListener } from '../../../../../../base/browser/dom.js';
import { DisposableStore, MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { OpenerService } from '../../../../../../editor/browser/services/openerService.js';
import { StandaloneServiceCollection } from '../../../../../../editor/standalone/browser/standaloneServices.js';
import { ITextModelService } from '../../../../../../editor/common/services/resolverService.js';
import { setNlsMessages } from '../../../../../../nls.js';
import { IClipboardService } from '../../../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { IDialogService } from '../../../../../../platform/dialogs/common/dialogs.js';
import { FileService } from '../../../../../../platform/files/common/fileService.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { getSingletonServiceDescriptors } from '../../../../../../platform/instantiation/common/extensions.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../../../platform/quickinput/common/quickInput.js';
import { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { bindTestColorTheme } from '../../../../../../../../test/fixtures/browser/themeFixture.js';
import { darkColorTheme, highContrastDarkColorTheme, lightColorTheme } from '../../../../../../platform/theme/common/colorTheme.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { TestThemeService } from '../../../../../../platform/theme/test/common/testThemeService.js';
import { IUriIdentityService } from '../../../../../../platform/uriIdentity/common/uriIdentity.js';
import { UriIdentityService } from '../../../../../../platform/uriIdentity/common/uriIdentityService.js';
import { BrowserDialogHandler } from '../../../../../browser/parts/dialogs/dialog.js';
import { DialogHandlerContribution } from '../../../../../browser/parts/dialogs/dialog.web.contribution.js';
import { TextResourceEditor } from '../../../../../browser/parts/editor/textResourceEditor.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../../common/contributions.js';
import { openChatMarkdownLink } from '../../../../chat/browser/widget/chatWidget.js';
import { ITrustedDomainService } from '../../../common/trustedDomainService.js';
import { DialogService } from '../../../../../services/dialogs/common/dialogService.js';
import { CommandService } from '../../../../../services/commands/common/commandService.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import chineseMessages from '../../../../../../../../extensions/language-pack-zh-cn/translations/workbench.json' with { type: 'json' };
import { TestNotificationService } from '../../../../../../../../test/fixtures/browser/notificationFixture.js';
import { TestQuickInputService } from '../../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import { BrowserStorageService } from '../../../../../services/storage/browser/storageService.js';
import { BrowserTextModelService } from '../../../../../services/textmodelResolver/browser/browserTextModelService.js';
import { IFileTextModelService, ITextModelResourceService } from '../../../../../services/textmodelResolver/common/textModelResourceService.js';
import { TextModelResolverService } from '../../../../../services/textmodelResolver/common/textModelResolverService.js';
import { getBrowserTextResourceStore } from '../../../../codeEditor/browser/browserTextResourceStore.js';
import { TextFileService } from '../../../../../services/textfile/browser/textFileService.js';
import { FilesConfigurationService, IFilesConfigurationService } from '../../../../../services/filesConfiguration/common/filesConfigurationService.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { TestWorkspaceService } from '../../../../../services/configuration/test/common/testServices.js';
import { registerTestComponentServices } from '../../../../../test/common/testEditorServices.js';

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
services.registerInstance(INotificationService, resources.add(new TestNotificationService()));
const dialogs = resources.add(new DialogService());
services.registerInstance(IDialogService, dialogs);
resources.add(new DialogHandlerContribution(dialogs.model, new BrowserDialogHandler(document.body)));
const copied: string[] = [];
services.registerInstance(IClipboardService, { writeText: async (value: string) => { copied.push(value); } } as IClipboardService);
services.registerInstance(IQuickInputService, resources.add(new TestQuickInputService({ instantiationService: services, container: document.body, contextKeyService: services.get(IContextKeyService) })));
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
resources.add(bindTestColorTheme(theme, document.body));
services.registerInstance(IWorkspaceContextService, resources.add(new TestWorkspaceService({ id: 'url-integration', folders: [] })));
registerTestComponentServices(services);
services.registerInstance(IFilesConfigurationService, resources.add(services.createInstance(FilesConfigurationService)));
const textFiles = resources.add(services.createInstance(TextFileService));
const store = getBrowserTextResourceStore(textFiles);
const models = resources.add(services.createInstance(BrowserTextModelService, store, {}));
services.registerInstance(ITextModelResourceService, models);
services.registerInstance(IFileTextModelService, models);
services.registerSingleton(ITextModelService, () => services.createInstance(TextModelResolverService));
const editor = resources.add(services.createInstance(TextResourceEditor, store, { onSaveError: () => { } }));
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
const markdown = resources.add(new MutableDisposable<IRenderedMarkdown>());
function setLink(target: string): void {
	const rendered = renderMarkdown({ value: `[Chat documentation](${target})` }, {
		ownerDocument: document,
		actionHandler: href => { void openChatMarkdownLink(href, opener, services.get(IEditorService)); }
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
