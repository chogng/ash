import { localize } from '../../../../../nls.js';
import type { PluginPackageView } from '../../../../../platform/extensionManagement/common/pluginManagementService.js';
import { AgentPluginEditorInput } from '../../common/agentPluginEditorInput.js';
import { ExtensionsInput, ExtensionsInputSource } from '../../common/extensionsInput.js';

export function localAgentPluginItem(plugin: PluginPackageView) {
	return {
		source: ExtensionsInputSource.Local,
		digest: plugin.digest,
		enabled: plugin.enabled,
		canChangeEnablement: plugin.enabled || !plugin.revoked,
		summary: {
			id: plugin.id,
			version: plugin.version,
			packageType: 'editorExtension',
			displayName: plugin.displayName,
			uiTargets: plugin.uiTargets,
			description: localize({ bundle: 'ash.extensions', key: 'localExtension' }, 'Local extension'),
		},
	};
}

/** Older saved tabs have no digest. New inputs must resolve the exact installed package. */
export function findInstalledPlugin(packages: readonly PluginPackageView[], input: ExtensionsInput): PluginPackageView | undefined {
	const { id, version } = input.summary;
	const digest = input instanceof AgentPluginEditorInput ? input.digest : undefined;
	return packages.find(plugin => plugin.id === id && plugin.version === version && (digest === undefined || plugin.digest === digest));
}
