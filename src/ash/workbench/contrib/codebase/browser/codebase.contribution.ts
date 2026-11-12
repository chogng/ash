import { AccessibleViewProviderId, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { CodebaseSettingId } from '../../../../platform/codebase/common/codebaseService.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { registerSettingsSection } from '../../../services/preferences/browser/settingsSections.js';
import { CodebaseSettingsModel } from './codebaseSettingsModel.js';

registerSettingsSection({
	id: CodebaseSettingId,
	categoryId: 'editor-suggestions',
	model: new SyncDescriptor(CodebaseSettingsModel),
	accessibleViewProviderId: AccessibleViewProviderId.ChatModelConfiguration,
	accessibilityVerbositySettingId: AccessibilityVerbositySettingId.ChatModelConfiguration,
});
