import { ITextModelService } from '../../../editor/common/services/resolverService.js';
import { ITextModelResourceService } from '../../services/textmodelResolver/common/textModelResourceService.js';
import { TextModelResolverService } from '../../services/textmodelResolver/common/textModelResolverService.js';
import { ILogService, NullLoggerService } from '../../../platform/log/common/log.js';
import { ContextKeyService, IContextKeyService } from "../../../platform/contextkey/browser/contextKeyService.js";
import { ILanguageService } from '../../../editor/common/languages/language.js';
import { LanguageService } from '../../../editor/common/services/languageService.js';
import { IFileTextModelService } from '../../services/textmodelResolver/common/textModelResourceService.js';
import { BrowserTextModelService } from '../../services/textmodelResolver/browser/browserTextModelService.js';
import { noFileIconTheme } from '../../../platform/theme/common/themeService.js';
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

/** Assembles the real label owner for editor tests without an extension icon theme. */
export function createTestEditorServices(configuration?: IConfigurationService, parent?: InstantiationService, document: Document = globalThis.document): InstantiationService {
	const services = parent ? parent.createChild() : new InstantiationService();
	if (!services.has(IContextKeyService)) services.registerSingleton(IContextKeyService, () => new ContextKeyService());
	if (!services.has(ILinkPresentationService)) services.registerSingleton(ILinkPresentationService, () => services.createInstance(LinkPresentationService));
	if (configuration) {
		services.registerInstance(IConfigurationService, configuration);
	} else if (!services.has(IConfigurationService)) {
		services.registerSingleton(IConfigurationService, () => new InMemoryConfigurationService());
	}
	services.registerSingleton(IWorkspaceContextService, () => new WorkspaceContextService({ id: 'test-editor', folders: [] }));
	if (!services.has(IResourceIconRenderer)) services.registerInstance(IResourceIconRenderer, { onDidChangeResourceIcons: Event.None, getFileIconTheme: () => noFileIconTheme, renderFileIcon() {} });
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
