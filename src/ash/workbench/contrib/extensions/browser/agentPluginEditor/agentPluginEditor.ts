import { localize } from '../../../../../nls.js';
import { extensionUiTargetsLabel } from '../../../../../platform/extensionManagement/common/extensionNls.js';
import type { PluginPackageView } from '../../../../../platform/extensionManagement/common/pluginManagementService.js';
import { describePluginPermission } from '../agentPluginActions.js';

/** Projects the exact local package into the shared Extensions details pane. */
export function getAgentPluginEditorDetails(plugin: PluginPackageView) {
	const info = [{
		label: localize({ bundle: 'ash.extensions', key: 'detailInstallation' }, 'Installation'), rows: [
			{ label: localize({ bundle: 'ash.extensions', key: 'detailIdentifier' }, 'Identifier'), value: plugin.id },
			{ label: localize({ bundle: 'ash.extensions', key: 'detailVersion' }, 'Version'), value: plugin.version },
			{ label: localize({ bundle: 'ash.extensions', key: 'uiTargetsHeading' }, 'Applicable windows'), value: extensionUiTargetsLabel(plugin.uiTargets) },
			{ label: localize({ bundle: 'ash.extensions', key: 'detailSource' }, 'Source'), value: localize({ bundle: 'ash.extensions', key: 'localPlugin' }, 'Local plugin') },
			{ label: localize({ bundle: 'ash.extensions', key: 'detailDigest' }, 'Package digest'), value: plugin.digest },
		]
	}];
	const permissions = [localize({ bundle: 'ash.extensions', key: 'localExtensionDigest' }, 'Package digest: {0}', plugin.digest), ...plugin.permissions.map(describePluginPermission)].join('\n\n');
	return { info, permissions };
}
