import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IExtensionRecommendationsService, IExtensionIgnoredRecommendationsService } from '../../../services/extensionRecommendations/common/extensionRecommendations.js';
import { ExtensionIgnoredRecommendationsService } from '../../../services/extensionRecommendations/common/extensionIgnoredRecommendationsService.js';
import '../../../services/extensionRecommendations/common/workspaceExtensionsConfig.js';
import { ExtensionRecommendationsService } from './extensionRecommendationsService.js';
import { IExtensionRecommendationNotificationService, RecommendationSource } from '../../../../platform/extensionRecommendations/common/extensionRecommendations.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ExtensionRecommendationNotificationService } from './extensionRecommendationNotificationService.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

import { localize, localize2 } from '../../../../nls.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Action2, MenuId, MenusRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ExtensionUiTarget, OPEN_EXTENSIONS_COMMAND_ID, OPEN_INSTALLED_EXTENSIONS_COMMAND_ID, type ExtensionsOpenOptions } from '../../../../platform/extensionManagement/common/extensionManagementService.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { ViewsRegistry } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { registerExtensionManagementActions } from './extensionsActions.js';
import { openExtensionsView, registerExtensionsViewContainer } from './extensionsViewlet.js';
import { ExtensionsSettingsModel } from './extensionsSettingsModel.js';
import { registerSettingsSection } from '../../../services/preferences/browser/settingsSections.js';
import { AccessibleViewProviderId, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';

registerSettingsSection({
	id: 'extensions.management', categoryId: 'extensions', model: new SyncDescriptor(ExtensionsSettingsModel),
	accessibleViewProviderId: AccessibleViewProviderId.Extensions,
	accessibilityVerbositySettingId: AccessibilityVerbositySettingId.Extensions,
});

registerSingleton(IExtensionRecommendationsService, new SyncDescriptor(ExtensionRecommendationsService, [ExtensionUiTarget.IDE], true));
registerSingleton(IExtensionIgnoredRecommendationsService, ExtensionIgnoredRecommendationsService, InstantiationType.Delayed);
registerSingleton(IExtensionRecommendationNotificationService, ExtensionRecommendationNotificationService, InstantiationType.Delayed);

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: 'extensions.ignoreRecommendations', defaultValue: false,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') { throw new TypeError(localize({ bundle: 'ash.extensions', key: 'invalidIgnoreRecommendations' }, 'Extension recommendation notifications must be enabled or disabled.')); }
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize({ bundle: 'ash.extensions', key: 'ignoreRecommendationsTitle' }, 'Ignore extension recommendations'),
		description: localize({ bundle: 'ash.extensions', key: 'ignoreRecommendationsDescription' }, 'Hide automatic extension recommendation notifications. Recommendations remain available in Extensions.'),
	},
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: 'extensions.showRecommendationsOnlyOnDemand', defaultValue: false,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') { throw new TypeError(localize({ bundle: 'ash.extensions', key: 'invalidIgnoreRecommendations' }, 'Extension recommendation notifications must be enabled or disabled.')); }
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize({ bundle: 'ash.extensions', key: 'recommendationsOnDemandTitle' }, 'Show extension recommendations only on demand'),
		description: localize({ bundle: 'ash.extensions', key: 'recommendationsOnDemandDescription' }, 'Discover recommendations in Extensions without automatic notifications when opening files or workspaces.'),
	},
});

registerWorkbenchContribution('workbench.contrib.extensionRecommendations', WorkbenchPhase.AfterRestored, accessor => {
	const registrations = new DisposableStore();
	const recommendations = accessor.get(IExtensionRecommendationsService);
	const notifications = accessor.get(IExtensionRecommendationNotificationService);
	let generation = 0;
	let context = new AbortController();
	registrations.add(toDisposable(() => context.abort()));
	const update = async (): Promise<void> => {
		const current = ++generation;
		context.abort(); context = new AbortController();
		const signal = context.signal;
		try {
			const snapshot = await recommendations.getRecommendations();
			if (registrations.isDisposed || current !== generation) { return; }
			const workspace: string[] = [];
			const contexts = new Map<string, { context: NonNullable<typeof snapshot.recommendations[number]['context']>; extensions: string[]; }>();
			for (const item of snapshot.recommendations) {
				if (!item.context) { continue; }
				if (item.context.source === RecommendationSource.WORKSPACE) { workspace.push(item.extensionId); continue; }
				const key = JSON.stringify(item.context);
				const group = contexts.get(key) ?? { context: item.context, extensions: [] };
				group.extensions.push(item.extensionId); contexts.set(key, group);
			}
			if (workspace.length) { void notifications.promptWorkspaceRecommendations(workspace, signal); }
			for (const { context, extensions } of contexts.values()) { void notifications.promptImportantExtensionsInstallNotification({ ...context, extensions, signal }); }
		} catch { /* Optional suggestions must not block workspace restoration. */ }
	};
	const scheduler = registrations.add(new RunOnceScheduler(() => { void update(); }, 100));
	registrations.add(recommendations.onDidChangeRecommendations(() => { context.abort(); scheduler.schedule(); }));
	void update();
	return registrations;
});

registerWorkbenchContribution('workbench.contrib.extensions', WorkbenchPhase.BlockStartup, () => {
	const registrations = new DisposableStore();
	registrations.add(registerExtensionsViewContainer(ViewsRegistry));
	registrations.add(registerAction2(class OpenExtensions extends Action2 {
		constructor() { super({ id: OPEN_EXTENSIONS_COMMAND_ID, title: localize2({ bundle: 'ash.workbench', key: 'command.OpenExtensions' }, 'Open Extensions'), f1: true }); }
		public override async run(accessor: ServicesAccessor, options?: ExtensionsOpenOptions | string): Promise<void> {
			await openExtensionsView(accessor.get(IViewsService), typeof options === 'string' ? { query: options.trim() } : options);
		}
	}));
	registrations.add(registerAction2(class OpenInstalledExtensions extends Action2 {
		constructor() { super({ id: OPEN_INSTALLED_EXTENSIONS_COMMAND_ID, title: localize2({ bundle: 'ash.workbench', key: 'command.OpenPlugins' }, 'Manage Installed Extensions'), f1: true }); }
		public override async run(accessor: ServicesAccessor, options?: ExtensionsOpenOptions): Promise<void> {
			await openExtensionsView(accessor.get(IViewsService), { ...options, view: 'plugins', mode: 'installed' });
		}
	}));
	registrations.add(registerExtensionManagementActions());
	return registrations;
});

MenusRegistry.appendMenuItem(MenuId.GlobalActivity, {
	command: { id: OPEN_EXTENSIONS_COMMAND_ID, title: localize2({ bundle: 'ash', key: 'workbench.manageExtensions' }, 'Extensions') },
	group: '2_configuration',
	order: 3,
});
