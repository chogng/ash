import { dirname, extUri } from '../../../../../base/common/resources.js';
import { Schemas } from '../../../../../base/common/network.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { HookEvents, IHooksService } from '../../../../../platform/hooks/common/hooksService.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { filterQuickPickItems } from '../../../../../platform/quickinput/browser/quickInputList.js';
import { createSshRemoteWorkspaceUri } from '../../../../../platform/remote/common/remote.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IAppServerRemoteAgentService } from '../../../../services/remote/common/appServerRemoteAgentService.js';

/** Project files can be opened before discovery supplies their backend namespace. */
export interface HookConfigurationTarget {
	readonly configPath: string;
	readonly namespace: string | undefined;
}

export interface IHookQuickPickOptions {
	readonly openEditor?: (resource: URI) => Promise<void>;
}

export function getHookConfigurationResource(accessor: ServicesAccessor, source: HookConfigurationTarget): URI | undefined {
	if (source.namespace === 'user') { return undefined; }
	const connection = accessor.get(IAppServerRemoteAgentService).connection;
	return connection?.kind === 'ssh' ? createSshRemoteWorkspaceUri(connection.host, source.configPath) : URI.file(source.configPath);
}

export function canEditHookConfiguration(accessor: ServicesAccessor, source: HookConfigurationTarget): boolean {
	if (source.namespace === 'user') {
		return accessor.get(IAppServerRemoteAgentService).connection?.kind === 'local' && accessor.get(IHooksService).userConfigurationEditor !== undefined;
	}
	return accessor.get(IWorkspaceContextService).getWorkspaceFolder(getHookConfigurationResource(accessor, source)!) !== null;
}

/** Opens the owning TOML without changing existing declarations or granting execution permission. */
export async function openHookConfiguration(accessor: ServicesAccessor, source: HookConfigurationTarget, options?: IHookQuickPickOptions): Promise<void> {
	if (!canEditHookConfiguration(accessor, source)) {
		throw new Error(localize({ bundle: 'ash.settings', key: 'hooks.editUnavailable' }, 'Edit this configuration on its owning host, or ask Ash to configure it.'));
	}
	if (source.namespace === 'user') {
		await accessor.get(IHooksService).userConfigurationEditor!();
		return;
	}
	const resource = getHookConfigurationResource(accessor, source)!;
	const files = accessor.get(IFileService);
	const editors = accessor.get(IEditorService);
	await files.createDirectory(dirname(resource));
	await files.createFile(resource, 'ignore');
	if (options?.openEditor) { await options.openEditor(resource); }
	else { await editors.openEditor({ resource, languageId: 'toml' }, { pinned: true }); }
}

