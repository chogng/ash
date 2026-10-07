import { FileService } from '../../../platform/files/common/fileService.js';
import { Schemas } from '../../../base/common/network.js';
import { ITextModelService } from '../../../editor/common/services/resolverService.js';
import { ITextModelResourceService } from '../../services/textmodelResolver/common/textModelResourceService.js';
import { TextModelResolverService } from '../../services/textmodelResolver/common/textModelResolverService.js';
import { ILogService, NullLoggerService } from '../../../platform/log/common/log.js';
import { ContextKeyService, IContextKeyService } from "../../../platform/contextkey/browser/contextKeyService.js";
import { ILanguageService } from '../../../editor/common/languages/language.js';
import { LanguageService } from '../../../editor/common/services/languageService.js';
import { IFileTextModelService } from '../../services/textmodelResolver/common/textModelResourceService.js';
import { BrowserTextModelService } from '../../services/textmodelResolver/browser/browserTextModelService.js';
import { noFileIconTheme, IThemeService } from '../../../platform/theme/common/themeService.js';
import { ILabelService, LabelService } from '../../../platform/label/common/labelService.js';
import { IUntitledTextEditorService, UntitledTextEditorService } from '../../services/untitled/common/untitledTextEditorService.js';
import { IWorkingCopyService } from '../../services/workingCopy/common/workingCopyService.js';
import { BrowserWorkingCopyService } from '../../services/workingCopy/browser/browserWorkingCopyService.js';
import { IDecorationsService } from '../../services/decorations/common/decorations.js';
import { DecorationsService } from '../../services/decorations/browser/decorationsService.js';
import { Event } from '../../../base/common/event.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../platform/configuration/common/inMemoryConfigurationService.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { IResourceIconRenderer, IResourceLabelService, ResourceLabelService } from '../../browser/labels.js';
import { WorkspaceContextService } from '../../services/workspaces/browser/workspaceContextService.js';
import { ILinkPresentationService } from '../../../platform/dataChannel/common/dataChannel.js';
import { LinkPresentationService } from '../../services/dataChannel/browser/dataChannelService.js';
import { darkColorTheme } from '../../../platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../platform/theme/test/common/testThemeService.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../services/storage/browser/storageService.js';
import { IFileService, type IFileSystemProvider } from '../../../platform/files/common/files.js';
import { MemoryFileService } from '../../contrib/bulkEdit/test/browser/bulkEditTestServices.js';
import { IWorkbenchEnvironmentService } from '../../services/environment/common/environmentService.js';
import { BrowserWorkbenchEnvironmentService } from '../../services/environment/browser/environmentService.js';
import { mainWindow } from '../../../base/browser/window.js';
import { FilesConfigurationService, IFilesConfigurationService } from '../../services/filesConfiguration/common/filesConfigurationService.js';
import { TextFileService } from '../../services/textfile/common/textFileService.js';
import { IWebviewService } from '../../contrib/webview/browser/webview.js';
import { WebviewService } from '../../contrib/webview/browser/webviewService.js';

/** Assembles the same scheme router as the product around test-owned storage. */
export function createTestFileService(provider: IFileSystemProvider, schemes: readonly string[] = [Schemas.file, Schemas.ashRemote, Schemas.vscodeUserData, 'ash-settings']): FileService {
	return new TestFileService(provider, schemes);
}

class TestFileService extends FileService {
	constructor(provider: IFileSystemProvider, schemes: readonly string[]) {
		super();
		for (const scheme of schemes) {
			this._register(this.registerProvider(scheme, provider));
		}
	}
}

/** Owns the real file-policy dependencies for file-service tests outside a Workbench. */
export function createTestTextFileService(files: IFileSystemProvider | IFileService): TextFileService {
	return new TestTextFileService(files);
}

class TestTextFileService extends TextFileService {
	constructor(provider: IFileSystemProvider | IFileService) {
		const configuration = new InMemoryConfigurationService();
		const workspace = new WorkspaceContextService({ id: 'test-text-files', folders: [] });
		const policy = new FilesConfigurationService(configuration, workspace);
		let ownedFiles: FileService | undefined;
		let files: IFileService;
		if ('registerProvider' in provider) files = provider;
		else files = ownedFiles = createTestFileService(provider);
		super(files, policy);
		if (ownedFiles) this._register(ownedFiles);
		this._register(configuration);
		this._register(workspace);
		this._register(policy);
	}
}

/** Uses real component services with an isolated browser-storage backend for each test scope. */
export function createTestComponentServices(storage?: IStorageService, parent?: InstantiationService, document: Document = globalThis.document): InstantiationService {
	const services = parent ? parent.createChild() : new InstantiationService();
	if (storage) {
		services.registerInstance(IStorageService, storage);
	}
	return registerTestComponentServices(services, document);
}

