import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2 } from '../../../../../platform/actions/common/actions.js';
import { buildOpenSessionLinkUri, parseOpenSessionLinkUri } from '../../../../../platform/agentHost/common/openSessionLink.js';
import { ChatAIDisabledSettingId } from '../../../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspacesService, recentWorkspaceUri } from '../../../../../platform/workspaces/common/workspaces.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { validateOpenAgentsWindow, type IOpenAgentsWindowOptions } from '../../../../../platform/native/common/nativeHost.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { type IWorkspace, IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';

function workspaceIdentity(workspace: IWorkspace): URI | undefined {
	return workspace.configuration ?? (workspace.folders.length === 1 ? workspace.folders[0]?.uri : undefined);
}

/** A handoff is addressed to one workspace identity, independently of other windows. */
export function getAgentSessionsWelcomePrefillKey(workspace: IWorkspace): string | undefined {
	const resource = workspaceIdentity(workspace);
	return resource ? `chat.welcomeViewPrefill:${resource.toString()}` : undefined;
}

export async function takeTransferredChatDraft(
	workspace: IWorkspace,
	storage: IStorageService,
	trust: IWorkspaceTrustManagementService,
): Promise<IOpenAgentsWindowOptions['draft']> {
	const key = getAgentSessionsWelcomePrefillKey(workspace);
	if (!key) { return; }
	const serialized = storage.get(key, StorageScope.APPLICATION);
	if (!serialized) { return; }
	storage.remove(key, StorageScope.APPLICATION);
	await storage.flush();
	if (!trust.isWorkspaceTrusted()) { return; }

	try {
		const value: unknown = JSON.parse(serialized);
		if (!value || typeof value !== 'object' || !('timestamp' in value) || typeof value.timestamp !== 'number'
			|| !Number.isFinite(value.timestamp) || value.timestamp > Date.now() || Date.now() - value.timestamp > 60_000 || !('payload' in value)) { return; }
		return validateOpenAgentsWindow(value.payload)?.draft;
	} catch {
		// Persisted handoffs may outlive the process or contain invalid data.
		return undefined;
	}
}

function conversationTransferKey(uri: URI): string {
	return `chat.workspaceConversation:${uri.toString()}`;
}

export class OpenChatInWorkspaceAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.openInWorkspace',
			title: localize2('chat.transfer.openInWorkspace', 'Chat: Open Conversation in Another Workspace'),
			f1: true,
			precondition: ChatContextKeys.enabled.isEqualTo(true),
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const navigation = accessor.get(IChatSessionNavigationService);
		const conversation = navigation.getActiveConversation();
		if (!conversation) { return; }
		const revision = navigation.revision;
		const workspaces = accessor.get(IWorkspacesService);
		const workspaceContext = accessor.get(IWorkspaceContextService);
		const currentUri = workspaceIdentity(workspaceContext.getWorkspace())?.toString();
		const trust = accessor.get(IWorkspaceTrustManagementService);
		const input = accessor.get(IQuickInputService);
		const storage = accessor.get(IStorageService);
		const host = accessor.get(IHostService);
		const notifications = accessor.get(INotificationService);
		const recent = await workspaces.getRecentlyOpened();
		const candidates = (await Promise.all(recent.workspaces.map(async entry => {
			const uri = recentWorkspaceUri(entry);
			if (uri.scheme !== 'file' || uri.toString() === currentUri || !(await trust.getUriTrustInfo(uri)).trusted) { return undefined; }
			return { label: entry.label || basename(uri), description: uri.fsPath, uri, entry };
		}))).filter(candidate => candidate !== undefined);
		if (!candidates.length) {
			notifications.info(localize('chat.transfer.noTrustedWorkspace', 'No other trusted local workspace is available in your recent workspaces.'));
			return;
		}
		using lifetime = new DisposableStore();
		const picker = lifetime.add(input.createQuickPick<typeof candidates[number]>());
		picker.placeholder = localize('chat.transfer.pickWorkspace', 'Select a trusted workspace to open this conversation');
		picker.items = candidates;
		const selected = await new Promise<typeof candidates[number] | undefined>(resolve => {
			lifetime.add(picker.onDidAccept(() => { resolve(picker.selectedItems[0]); picker.hide(); }));
			lifetime.add(picker.onDidHide(() => resolve(undefined)));
			picker.show();
		});
		if (!selected || !(await trust.getUriTrustInfo(selected.uri)).trusted || navigation.revision !== revision
			|| workspaceIdentity(workspaceContext.getWorkspace())?.toString() !== currentUri) { return; }

		const link = buildOpenSessionLinkUri(conversation.sessionId, conversation.threadId, 'local');
		const key = conversationTransferKey(selected.uri);
		const value = JSON.stringify({ link: link.toString(), expiresAt: Date.now() + 60_000 });
		storage.store(key, value, StorageScope.APPLICATION, StorageTarget.MACHINE);
		try {
			await storage.flush();
			await host.openWindow(['folderUri' in selected.entry ? { folderUri: selected.uri } : { workspaceUri: selected.uri }], { forceNewWindow: true });
		} catch (error) {
			if (storage.get(key, StorageScope.APPLICATION) === value) { storage.remove(key, StorageScope.APPLICATION); }
			throw error;
		}
	}
}

export async function restoreTransferredChatConversation(accessor: ServicesAccessor, signal?: AbortSignal): Promise<void> {
	const workspaceContext = accessor.get(IWorkspaceContextService);
	const uri = workspaceIdentity(workspaceContext.getWorkspace());
	if (!uri) { return; }
	const storage = accessor.get(IStorageService);
	const key = conversationTransferKey(uri);
	const serialized = storage.get(key, StorageScope.APPLICATION);
	if (!serialized) { return; }
	const trust = accessor.get(IWorkspaceTrustManagementService);
	const opener = accessor.get(IOpenerService);
	const configuration = accessor.get(IConfigurationService);
	await trust.workspaceTrustInitialized;
	if (signal?.aborted || storage.get(key, StorageScope.APPLICATION) !== serialized) { return; }
	storage.remove(key, StorageScope.APPLICATION);
	await storage.flush();
	if (signal?.aborted || !trust.isWorkspaceTrusted() || configuration.getValue<boolean>(ChatAIDisabledSettingId)
		|| workspaceIdentity(workspaceContext.getWorkspace())?.toString() !== uri.toString()) { return; }

	let link: URI;
	try {
		const payload: unknown = JSON.parse(serialized);
		if (!payload || typeof payload !== 'object' || !('link' in payload) || typeof payload.link !== 'string'
			|| !('expiresAt' in payload) || typeof payload.expiresAt !== 'number' || !Number.isFinite(payload.expiresAt)
			|| payload.expiresAt < Date.now() || payload.expiresAt > Date.now() + 60_000) { return; }
		link = URI.parse(payload.link);
		if (parseOpenSessionLinkUri(link).connectionAuthority !== 'local') { return; }
	} catch {
		return;
	}
	await opener.open(link);
}
