import { Event } from '../../../base/common/event.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../platform/configuration/common/inMemoryConfigurationService.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { ServiceContainer } from '../../../platform/instantiation/common/instantiation.js';
import { IResourceLabelService, ResourceLabelService } from '../../browser/labels.js';
import { WorkspaceContextService } from '../../services/workspaces/browser/workspaceContextService.js';

/** Assembles the real label owner for editor tests without an extension icon theme. */
export function createTestEditorServices(configuration?: IConfigurationService, parent?: ServiceContainer): ServiceContainer {
	const services = new ServiceContainer(parent);
	if (configuration) {
		services.registerInstance(IConfigurationService, configuration);
	} else if (!services.has(IConfigurationService)) {
		services.registerSingleton(IConfigurationService, () => new InMemoryConfigurationService());
	}
	services.registerSingleton(IWorkspaceContextService, () => new WorkspaceContextService({ id: 'test-editor', folders: [] }));
	services.registerSingleton(IResourceLabelService, () => {
		const workspace = services.get(IWorkspaceContextService);
		return new ResourceLabelService({ workspaceContextService: workspace, resourceIconRenderer: { onDidChangeResourceIcons: Event.None, renderFileIcon() {} } });
	});
	return services;
}
