import { AccessibleViewProviderId, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { CodebaseSettingId } from '../../../../platform/codebase/common/codebaseService.js';
import { localize } from '../../../../nls.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerSettingsSection } from '../../../services/preferences/browser/settingsSections.js';
import { CodebaseSettingsModel } from './codebaseSettingsModel.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.ContentSearchSettings,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') {
			throw new TypeError('Codebase accessibility verbosity must be boolean');
		}
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize({ bundle: 'ash.settings', key: 'search.verbosity' }, 'Codebase accessibility help'); },
		get description() { return localize({ bundle: 'ash.settings', key: 'search.verbosityDescription' }, 'Announce how to open accessibility help in Codebase settings.'); },
	},
});

registerSettingsSection({
	id: CodebaseSettingId,
	categoryId: 'editor-suggestions',
	model: new SyncDescriptor(CodebaseSettingsModel),
	accessibleViewProviderId: AccessibleViewProviderId.ContentSearchSettings,
	accessibilityVerbositySettingId: AccessibilityVerbositySettingId.ContentSearchSettings,
});
