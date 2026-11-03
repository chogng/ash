import type { ExtensionsInput } from '../common/extensionsInput.js';
import { findInstalledPlugin } from './agentPluginEditor/agentPluginItems.js';
import { localize } from '../../../../nls.js';
import type { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import type { IPluginManagementService, PluginPackageView, PluginPermission } from '../../../../platform/extensionManagement/common/pluginManagementService.js';

export function describePluginPermission(permission: PluginPermission): string {
	switch (permission.type) {
		case 'directory': return permission.access === 'read' ? localize({ bundle: 'ash.extensions', key: 'permissionRead' }, 'Read workspace files') : localize({ bundle: 'ash.extensions', key: 'permissionWrite' }, 'Write workspace files');
		case 'process': return localize({ bundle: 'ash.extensions', key: 'permissionProcess' }, 'Run {0}', permission.executable);
		case 'network': return localize({ bundle: 'ash.extensions', key: 'permissionNetwork' }, 'Access network hosts: {0}', permission.hosts.join(', '));
	}
}

export async function reviewLocalExtensionPermissions(plugin: PluginPackageView, plugins: IPluginManagementService, dialogs: IDialogService): Promise<void> {
	const catalog = await plugins.list();
	const selected = catalog.packages.find(value => value.id === plugin.id && value.digest === plugin.digest);
	if (!selected) { return; }
	await dialogs.prompt({
		title: selected.displayName, message: `${selected.id} · ${selected.version}`,
		detail: [localize({ bundle: 'ash.extensions', key: 'localExtensionPermissions' }, 'Requested permissions: {0}', selected.permissions.length ? selected.permissions.map(describePluginPermission).join('; ') : localize({ bundle: 'ash.extensions', key: 'noPermissions' }, 'None')),
		localize({ bundle: 'ash.extensions', key: 'localExtensionDocumentNotice' }, 'Ash extensions use the product Node host with user-level filesystem, network and child-process access and inherited developer environment variables. Editor callbacks can receive unsaved text. Grant permissions only to packages you trust.'),
		localize({ bundle: 'ash.extensions', key: 'localExtensionDigest' }, 'Package digest: {0}', selected.digest)].join('\n\n'),
		buttons: [{ label: selected.granted ? localize({ bundle: 'ash.extensions', key: 'revokeLocalExtension' }, 'Revoke permissions') : localize({ bundle: 'ash.extensions', key: 'grantLocalExtension' }, 'Grant permissions'), run: () => selected.granted ? plugins.revokeGrant(selected, catalog.revision) : plugins.grant(selected, catalog.revision) }],
	});
}

/** Resolve the current catalog entry before applying the requested enablement. */
export async function setAgentPluginEnablement(plugins: IPluginManagementService, input: ExtensionsInput, enabled: boolean | undefined): Promise<void> {
	const catalog = await plugins.list();
	const plugin = findInstalledPlugin(catalog.packages, input);
	if (!plugin) { throw new Error(localize({ bundle: 'ash.extensions', key: 'extensionMissing' }, 'This extension is no longer installed. Refresh Extensions.')); }
	const nextEnabled = enabled ?? !plugin.enabled;
	if (nextEnabled) { await plugins.enable(plugin, catalog.revision); }
	else { await plugins.disable(plugin, catalog.revision); }
}

/** Resolve the exact package and its current catalog revision after confirmation. */
export async function uninstallAgentPlugin(plugin: PluginPackageView, plugins: IPluginManagementService, dialogs: IDialogService): Promise<boolean> {
	const review = await dialogs.confirm({
		title: localize({ bundle: 'ash.extensions', key: 'uninstallTitle' }, 'Uninstall extension'),
		message: localize({ bundle: 'ash.extensions', key: 'uninstallMessage' }, 'Uninstall {0} {1}?', plugin.id, plugin.version),
		primaryButton: localize({ bundle: 'ash.extensions', key: 'uninstall' }, 'Uninstall'),
	});
	if (!review.confirmed) { return false; }
	const latest = await plugins.list();
	const selected = latest.packages.find(value => value.id === plugin.id && value.digest === plugin.digest);
	if (!selected) { return false; }
	await plugins.uninstall(selected, latest.revision);
	return true;
}
