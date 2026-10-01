import { ContextKeyService, IContextKeyService } from "../../../platform/contextkey/browser/contextKeyService.js";
import { ILanguageService } from '../../../editor/common/languages/language.js';
import { LanguageService } from '../../../editor/common/services/languageService.js';
import { IFileTextModelService } from '../../services/textmodelResolver/common/textModelResourceService.js';
import { BrowserTextModelService } from '../../services/textmodelResolver/browser/browserTextModelService.js';
import { noFileIconTheme } from '../../../platform/theme/common/themeService.js';
import { ILabelService, LabelService } from '../../../platform/label/common/labelService.js';
import { IUntitledTextEditorService } from '../../services/untitled/common/untitledTextEditorService.js';
import { BrowserUntitledTextEditorService } from '../../services/untitled/browser/browserUntitledTextEditorService.js';
import { IWorkingCopyService } from '../../services/workingCopy/common/workingCopyService.js';
import { BrowserWorkingCopyService } from '../../services/workingCopy/browser/browserWorkingCopyService.js';
import { IFileLabelDecorationService } from '../../services/labels/common/fileLabelDecorationService.js';
import { FileLabelDecorationService } from '../../services/labels/browser/fileLabelDecorationService.js';
import { Event } from '../../../base/common/event.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../platform/configuration/common/inMemoryConfigurationService.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { IResourceIconRenderer, IResourceLabelService, ResourceLabelService } from '../../browser/labels.js';
import { WorkspaceContextService } from '../../services/workspaces/browser/workspaceContextService.js';

/** Assembles the real label owner for editor tests without an extension icon theme. */
export function createTestEditorServices(configuration?: IConfigurationService, parent?: InstantiationService): InstantiationService {
	const services = parent ? parent.createChild() : new InstantiationService();
	if (!services.has(IContextKeyService)) services.registerSingleton(IContextKeyService, () => new ContextKeyService());
	if (configuration) {
		services.registerInstance(IConfigurationService, configuration);
	} else if (!services.has(IConfigurationService)) {
		services.registerSingleton(IConfigurationService, () => new InMemoryConfigurationService());
	}
	services.registerSingleton(IWorkspaceContextService, () => new WorkspaceContextService({ id: 'test-editor', folders: [] }));
	if (!services.has(IResourceIconRenderer)) services.registerInstance(IResourceIconRenderer, { onDidChangeResourceIcons: Event.None, getFileIconTheme: () => noFileIconTheme, renderFileIcon() {} });
	if (!services.has(ILabelService)) services.registerSingleton(ILabelService, () => new LabelService(services.get(IWorkspaceContextService)));
	if (!services.has(IWorkingCopyService)) services.registerSingleton(IWorkingCopyService, () => new BrowserWorkingCopyService());
	if (!services.has(IUntitledTextEditorService)) services.registerSingleton(IUntitledTextEditorService, () => services.createInstance(BrowserUntitledTextEditorService));
	if (!services.has(IFileLabelDecorationService)) services.registerSingleton(IFileLabelDecorationService, () => new FileLabelDecorationService());
	if (!services.has(ILanguageService)) services.registerSingleton(ILanguageService, () => new LanguageService());
	if (!services.has(IFileTextModelService)) services.registerSingleton(IFileTextModelService, () => new BrowserTextModelService({ onDidChange: Event.None, resolve: async request => ({ resource: request.resource, text: request.bootstrapText ?? '', revision: undefined }), save: async () => ({ revision: undefined }) }));
	services.registerSingleton(IResourceLabelService, () => services.createInstance(ResourceLabelService));
	return services;
}
