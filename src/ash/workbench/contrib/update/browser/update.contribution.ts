import { URI } from '../../../../base/common/uri.js';
import { isWeb } from '../../../../base/common/platform.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { registerEditorPane } from '../../../browser/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IUpdateService, type UpdateCheckResult } from '../../../../platform/update/common/updateService.js';
import { IBrowserWorkbenchEnvironmentService } from '../../../services/environment/browser/environmentService.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { ReleaseNotesEditor, releaseNotesEditorId, releaseNotesResource } from './releaseNotesEditor.js';

registerEditorPane({
	id: releaseNotesEditorId,
	get name() { return localize('releaseNotes.title', 'Release Notes'); },
	canOpen: input => input.resource.toString() === releaseNotesResource ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: options => {
		if (!options.instantiationService) throw new Error('Release notes require Workbench services');
		return options.instantiationService.createInstance(new SyncDescriptor(ReleaseNotesEditor));
	},
});

registerAction2(class ShowReleaseNotes extends Action2 {
	constructor() { super({ id: 'workbench.action.showReleaseNotes', get title() { return localize2('releaseNotes.open', 'Show Release Notes'); }, f1: true, menu: { id: MenuId.MenubarHelpMenu, group: '2_reference', order: 2 } }); }
	override async run(services: ServicesAccessor): Promise<void> {
		await services.get(IEditorService).openEditor({ resource: URI.parse(releaseNotesResource), label: localize('releaseNotes.title', 'Release Notes'), readOnly: true, showBreadcrumbs: false });
	}
});

function clearWebUpdateNotifications(notifications: INotificationService): void {
	// Notifications are the presentation owner; replace stale prompts rather than caching their state.
	for (const item of notifications.getNotifications()) {
		if (item.actions?.primary?.some(action => action.id === 'update.reload')) notifications.remove(item.id);
	}
}

function showWebUpdate(notifications: INotificationService, update: IUpdateService, result: UpdateCheckResult): boolean {
	clearWebUpdateNotifications(notifications);
	if (result.status !== 'available') return false;
	notifications.info(localize('update.webAvailable', 'Ash {0} is available. Reload to update.', result.version), [{
		id: 'update.reload',
		label: localize('update.reload', 'Reload to Update'),
		run: async () => {
			try {
				await update.installUpdate();
			} catch (error) {
				if (isCancellationError(error)) return;
				console.error('Web update reload failed', error);
				notifications.error(localize('update.webReloadFailed', 'Could not reload Ash to apply the update.'));
			}
		},
	}]);
	return true;
}

if (isWeb) {
	registerAction2(class CheckForWebUpdatesAction extends Action2 {
		constructor() {
			super({
				id: 'update.checkForUpdate',
				title: localize2('update.checkForUpdates', 'Check for Updates...'),
				precondition: ContextKeyExpr.has('update.providerAvailable'),
				f1: true,
				menu: { id: MenuId.MenubarHelpMenu, group: '1_update', order: 1 },
			});
		}

		override async run(services: ServicesAccessor): Promise<void> {
			const update = services.get(IUpdateService);
			const notifications = services.get(INotificationService);
			const checking = notifications.info(localize('update.checking', 'Checking for updates...'));
			try {
				const result = await update.checkForUpdates();
				if (!showWebUpdate(notifications, update, result)) notifications.info(localize('update.webCurrent', 'Ash is up to date.'));
			} catch (error) {
				if (isCancellationError(error)) return;
				console.error('Web update check failed', error);
				notifications.error(localize('update.checkFailed', 'Could not check for updates.'));
			} finally {
				checking.close();
			}
		}
	});
	registerWorkbenchContribution('workbench.contrib.webUpdate', WorkbenchPhase.AfterRestored, services => {
		const environment = services.get(IBrowserWorkbenchEnvironmentService);
		const supported = services.get(IContextKeyService).createKey<boolean>('update.providerAvailable', false);
		supported.set(environment.options.updateProvider !== undefined);
		const update = services.get(IUpdateService);
		const notifications = services.get(INotificationService);
		let disposed = false;
		void update.checkAutomatically().then(result => {
			if (!disposed && result) showWebUpdate(notifications, update, result);
		}).catch(error => {
			if (!disposed) console.error('Automatic Web update check failed', error);
		});
		return toDisposable(() => {
			disposed = true;
			clearWebUpdateNotifications(notifications);
			supported.reset();
		});
	});
}