export function registerTestComponentServices(services: InstantiationService, document: Document = globalThis.document): InstantiationService {
	if (!services.has(IWorkbenchEnvironmentService)) {
		const location = document.defaultView!.location;
		services.registerInstance(IWorkbenchEnvironmentService, new BrowserWorkbenchEnvironmentService(location, `http://{{uuid}}.localhost${location.port ? `:${location.port}` : ''}`));
	}
	if (!services.has(IFileService)) {
		services.registerSingleton(IFileService, () => createTestFileService(new MemoryFileService([])));
	}
	if (!services.has(IWebviewService)) {
		services.registerSingleton(IWebviewService, () => services.createInstance(WebviewService));
	}
	if (!services.has(IThemeService)) {
		services.registerSingleton(IThemeService, () => new TestThemeService(darkColorTheme));
	}
	if (!services.has(IStorageService)) {
		services.registerSingleton(IStorageService, () => new BrowserStorageService({ ownerWindow: document.defaultView!, workspaceId: 'test-components', backend: new TestStorageBackend(), flushInterval: 0 }));
	}
	return services;
}

class TestStorageBackend implements Storage {
	private readonly values = new Map<string, string>();
	public get length(): number { return this.values.size; }
	public clear(): void { this.values.clear(); }
	public getItem(key: string): string | null { return this.values.get(key) ?? null; }
	public key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
	public removeItem(key: string): void { this.values.delete(key); }
	public setItem(key: string, value: string): void { this.values.set(key, value); }
}

/** Observes the document handed to the real bootstrap across the iframe message boundary. */
export function getWebviewHtml(element: HTMLIFrameElement): string {
	const target = element.contentWindow!;
	const original = target.postMessage;
	const url = new URL(element.src);
	const channel = new URLSearchParams(url.hash.slice(1)).get('channel');
	let html: string | undefined;
	target.postMessage = (message: { type: string; html: string; }) => {
		if (message.type === 'document') html = message.html;
	};
	try {
		const ownerWindow = element.ownerDocument.defaultView!;
		ownerWindow.dispatchEvent(new mainWindow.MessageEvent('message', { source: target, origin: `${url.protocol}//${url.host}`, data: { channel, type: 'bootstrap-ready' } }));
		if (html === undefined) throw new Error('Webview did not send its current document');
		return html;
	} finally {
		target.postMessage = original;
	}
}

/** Assembles the real label owner for editor tests without an extension icon theme. */
export function createTestEditorServices(configuration?: IConfigurationService, parent?: InstantiationService, document: Document = globalThis.document, storage?: IStorageService): InstantiationService {
	const services = createTestComponentServices(storage, parent, document);
	if (!services.has(IContextKeyService)) services.registerSingleton(IContextKeyService, () => new ContextKeyService());
	if (!services.has(ILinkPresentationService)) services.registerSingleton(ILinkPresentationService, () => services.createInstance(LinkPresentationService));
	if (configuration) {
		services.registerInstance(IConfigurationService, configuration);
	} else if (!services.has(IConfigurationService)) {
		services.registerSingleton(IConfigurationService, () => new InMemoryConfigurationService());
	}
	services.registerSingleton(IWorkspaceContextService, () => new WorkspaceContextService({ id: 'test-editor', folders: [] }));
	if (!services.has(IFilesConfigurationService)) services.registerSingleton(IFilesConfigurationService, () => services.createInstance(FilesConfigurationService));
	if (!services.has(IResourceIconRenderer)) services.registerInstance(IResourceIconRenderer, { onDidChangeResourceIcons: Event.None, getFileIconTheme: () => noFileIconTheme, renderFileIcon() { } });
	if (!services.has(ILabelService)) services.registerSingleton(ILabelService, () => new LabelService(services.get(IWorkspaceContextService)));
	if (!services.has(IWorkingCopyService)) services.registerSingleton(IWorkingCopyService, () => new BrowserWorkingCopyService());
	if (!services.has(IUntitledTextEditorService)) services.registerSingleton(IUntitledTextEditorService, () => services.createInstance(UntitledTextEditorService));
	if (!services.has(ILogService)) services.registerInstance(ILogService, new NullLoggerService());
	if (!services.has(IDecorationsService)) services.registerSingleton(IDecorationsService, () => services.createInstance(DecorationsService, document));
	if (!services.has(ILanguageService)) services.registerSingleton(ILanguageService, () => new LanguageService());
	if (!services.has(IFileTextModelService)) services.registerSingleton(IFileTextModelService, () => new BrowserTextModelService({ onDidChange: Event.None, resolve: async request => ({ resource: request.resource, text: request.bootstrapText ?? '', revision: undefined }), save: async () => ({ revision: undefined }) }));
	if (!services.has(ITextModelResourceService)) services.registerSingleton(ITextModelResourceService, () => services.get(IFileTextModelService));
	if (!services.has(ITextModelService)) services.registerSingleton(ITextModelService, () => services.createInstance(TextModelResolverService));
	services.registerSingleton(IResourceLabelService, () => services.createInstance(ResourceLabelService));
	return services;
}
