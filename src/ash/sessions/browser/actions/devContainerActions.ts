import { Action2, registerAction2 } from '../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { IProgressService, ProgressLocation } from '../../../platform/progress/common/progress.js';
import { IQuickInputService, type IQuickPickItem } from '../../../platform/quickinput/common/quickInput.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { CancellationTokenSource, CancellationToken } from '../../../base/common/cancellation.js';
import { canceled } from '../../../base/common/errors.js';
import { localize, localize2 } from '../../../nls.js';
import { IDevContainerAgentHostService } from '../../common/devContainerAgentHostService.js';
import { SessionsCategories } from '../../common/categories.js';
import { ISessionsManagementService } from '../../services/sessions/common/sessionsManagement.js';
import { WorkspaceSelection, selectionFromWorkspace } from '../workspaceSelection.js';
import { IViewsService } from '../../../workbench/services/views/common/viewsService.js';
import { CHAT_VIEW_ID } from '../../../workbench/contrib/chat/common/chat.js';

registerAction2(
	class NewDevContainerSession extends Action2 {
		constructor() {
			super({
				id: 'sessions.newDevContainerSession',
				title: localize2('sessions.devContainer.new', 'New Session in Dev Container...'),
				category: SessionsCategories.Sessions,
				f1: true,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const workspace = selectionFromWorkspace(accessor.get(IWorkspaceContextService).getWorkspace());
			using selection = accessor.get(IInstantiationService).createInstance(WorkspaceSelection);
			const source =
				workspace.type === 'local'
					? workspace
					: workspace.type === 'provider' && workspace.providerId === 'ash.dev-containers'
						? { type: 'local' as const, root: workspace.workspace }
						: await selection.pick(workspace.type === 'multiple' ? workspace.folders : [], target => target.type === 'local');
			if (!source || source.type !== 'local') {
				return;
			}
			const containers = accessor.get(IDevContainerAgentHostService);
			const sessions = accessor.get(ISessionsManagementService);
			const views = accessor.get(IViewsService);
			await withOperation(accessor.get(IProgressService), localize('sessions.devContainer.connecting', 'Starting Dev Container...'), async token => {
				if (!(await containers.isAvailable(source.root, token))) {
					throw new Error(localize('sessions.devContainer.requirements', 'Dev Containers require Docker, the Dev Container CLI, and a workspace with devcontainer.json.'));
				}
				const target = await containers.connect(source.root, token);
				if (token.isCancellationRequested) {
					throw canceled();
				}
				sessions.createUntitledSession(localize('sessions.devContainer.draft', 'Dev Container Chat'), target);
				await views.focusView(CHAT_VIEW_ID);
			});
		}
	},
);

for (const operation of ['stop', 'remove'] as const) {
	registerAction2(
		class ControlDevContainer extends Action2 {
			constructor() {
				super({
					id: `sessions.devContainer.${operation}`,
					title: operation === 'stop' ? localize2('sessions.devContainer.stop', 'Stop Dev Container...') : localize2('sessions.devContainer.remove', 'Remove Dev Container...'),
					category: SessionsCategories.Sessions,
					f1: true,
				});
			}
			async run(accessor: ServicesAccessor): Promise<void> {
				const service = accessor.get(IDevContainerAgentHostService);
				const targets = await service.getTargets(CancellationToken.None);
				const sessions = accessor.get(ISessionsManagementService);
				const choices = sessions.untitledSessions.flatMap(session =>
					session.workspace.type === 'provider' && session.workspace.providerId === 'ash.dev-containers'
						? [
								{
									label: session.title,
									description: session.workspace.workspace,
									workspace: session.workspace.workspace,
								},
							]
						: [],
				);
				for (const session of sessions.sessions) {
					const runtime = session.workspace?.runtime;
					if (runtime?.providerId === 'ash.dev-containers') {
						choices.push({
							label: session.title,
							description: runtime.workspace,
							workspace: runtime.workspace,
						});
					}
				}
				for (const target of targets) {
					if (target.type === 'provider') {
						choices.push({
							label: target.workspace,
							description: target.root,
							workspace: target.workspace,
						});
					}
				}
				const choice = await pick(
					accessor.get(IQuickInputService),
					localize('sessions.devContainer.select', 'Select a Dev Container workspace'),
					choices.filter((item, index) => choices.findIndex(other => other.workspace === item.workspace) === index),
				);
				if (!choice) {
					return;
				}
				if (operation === 'remove') {
					const confirm = await pick(accessor.get(IQuickInputService), choice.workspace, [
						{
							label: localize('sessions.devContainer.confirmRemove', 'Remove this container'),
							remove: true,
						},
						{ label: localize('sessions.devContainer.cancel', 'Cancel'), remove: false },
					]);
					if (!confirm?.remove) {
						return;
					}
				}
				const title = operation === 'stop' ? localize('sessions.devContainer.stopping', 'Stopping Dev Container...') : localize('sessions.devContainer.removing', 'Removing Dev Container...');
				await withOperation(accessor.get(IProgressService), title, token =>
					operation === 'stop' ? service.stopContainer(choice.workspace, token) : service.removeContainer(choice.workspace, token),
				);
			}
		},
	);
}

function pick<T extends IQuickPickItem>(input: IQuickInputService, placeholder: string, items: readonly T[]): Promise<T | undefined> {
	const lifetime = new DisposableStore();
	const picker = lifetime.add(input.createQuickPick<T>());
	picker.items = items;
	picker.placeholder = placeholder;
	picker.ariaLabel = placeholder;
	return new Promise(resolve => {
		let settled = false;
		const finish = (item: T | undefined): void => {
			if (settled) {
				return;
			}
			settled = true;
			resolve(item);
			lifetime.dispose();
		};
		lifetime.add(picker.onDidHide(() => finish(undefined)));
		lifetime.add(
			picker.onDidAccept(() => {
				const item = picker.selectedItems[0];
				if (item) {
					finish(item);
				}
			}),
		);
		picker.show();
	});
}

async function withOperation<T>(progress: IProgressService, title: string, operation: (token: CancellationToken) => Promise<T>): Promise<T> {
	using cancellation = new CancellationTokenSource();
	return await progress.withProgress(
		{ location: ProgressLocation.Notification, title, cancellable: true },
		() => operation(cancellation.token),
		() => cancellation.cancel(),
	);
}