/** Selects a lifecycle event, then opens an existing Hook or its configuration scope. */
export async function showConfigureHooksQuickPick(accessor: ServicesAccessor, options?: IHookQuickPickOptions): Promise<void> {
	const instantiation = accessor.get(IInstantiationService);
	const hooks = accessor.get(IHooksService);
	const remote = accessor.get(IAppServerRemoteAgentService);
	const workspace = accessor.get(IWorkspaceContextService);
	const chats = accessor.get(IChatSessionNavigationService);
	const notifications = accessor.get(INotificationService);
	using lifetime = new DisposableStore();
	const picker = lifetime.add(accessor.get(IQuickInputService).createQuickPick<IQuickPickItem>());
	let items: readonly IQuickPickItem[] = HookEvents.map(event => ({ label: event[0].toUpperCase() + event.slice(1) }));
	picker.items = items;
	picker.ariaLabel = picker.placeholder = localize('hooks.selectEvent', 'Select a lifecycle event');
	let cancelled = false;
	let opening = false;
	let accept: (item: IQuickPickItem | undefined) => void = () => { };
	lifetime.add(picker.onDidAccept(item => accept(item)));
	const dismissed = new Promise<undefined>(resolve => {
		lifetime.add(picker.onDidHide(() => { cancelled = true; accept(undefined); resolve(undefined); }));
	});
	lifetime.add(picker.onDidChangeValue(value => { picker.items = filterQuickPickItems(items, value); }));
	const next = (): Promise<IQuickPickItem | undefined> => new Promise(resolve => { accept = resolve; });
	const eventChoice = next();
	picker.show();
	const selectedEvent = await eventChoice;
	if (!selectedEvent || cancelled) { return; }
	const event = HookEvents[items.indexOf(selectedEvent)];
	const connection = remote.connection;
	const sessionId = chats.getActiveConversation()?.sessionId;
	picker.busy = true;
	picker.items = [];
	try {
		// Backend reads cannot be cancelled. Release the picker immediately on dismissal and ignore late results.
		const sources = await Promise.race([hooks.read(sessionId), dismissed]);
		if (!sources || cancelled || connection !== remote.connection || sessionId !== chats.getActiveConversation()?.sessionId) { return; }
		const targets = new Map<IQuickPickItem, HookConfigurationTarget>();
		const entries: IQuickPickItem[] = [];
		for (const source of sources) {
			if (!instantiation.invokeFunction(canEditHookConfiguration, source)) { continue; }
			for (const hook of source.hooks.filter(hook => hook.event === event)) {
				const item = { label: hook.id, description: hook.enabled ? localize({ bundle: 'ash.settings', key: 'hooks.enabled' }, 'Enabled') : localize({ bundle: 'ash.settings', key: 'hooks.disabled' }, 'Disabled'), detail: `${hook.program} ${JSON.stringify(hook.args)} · ${source.configPath}` };
				entries.push(item);
				targets.set(item, source);
			}
		}
		const scopes: HookConfigurationTarget[] = sources.filter(source => source.namespace === 'user' && instantiation.invokeFunction(canEditHookConfiguration, source));
		for (const folder of workspace.getWorkspace().folders) {
			const resource = URI.joinPath(folder.uri, '.ash', 'config.toml');
			const discovered = sources.find(source => extUri.isEqual(instantiation.invokeFunction(getHookConfigurationResource, source), resource));
			scopes.push(discovered ?? { configPath: resource.scheme === Schemas.file ? resource.fsPath : resource.path, namespace: undefined });
		}
		for (const source of scopes) {
			const item = { label: localize('hooks.configureScope', 'Configure in {0}', source.namespace === 'user' ? localize({ bundle: 'ash.settings', key: 'hooks.user' }, 'User configuration') : source.configPath), detail: localize('hooks.configureScopeDetail', 'Open TOML for {0}. Save your changes, then refresh Hooks.', selectedEvent.label) };
			entries.push(item);
			targets.set(item, source);
		}
		items = entries;
		picker.ariaLabel = picker.placeholder = localize('hooks.selectHook', 'Select a Hook or configuration scope');
		picker.value = '';
		picker.items = items;
		picker.busy = false;
		const chosen = await next();
		if (!chosen || cancelled || connection !== remote.connection || sessionId !== chats.getActiveConversation()?.sessionId) { return; }
		opening = true;
		picker.hide();
		await instantiation.invokeFunction(openHookConfiguration, targets.get(chosen)!, options);
	} catch (error) {
		if (!cancelled || opening) { notifications.error(localize({ bundle: 'ash.settings', key: 'hooks.actionFailed' }, 'Could not configure Hooks: {0}', error instanceof Error ? error.message : String(error))); }
	} finally {
		picker.hide();
	}
}

export function registerHookActions(): void {
	registerAction2(class ManageHooksAction extends Action2 {
		constructor() { super({ id: 'workbench.action.chat.configure.hooks', title: localize2('hooks.configure', 'Chat: Configure Hooks…'), f1: true }); }
		public override run(accessor: ServicesAccessor): Promise<void> { return showConfigureHooksQuickPick(accessor); }
	});
}
