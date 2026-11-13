import { Separator, type IAction } from '../../../../base/common/actions.js';
import { Event } from '../../../../base/common/event.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { ChatAIDisabledSettingId } from '../../../../platform/chat/common/chatSettings.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { AppServerAvailableContext } from '../../../../workbench/common/contextkeys.js';
import { buildArtifactLink, type ArtifactIdentity } from '../../../../platform/artifactIntegrations/common/artifactLink.js';
import { handoffArtifactToCodeCommand } from '../common/artifactWorkspace.js';
import { IArtifactPins } from './artifactPins.js';

export interface ArtifactTitleTarget {
	readonly title: string;
	readonly identity?: ArtifactIdentity;
	readonly getCodeAttachment?: () => { readonly name: string; readonly content: string; };
	readonly popOut?: () => Promise<void>;
	readonly rename?: () => void;
	readonly delete?: () => Promise<void>;
}

/** Projects the operations supplied by the selected editor and its document owner. */
export class ArtifactTitleActions {
	readonly onDidChangeHandoffAvailability: Event<void>;

	constructor(
		@IAccessibilityService private readonly accessibility: IAccessibilityService,
		@IClipboardService private readonly clipboard: IClipboardService,
		@ICommandService private readonly commands: ICommandService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IDialogService private readonly dialogs: IDialogService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IArtifactPins private readonly pins: IArtifactPins,
	) {
		this.onDidChangeHandoffAvailability = Event.any(
			listener => contextKeys.onDidChangeContext(event => {
				if (event.keys.has(AppServerAvailableContext.key)) listener();
			}),
			listener => configuration.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration(ChatAIDisabledSettingId)) listener();
			}),
		);
	}

	getActions(target: ArtifactTitleTarget): readonly IAction[] {
		const { identity, getCodeAttachment, popOut, rename, delete: deleteArtifact } = target;
		const openActions: IAction[] = [];
		const editActions: IAction[] = [];
		if (identity) {
			const link = buildArtifactLink(identity, this.workspace.getWorkspace()).toString();
			openActions.push({
				id: 'sessions.artifacts.copyLink', label: localize('sessions.artifacts.copyLink', 'Copy link'), tooltip: '',
				icon: Lxicon.link, enabled: true,
				run: async () => {
					await this.clipboard.writeText(link);
					this.accessibility.status(localize('sessions.artifacts.linkCopied', 'Artifact link copied to clipboard.'));
				},
			});
		}
		if (getCodeAttachment && this.contextKeys.getValue(AppServerAvailableContext.key)
			&& this.configuration.getValue<boolean>(ChatAIDisabledSettingId) !== true) {
			openActions.push({
				id: handoffArtifactToCodeCommand, label: localize('sessions.artifacts.handoffToCode', 'Handoff to Ash Code'), tooltip: '',
				icon: Lxicon.code, enabled: true,
				run: () => this.commands.executeCommand(handoffArtifactToCodeCommand, getCodeAttachment()),
			});
		}
		if (popOut) {
			openActions.push({
				id: 'sessions.artifacts.popOut', label: localize('sessions.artifacts.popOut', 'Open in new window'), tooltip: '',
				icon: Lxicon.linkExternal, enabled: true, run: popOut,
			});
		}
		if (identity) {
			const pinned = this.pins.has(identity);
			editActions.push({
				id: 'sessions.artifacts.pin', label: pinned
					? localize('sessions.artifacts.unpin', 'Unpin from sidebar')
					: localize('sessions.artifacts.pin', 'Pin to sidebar'),
				tooltip: '', icon: pinned ? Lxicon.unpin : Lxicon.pin, enabled: true,
				run: () => this.pins.setPinned(identity, !pinned),
			});
		}
		if (rename) {
			editActions.push({
				id: 'sessions.artifacts.rename', label: localize('sessions.artifacts.rename', 'Rename'), tooltip: '',
				icon: Lxicon.edit, enabled: true, run: rename,
			});
		}
		const deleteActions: IAction[] = deleteArtifact ? [{
			id: 'sessions.artifacts.delete', label: localize('sessions.artifacts.deleteAction', 'Delete…'), tooltip: '',
			icon: Lxicon.trash, enabled: true, destructive: true, run: () => this.delete(target.title, deleteArtifact),
		}] : [];
		return Separator.join(openActions, editActions, deleteActions);
	}

	private async delete(title: string, deleteArtifact: () => Promise<void>): Promise<void> {
		const result = await this.dialogs.confirm({
			message: localize('sessions.artifacts.deleteConfirm', 'Delete artifact “{0}”?', title),
			detail: localize('sessions.artifacts.deleteDetail', 'The artifact and its saved content will be permanently deleted.'),
			primaryButton: localize('sessions.artifacts.delete', 'Delete'),
			destructive: true,
		});
		if (!result.confirmed) return;
		await deleteArtifact();
		this.accessibility.status(localize('sessions.artifacts.deleted', 'Deleted artifact {0}.', title));
	}
}
