import { AccessibleViewProviderId, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { DiskFileSystemProviderClient } from '../../../../platform/files/common/diskFileSystemProviderClient.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { projectMaterialFilesChannel, projectMaterialFilesScheme } from '../../../../platform/projects/common/projectMaterialFiles.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { registerSettingsSection } from '../../../../workbench/services/preferences/browser/settingsSections.js';
import { ProjectMaterialFilesSettings } from './projectMaterialFilesSettings.js';

registerSettingsSection({
	id: 'project-material-files',
	categoryId: 'general',
	model: new SyncDescriptor(ProjectMaterialFilesSettings),
	accessibleViewProviderId: AccessibleViewProviderId.SessionsSettings,
	accessibilityVerbositySettingId: AccessibilityVerbositySettingId.SessionsSettings,
});

registerWorkbenchContribution('sessions.projectMaterialFiles', WorkbenchPhase.BlockStartup, accessor => {
	const files = accessor.get(IFileService);
	const channel = accessor.get(IMainProcessService).getChannel(projectMaterialFilesChannel);
	const lifetime = new DisposableStore();
	lifetime.add(files.registerProvider(projectMaterialFilesScheme, lifetime.add(new DiskFileSystemProviderClient(channel, projectMaterialFilesScheme))));
	return lifetime;
});
