import '../../../src/ash/editor/editor.code.all.js';
import '../../../src/ash/workbench/browser/media/style.css';
import '../../../src/ash/workbench/contrib/codeEditor/browser/codeEditor.contribution.js';
import '../../../src/ash/workbench/contrib/themes/browser/themes.contribution.js';
import '../../../src/ash/workbench/contrib/themeEditor/browser/themeEditor.contribution.js';
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
import { WorkbenchConfigurationService } from '../../../src/ash/workbench/services/configuration/browser/configurationService.js';
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
import { formatNlsMessage, setNlsResolver } from '../../../src/ash/nls.js';
import { productLanguagePackCatalogs } from '../../../src/ash/workbench/services/localization/common/localizationCatalogs.js';
import { ExtensionColorThemeService } from '../../../src/ash/workbench/services/extensions/browser/extensionColorThemeService.js';
import { createBrowserExtensionApi } from '../../../src/ash/platform/extensions/browser/extensionApi.js';

const locale = new URLSearchParams(location.search).get('locale');
if (locale) {
 const catalog = productLanguagePackCatalogs.find(item => item.locale === locale)!;
 setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(catalog.bundles[bundle]?.[key] ?? fallback, parameters));
}
const resources = new DisposableStore();
const extensions = resources.add(new ExtensionColorThemeService(createBrowserExtensionApi(), { subscribe: () => toDisposable(() => {}) }));
await extensions.start();
const resource = URI.file('/themes/aurora.json');
const initial = '// keep this comment\n{\n  "name": "Aurora",\n  "type": "dark",\n  "colors": { "editor.background": "#101525", "sideBar.background": "#151a25" },\n}\n';

/** Deterministic file boundary; the real theme and text-model services own parsing and writes. */
class ThemeFiles implements IFileSystemProvider {
 private readonly delegate = new MemoryFileService([[resource, initial]]);
 private readonly paths = new Set([resource.toString()]);
 public readonly capabilities = this.delegate.capabilities;
 public readonly onDidChangeCapabilities = Event.None;
 public readonly onDidChangeFiles = Event.None;
 public watch() { return toDisposable(() => {}); }
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
registerCodeEditorServices(services);
const store = new BrowserTextResourceStore(textFiles);
const models = resources.add(services.createInstance(BrowserTextModelService, store, {}));
services.registerInstance(IFileTextModelService, models);
services.registerInstance(ITextModelResourceService, models);
const root = document.querySelector<HTMLElement>('#main')!;
services.registerInstance(ILayoutService, resources.add(new BrowserLayoutService({ root })));
services.registerInstance(IAccessibleViewService, resources.add(services.createInstance(AccessibleViewService)));
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
const editorOptions = { fileService: files, textFileService: textFiles, configurationService: configuration, fileDialogService: services.get(IFileDialogService) };
const main = resources.add(services.createInstance(EditorPart, document.querySelector<HTMLElement>('#editors')!, editorOptions));
const windows = resources.add(services.createInstance(BrowserAuxiliaryWindowService, window, root));
const parts = resources.add(services.createInstance(EditorParts, main, windows, (container: HTMLElement) => {
 const element = container.ownerDocument.createElement('header'); container.append(element);
 const titlebar = {
  container: element, element, height: 28, minimumWidth: 0, maximumWidth: Infinity, minimumHeight: 28, maximumHeight: 28,
  onDidChange: Event.None, onMenubarVisibilityChange: Event.None,
  layout() {}, updateOptions() {}, updateProperties() {}, registerVariables() {}, dispose() { element.remove(); }, [Symbol.dispose]() { this.dispose(); },
 };
 return { titlebar, part: services.createInstance(EditorPart, container, editorOptions) };
}, services.get(IAccessibilityService), services.get(IStorageService)));
services.registerInstance(IEditorPartsService, parts);
root.style.cssText = 'height:100vh; background:var(--ash-editor-background);color:var(--ash-foreground)';
document.body.style.margin = '0';
document.querySelector('#open')!.addEventListener('click', () => { void services.invokeFunction(accessor => CommandsRegistry.getCommand('workbench.action.openThemeEditor')!(accessor)); });
declare global {
 interface Window {
  themeEditorTest: {
   source(): string;
   persisted(file?: string): Promise<string>;
   setSource(text: string): void;
   undo(): void;
   close(): Promise<boolean>;
   selectTheme(id: string): Promise<void>;
   externalWrite(text: string): Promise<void>;
  };
 }
}
const pane = (): ThemeEditor => { const editor = parts.activePane; if (!(editor instanceof ThemeEditor)) throw new Error('No Theme Editor'); return editor; };
window.themeEditorTest = {
 source: () => pane().getControl()!.getValue(),
 persisted: async (file = 'aurora.json') => (await files.readFile(URI.file('/themes/' + file))).content,
 setSource: text => { const model = pane().getControl()!.getModel()!; model.pushStackElement(); pane().getControl()!.executeEdits('test.json', [{ range: model.getFullModelRange(), text }]); model.pushStackElement(); },
 undo: () => { pane().getControl()!.getModel()!.undo(); },
 close: () => parts.closeAuxiliaryEditorPart(parts.activePart),
 selectTheme: id => themes.setColorTheme(id).then(() => {}),
 externalWrite: text => files.writeFile({ resource, content: text }).then(() => {}),
};
document.body.dataset.ready = 'true';
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
