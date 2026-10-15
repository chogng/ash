import { IWorkingCopyService } from '../../../src/ash/workbench/services/workingCopy/common/workingCopyService.js';
import { InMemoryWorkingCopyBackupService } from '../../../src/ash/workbench/services/workingCopy/common/workingCopyBackupService.js';
import { WorkingCopyBackupTracker } from '../../../src/ash/workbench/services/workingCopy/browser/workingCopyBackupTracker.js';
import { AuxiliaryBrowserTitlebarPart } from '../../../src/ash/workbench/browser/parts/titlebar/titlebarPart.js';
import { ILocalizationService } from '../../../src/ash/workbench/services/localization/common/localizationService.js';
import '../../../src/ash/sessions/common/configuration.js';
import '../../../src/ash/editor/editor.code.all.js';
import '../../../src/ash/workbench/browser/media/style.css';
import '../../../src/ash/workbench/contrib/codeEditor/browser/codeEditor.contribution.js';
import '../../../src/ash/workbench/contrib/themes/browser/themes.contribution.js';
import '../../../src/ash/workbench/contrib/themeEditor/browser/themeEditor.contribution.js';
import '../../../src/ash/workbench/contrib/accessibility/browser/accessibleViewActions.js';
import { WorkbenchKeybindingService } from '../../../src/ash/workbench/services/keybinding/browser/keybindingService.js';
import { BrowserKeyboardLayoutService } from '../../../src/ash/workbench/services/keybinding/browser/keyboardLayoutService.js';
import { IKeybindingService } from '../../../src/ash/platform/keybinding/common/keybinding.js';
import { ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { IContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { IUserDataProfileService } from '../../../src/ash/workbench/services/userDataProfile/common/userDataProfile.js';
import { UserDataProfileService } from '../../../src/ash/workbench/services/userDataProfile/browser/userDataProfileService.js';
import { createTestEditorServices, createTestFileService, createTestTextFileService } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import { registerCodeEditorServices } from '../../../src/ash/editor/test/browser/testCodeEditor.js';
import { MemoryFileService } from '../../../src/ash/workbench/contrib/bulkEdit/test/browser/bulkEditTestServices.js';
import { BrowserTextModelService } from '../../../src/ash/workbench/services/textmodelResolver/browser/browserTextModelService.js';
import { BrowserTextResourceStore } from '../../../src/ash/workbench/contrib/codeEditor/browser/browserTextResourceStore.js';
import { IFileTextModelService, ITextModelResourceService } from '../../../src/ash/workbench/services/textmodelResolver/common/textModelResourceService.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { Event } from '../../../src/ash/base/common/event.js';
import { DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { FileKind, IFileService, FileRevisionConflictError, type IFileSystemProvider, type IFileWriteOptions, type FileExistingTargetBehavior, type FileMissingTargetBehavior, type FileDeleteMode } from '../../../src/ash/platform/files/common/files.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { IWorkbenchThemeService } from '../../../src/ash/workbench/services/themes/common/workbenchThemeService.js';
import { IHostColorSchemeService } from '../../../src/ash/workbench/services/themes/common/hostColorSchemeService.js';
import { BrowserHostColorSchemeService } from '../../../src/ash/workbench/services/themes/browser/browserHostColorSchemeService.js';
import { WorkbenchThemeService, loadUserThemes } from '../../../src/ash/workbench/services/themes/browser/workbenchThemeService.js';
import { IUserThemeService } from '../../../src/ash/workbench/common/userThemes.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { TestConfigurationService as WorkbenchConfigurationService } from '../../../src/ash/workbench/services/configuration/test/common/testServices.js';
import { ITextFileService } from '../../../src/ash/workbench/services/textfile/common/textfiles.js';
import { IStorageService } from '../../../src/ash/platform/storage/common/storage.js';
import { IAccessibilityService } from '../../../src/ash/platform/accessibility/common/accessibility.js';
import { IAccessibleViewService } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { AccessibleViewService } from '../../../src/ash/workbench/contrib/accessibility/browser/accessibleView.js';
import { BrowserLayoutService, ILayoutService } from '../../../src/ash/platform/layout/browser/layoutService.js';
import { IFileDialogService, IDialogService, ConfirmResult } from '../../../src/ash/platform/dialogs/common/dialogs.js';
import { DialogService } from '../../../src/ash/workbench/services/dialogs/common/dialogService.js';
import { EditorPart } from '../../../src/ash/workbench/browser/parts/editor/editorPart.js';
import { EditorParts, IEditorPartsService } from '../../../src/ash/workbench/browser/parts/editor/editorParts.js';
import { BrowserAuxiliaryWindowService } from '../../../src/ash/workbench/services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { CommandsRegistry } from '../../../src/ash/platform/commands/common/commands.js';
import { ThemeEditor } from '../../../src/ash/workbench/contrib/themeEditor/browser/themeEditor.js';
import { localize, setNlsMessages } from '../../../src/ash/nls.js';
import { productLanguagePackCatalogs } from '../../../src/ash/workbench/services/localization/common/localizationCatalogs.js';
import { ExtensionColorThemeService } from '../../../src/ash/workbench/services/extensions/browser/extensionColorThemeService.js';
import { createBuiltinExtensionFixture } from './builtinExtensionsFixture.js';
import { TokenizationRegistry } from '../../../src/ash/editor/common/languages.js';

const locale = new URLSearchParams(location.search).get('locale');
if (locale) {
	const catalog = productLanguagePackCatalogs.find(item => item.locale === locale)!;
	setNlsMessages(locale, catalog.bundles);
}
const resources = new DisposableStore();
const extensions = resources.add(new ExtensionColorThemeService(createBuiltinExtensionFixture(), { subscribe: () => toDisposable(() => { }) }));
await extensions.start();
const resource = URI.file('/themes/aurora.json');
const initial = '// keep this comment\n{\n  "name": "Aurora",\n  "type": "dark",\n  "colors": { "editor.background": "#101525", "sideBar.background": "#151a25" },\n}\n';

/** Deterministic file boundary; the real theme and text-model services own parsing and writes. */
class ThemeFiles implements IFileSystemProvider {
	private readonly delegate = new MemoryFileService([
		[resource, initial],
		[URI.file('/themes/includes/base.json'), '{ "colors": { "input.foreground": "#112233" } }'],
	]);
	private readonly paths = new Set([resource.toString()]);
	public readonly capabilities = this.delegate.capabilities;
	public readonly onDidChangeCapabilities = Event.None;
	public readonly onDidChangeFiles = Event.None;
	public watch() { return toDisposable(() => { }); }
	public stat(uri: URI) { return this.delegate.stat(uri); }
	public readFile(uri: URI) { return this.delegate.readFile(uri); }
	public async readDirectory(uri: URI) {
		return [...this.paths].map(path => URI.parse(path)).filter(path => path.path.startsWith(uri.path + '/')).map(path => ({ resource: path, name: path.path.split('/').at(-1)!, kind: FileKind.File }));
	}
	public async writeFile(uri: URI, bytes: Uint8Array, options: IFileWriteOptions) {
		if (options.expectedRevision !== undefined && this.delegate.text(uri) !== options.expectedRevision) throw new FileRevisionConflictError(uri);
		const result = await this.delegate.writeFile(uri, bytes, options); this.paths.add(uri.toString()); return result;
	}
	public async createFile(uri: URI, existing: FileExistingTargetBehavior) { const result = await this.delegate.createFile(uri, existing); this.paths.add(uri.toString()); return result; }
	public createDirectory() { return this.delegate.createDirectory(); }
	public copy() { return this.delegate.copy(); }
	public async rename(from: URI, to: URI, existing: FileExistingTargetBehavior) { await this.delegate.rename(from, to, existing); this.paths.delete(from.toString()); this.paths.add(to.toString()); }
	public async delete(uri: URI, missing: FileMissingTargetBehavior, mode: FileDeleteMode) { await this.delegate.delete(uri, missing, mode); this.paths.delete(uri.toString()); }
}

const provider = new ThemeFiles();
const files = resources.add(createTestFileService(provider));
const configuration = resources.add(new WorkbenchConfigurationService());
const componentServices = resources.add(createTestEditorServices(configuration));
const services = resources.add(componentServices.createChild());
services.registerInstance(IFileService, files);
services.registerInstance(IDialogService, resources.add(new DialogService()));
const textFiles = resources.add(createTestTextFileService(files, configuration));
services.registerInstance(ITextFileService, textFiles);
services.registerInstance(IUserDataProfileService, new UserDataProfileService());
services.registerSingleton(IKeybindingService, () => resources.add(services.createInstance(WorkbenchKeybindingService, {
	ownerDocument: document,
	commandService: services.get(ICommandService),
	contextKeyService: services.get(IContextKeyService),
	keyboardLayoutService: resources.add(new BrowserKeyboardLayoutService({ navigator })),
})));
services.registerSingleton(IAccessibleViewService, () => services.createInstance(AccessibleViewService));
registerCodeEditorServices(services);
services.registerInstance(ILocalizationService, { whenReady: Promise.resolve(), translate: (_bundle, key, fallback) => localize(key, fallback) });
const store = new BrowserTextResourceStore(textFiles);
const models = resources.add(services.createInstance(BrowserTextModelService, store, {}));
services.registerInstance(IFileTextModelService, models);
services.registerInstance(ITextModelResourceService, models);
const backups = resources.add(new InMemoryWorkingCopyBackupService('theme-editor-integration'));
resources.add(new WorkingCopyBackupTracker(services.get(IWorkingCopyService), backups, window));
const root = document.querySelector<HTMLElement>('#main')!;
services.registerInstance(ILayoutService, resources.add(new BrowserLayoutService({ root })));
services.registerInstance(IHostColorSchemeService, resources.add(new BrowserHostColorSchemeService(window)));
const themes = resources.add(services.createInstance(WorkbenchThemeService, root));
services.registerInstance(IThemeService, themes);
services.registerInstance(IWorkbenchThemeService, themes);
themes.initialize();
const users = resources.add(await loadUserThemes(services, URI.file('/themes')));
services.registerInstance(IUserThemeService, users);
await themes.setColorTheme('aurora');
services.registerInstance(IFileDialogService, {
	pickFileToSave: async () => undefined, showSaveConfirm: async () => ConfirmResult.DONT_SAVE,
	showSaveDialog: async () => undefined, showOpenDialog: async () => undefined,
});
const editorOptions = { workingCopyService: services.get(IWorkingCopyService), fileService: files, textFileService: textFiles, configurationService: configuration, fileDialogService: services.get(IFileDialogService) };
const main = resources.add(services.createInstance(EditorPart, document.querySelector<HTMLElement>('#editors')!, editorOptions));
const windows = resources.add(services.createInstance(BrowserAuxiliaryWindowService, window, root));
const parts = resources.add(services.createInstance(EditorParts, main, windows, (container: HTMLElement) => {
	const part = services.createInstance(EditorPart, container, editorOptions);
	const titlebar = services.createInstance(AuxiliaryBrowserTitlebarPart, container, 'Ash Code', part, () => { }, 'actions-only');
	container.prepend(titlebar.container);
	return { titlebar, part };
}, services.get(IAccessibilityService), services.get(IStorageService)));
services.registerInstance(IEditorPartsService, parts);
root.style.height = '100vh';
root.style.background = 'var(--ash-editor-background)';
root.style.color = 'var(--ash-foreground)';
document.body.style.margin = '0';
document.querySelector('#open')!.addEventListener('click', () => { void services.invokeFunction(accessor => CommandsRegistry.getCommand('workbench.action.openThemeEditor')!(accessor)); });
declare global {
	interface Window {
		themeEditorTest: {
			source(): string;
			draft(): Promise<string | undefined>;
			colorMap(): string[];
			accessibleContent(): string;
			persisted(file?: string): Promise<string>;
			setSource(text: string): void;
			undo(): void;
			close(): Promise<boolean>;
			selectTheme(id: string): Promise<void>;
			setSetting(key: string, value: unknown): Promise<void>;
			externalWrite(text: string): Promise<void>;
		};
	}
}
const pane = (): ThemeEditor => { const editor = parts.activePane; if (!(editor instanceof ThemeEditor)) throw new Error('No Theme Editor'); return editor; };
window.themeEditorTest = {
	source: () => pane().getControl()!.getValue(),
	draft: async () => (await backups.list()).find(backup => backup.resource.toString() === pane().workingCopy?.resource.toString())?.content,
	colorMap: () => TokenizationRegistry.getColorMap()?.map(color => color.toString()) ?? [],
	accessibleContent: () => pane().getAccessibleContent(),
	persisted: async (file = 'aurora.json') => (await files.readFile(URI.file('/themes/' + file))).content,
	setSource: text => { const model = pane().getControl()!.getModel()!; model.pushStackElement(); pane().getControl()!.executeEdits('test.json', [{ range: model.getFullModelRange(), text }]); model.pushStackElement(); },
	undo: () => { pane().getControl()!.getModel()!.undo(); },
	close: () => parts.closeAuxiliaryEditorPart(parts.activePart),
	selectTheme: id => themes.setColorTheme(id).then(() => { }),
	setSetting: (key, value) => configuration.updateValue(key, value),
	externalWrite: text => files.writeFile({ resource, content: text }).then(() => { }),
};
document.body.dataset.ready = 'true';
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
