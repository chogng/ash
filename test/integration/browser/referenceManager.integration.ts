import { IExtensionService } from '../../../src/ash/workbench/services/extensions/common/extensionService.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { createTestEditorServices, createTestFileService, createTestTextFileService } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import { IFileService } from '../../../src/ash/platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../src/ash/platform/files/common/inMemoryFilesystemProvider.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { Emitter } from '../../../src/ash/base/common/event.js';
import { IOpenerService } from '../../../src/ash/platform/opener/common/opener.js';
import { OpenerService } from '../../../src/ash/editor/browser/services/openerService.js';
import { ICodeEditorService } from '../../../src/ash/editor/browser/services/codeEditorService.js';
import { StandaloneCodeEditorService } from '../../../src/ash/editor/standalone/browser/standaloneCodeEditorService.js';
import { ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { StandaloneCommandService } from '../../../src/ash/editor/standalone/browser/standaloneServices.js';
import { IDialogService, IFileDialogService } from '../../../src/ash/platform/dialogs/common/dialogs.js';
import { IEditorService } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import { IWorkingCopyService } from '../../../src/ash/workbench/services/workingCopy/common/workingCopyService.js';
import { IDocumentEditorTextModelService } from '../../../src/ash/workbench/services/documentEditor/common/documentTypes.js';
import { DocumentEditorTextModelService } from '../../../src/ash/workbench/services/documentEditor/browser/documentEditorTextModelService.js';
import type { DocumentEditorPane } from '../../../src/ash/workbench/contrib/documentEditor/browser/documentEditorPane.js';
import type { TextModelWorkingCopyReference } from '../../../src/ash/workbench/services/textmodelResolver/common/textModelResourceService.js';
import type { DocumentTextModel as AcademyTextModel } from '../../../extensions/academy/common/model/documentTextModel.js';
import type { ReferenceLibraryEditor } from '../../../extensions/reference-manager/browser/referenceLibraryEditor.js';
import { MainThreadClientEditors } from '../../../src/ash/workbench/api/browser/mainThreadClientEditors.js';
import { loadExtensionEditorModule } from '../../../src/ash/workbench/services/extensions/browser/extensionEditorModules.js';
import { IExtensionApi, normalizeExtensionCatalog } from '../../../src/ash/platform/extensions/common/extensionApi.js';
import { ExtensionResourceLoaderService } from '../../../src/ash/platform/extensionResourceLoader/browser/extensionResourceLoaderService.js';
import { IExtensionHostApi } from '../../../src/ash/platform/agentHost/common/extensionHostApi.js';
import { EditorPanes } from '../../../src/ash/workbench/browser/editor.js';
import type { EditorPane } from '../../../src/ash/workbench/browser/parts/editor/editorPane.js';
import type { IResourceEditorInput, IEditorExtensionApi } from '../../../src/ash/workbench/common/editor.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import editorMessages from '../../../extensions/language-pack-zh-cn/translations/editor.json' with { type: 'json' };
import workbenchMessages from '../../../extensions/language-pack-zh-cn/translations/workbench.json' with { type: 'json' };
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { AccessibleViewRegistry } from '../../../src/ash/platform/accessibility/browser/accessibleViewRegistry.js';
import { bindTestColorTheme } from '../../fixtures/browser/themeFixture.js';
import '../../../src/ash/base/browser/ui/button/button.css';
import '../../../src/ash/base/browser/ui/toolbar/toolbar.css';

const locale = new URLSearchParams(location.search).get('locale') ?? 'en';
setNlsMessages(locale, locale === 'zh-CN' ? { ash: { ...editorMessages.ash, ...workbenchMessages.ash } } : {});
const parent = new InstantiationService();
const memory = new InMemoryFileSystemProvider();
const files = createTestFileService(memory);
parent.registerInstance(IFileService, files);
let dialogPaths: string[] = [];
let metadata: string[] | undefined;
parent.registerInstance(IFileDialogService, {
	showSaveDialog: async () => (dialogPaths[0] ? URI.file(dialogPaths.shift()!) : undefined),
	showOpenDialog: async () => dialogPaths.splice(0).map(path => URI.file(path)),
} as unknown as IFileDialogService);
parent.registerInstance(IDialogService, {
	input: async () => ({ confirmed: !!metadata, values: metadata }),
	confirm: async () => ({ confirmed: true }),
} as unknown as IDialogService);
const services = createTestEditorServices(undefined, parent);
const codeEditors = new StandaloneCodeEditorService();
services.registerInstance(ICodeEditorService, codeEditors);
services.registerSingleton(ICommandService, () => services.createInstance(StandaloneCommandService));
const opener = services.createInstance(OpenerService);
services.registerInstance(IOpenerService, opener);
const textFiles = createTestTextFileService(files);
const models = new DocumentEditorTextModelService(textFiles, services.get(IWorkingCopyService));
services.registerInstance(IDocumentEditorTextModelService, models);
const theme = bindTestColorTheme(services.get(IThemeService), document.body);
const changed = new Emitter<void>();
const panes = new Map<string, EditorPane>();
async function open(
	input: IResourceEditorInput,
	preferredEditorId?: string,
	slot = /\.pdf$/i.test(input.resource.path) ? 'pdf' : /\.(?:ash-academy|ash-paper)$/i.test(input.resource.path) ? 'document' : 'library',
) {
	const descriptor = EditorPanes.getEditorPane(input, { preferredEditorId });
	if (!descriptor) throw new Error('No admitted editor');
	const pane = await descriptor.create({ input, instantiationService: services });
	const container = document.getElementById(slot)!;
	const next = document.createElement('div');
	next.style.height = '100%';
	container.append(next);
	pane.create(next);
	pane.setVisible(true);
	await pane.setInput(input, new AbortController().signal);
	pane.layout({ width: slot === 'library' ? 650 : 700, height: 880 });
	panes.get(slot)?.dispose();
	for (const child of [...container.children]) if (child !== next) child.remove();
	panes.set(slot, pane);
	changed.fire();
	return pane;
}
services.registerInstance(IEditorService, {
	onDidVisibleEditorsChange: changed.event,
	onDidActiveEditorChange: changed.event,
	get visibleEditorPanes() {
		return [...panes.values()];
	},
	openEditor: async (input: IResourceEditorInput, options?: { preferredEditorId?: string }) => {
		await open(input, options?.preferredEditorId);
	},
} as unknown as IEditorService);
const resources = new ExtensionResourceLoaderService(async request => {
	const response = await fetch(`/__references_resource?id=${request.extensionId}&generation=${request.generation}&path=${encodeURIComponent(request.path)}`);
	if (!response.ok) throw new Error('Package resource unavailable');
	return new Uint8Array(await response.arrayBuffer());
});
services.registerInstance(IExtensionService, {
	getExtensionPointContributions: () => [],
} as unknown as IExtensionService);
services.registerInstance(IExtensionApi, {
	list: async () => normalizeExtensionCatalog(await (await fetch('/__references_catalog')).json()),
	resources,
} as IExtensionApi);
services.registerInstance(IExtensionHostApi, {
	invoke: async (request, signal) =>
		(
			await fetch(`/__references_invoke?id=${request.extensionId}`, {
				method: 'POST',
				signal,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(request.payload),
			})
		).json(),
} as IExtensionHostApi);
const bridge = services.createInstance(MainThreadClientEditors, 30000, loadExtensionEditorModule);
await memory.createDirectory(URI.file('/fixture'));
await files.writeFile({
	resource: URI.file('/fixture/source.ris'),
	content: 'TY  - JOUR\nTI  - A paper\nAU  - Smith, Jane\nPY  - 2024\nDO  - 10.1234/abc\nER  -\nTY  - BOOK\nTI  - A second book\nAU  - Wang, Ming\nPY  - 2023\nER  -\n',
});
await files.writeFile({ resource: URI.file('/fixture/paper.ash-academy'), content: '' });
await memory.writeFile(URI.file('/fixture/paper.pdf'), new Uint8Array(await (await fetch('/__references_pdf')).arrayBuffer()), { create: true, overwrite: false });
const library = () => panes.get('library') as ReferenceLibraryEditor;
const model = () => (panes.get('document')!.workingCopy as TextModelWorkingCopyReference).model as AcademyTextModel;
let savedApi: IEditorExtensionApi | undefined;
window.referenceManagerTest = {
	async enable(name: string, enabled: boolean) {
		await bridge.update(
			await (
				await fetch(`/__references_enable?locale=${locale}`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ name, enabled }),
				})
			).json(),
		);
		changed.fire();
	},
	async open(path = '/fixture/source.ris', readOnly = false) {
		await open({ resource: URI.file(path), readOnly });
	},
	dialogs(paths: string[], values?: string[]) {
		dialogPaths = paths;
		metadata = values;
	},
	library: () => JSON.parse(library().workingCopy!.backup()),
	document: () => (panes.get('document') as DocumentEditorPane).getDocument(),
	async persisted(path = '/fixture/library.ash-library') {
		return (await files.readFile(URI.file(path))).content;
	},
	async write(path: string, content: string) {
		await files.writeFile({ resource: URI.file(path), content });
	},
	dirty: () => library().workingCopy!.isDirty,
	undo: () => !!model().undoBlocks(),
	redo: () => !!model().redoBlocks(),
	captureApi() {
		savedApi = panes.get('document')!.getExtensionApi!('academy.citations.v1');
	},
	async invokeSaved(payload: unknown) {
		try {
			await savedApi!.invoke(payload, new AbortController().signal);
			return '';
		} catch (error) {
			return String(error);
		}
	},
	async saveDocument() {
		await panes.get('document')!.workingCopy!.save(new AbortController().signal);
	},
	async saveLibrary() {
		await panes.get('library')!.save!();
	},
	accessible: () =>
		AccessibleViewRegistry.getImplementations()
			.filter(item => item.name.startsWith('resource-editor-'))
			.map(item => item.getProvider(services)?.provideContent() ?? '')
			.join('\n'),
	dispose() {
		for (const pane of panes.values()) pane.dispose();
		bridge.dispose();
		changed.dispose();
		models.dispose();
		textFiles.dispose();
		opener.dispose();
		codeEditors.dispose();
		theme.dispose();
		services.dispose();
		parent.dispose();
		files.dispose();
		memory.dispose();
	},
};
declare global {
	interface Window {
		referenceManagerTest: {
			enable(name: string, enabled: boolean): Promise<void>;
			open(path?: string, readOnly?: boolean): Promise<void>;
			dialogs(paths: string[], values?: string[]): void;
			library(): any;
			document(): any;
			persisted(path?: string): Promise<string>;
			write(path: string, content: string): Promise<void>;
			dirty(): boolean;
			undo(): boolean;
			redo(): boolean;
			captureApi(): void;
			invokeSaved(payload: unknown): Promise<string>;
			saveDocument(): Promise<void>;
			saveLibrary(): Promise<void>;
			accessible(): string;
			dispose(): void;
		};
	}
}
