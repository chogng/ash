import { localize, localize2 } from '../../../../nls.js';
import { Action2 } from '../../../../platform/actions/common/actions.js';
import { ChatAIDisabledSettingId } from '../../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IExtensionManagementService } from '../../../../platform/extensionManagement/common/extensionManagementService.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ChatContextKeys } from '../common/actions/chatContextKeys.js';
import { CHAT_CATEGORY } from './actions/chatActions.js';

const pendingUpdates = new WeakMap<IExtensionManagementService, Promise<void>>();

export class UpdateAgentPluginsCommand extends Action2 {
	constructor() {
		super({
			id: 'workbench.agentPlugins.checkForUpdates',
			title: localize2('chat.plugins.update', 'Update Plugins'),
			category: CHAT_CATEGORY,
			f1: true,
			precondition: ChatContextKeys.enabled.isEqualTo(true),
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		if (accessor.get(IConfigurationService).getValue<boolean>(ChatAIDisabledSettingId)) return;
		const extensions = accessor.get(IExtensionManagementService);
		const dialogs = accessor.get(IDialogService);
		const pending = pendingUpdates.get(extensions);
		if (pending) return pending;
		const update = updateSignedPlugins(extensions, dialogs).finally(() => pendingUpdates.delete(extensions));
		pendingUpdates.set(extensions, update);
		await update;
	}
}

async function updateSignedPlugins(extensions: IExtensionManagementService, dialogs: IDialogService): Promise<void> {
	const updated: string[] = [];
	const failed: string[] = [];
	// This catalog contains verified registry installations. Local and Git installs use the plugin authority.
	for (const installed of await extensions.listInstalled()) {
		if (installed.state !== 'installed') continue;
		const { id, version, digest } = installed.package;
		try {
			const current = await extensions.get(id, version);
			if (current.packageType !== 'plugin') continue;
			if (current.package.digest !== digest) {
				failed.push(id);
				continue;
			}
			const latest = await extensions.get(id);
			if (latest.packageType !== 'plugin' || !isNewerStableVersion(latest.package.version, version)) continue;
			const result = await extensions.update(installed.installationId, latest.package.version);
			updated.push(localize('chat.plugins.updatedVersion', '{0}: {1} → {2}', id, version, result.package.version));
		} catch {
			failed.push(id);
		}
	}
	const summary = failed.length
		? localize('chat.plugins.updateIncomplete', 'Updated {0} plugins. Could not verify or update {1} packages.', updated.length, failed.length)
		: updated.length
			? localize('chat.plugins.updatedCount', 'Updated {0} plugins.', updated.length)
			: localize('chat.plugins.upToDate', 'Plugins from signed registries are up to date.');
	const details = failed.length ? [...updated, localize('chat.plugins.updateFailed', 'Could not verify or update: {0}', failed.join(', '))] : updated;
	await dialogs.info(summary, details.join('\n'));
}

function isNewerStableVersion(candidate: string, installed: string): boolean {
	const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[\w.-]+)?(?:\+[\w.-]+)?$/u;
	const next = semver.exec(candidate);
	const current = semver.exec(installed);
	if (!next || !current || next[4]) return false;
	for (let index = 1; index <= 3; index++) {
		const difference = BigInt(next[index]) - BigInt(current[index]);
		if (difference !== 0n) return difference > 0n;
	}
	return current[4] !== undefined;
}
