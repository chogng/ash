import { URI } from '../../../../../base/common/uri.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IEditorPart } from '../../../../../workbench/browser/parts/editor/editorPart.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { EditorInputCapabilities, type IResourceEditorInput } from '../../../../../workbench/common/editor.js';
import { SessionChangesEditorInput } from '../../../changes/browser/sessionChangesEditorInput.js';
import { DockedEditorInput } from '../../../../common/dockedEditorInput.js';
import { ISessionsService, type SessionsViewSelection } from '../../../../services/sessions/browser/sessionsService.js';
import { ISessionChangesService } from '../../../changes/common/sessionChangesService.js';

/** Reconciles retained Changes tabs without creating editors for empty sessions. */
export class DesktopDockedTabsCoordinator extends Disposable {
	constructor(private readonly pageGroupId: number, @IEditorPart private readonly editor: IEditorPart, @IEditorService private readonly editors: IEditorService, @ISessionChangesService private readonly changes: ISessionChangesService, @ISessionsService private readonly sessions: ISessionsService) { super(); }

	private get documentGroups() { return this.editor.groups.filter(group => group.id !== this.pageGroupId); }

	private isCurrent(selection: SessionsViewSelection): boolean {
		if (this.isDisposed) { return false; }
		const active = this.sessions.activeSelection;
		return active?.kind === 'session' && selection.kind === 'session'
			? active.active.session.sessionId === selection.active.session.sessionId && active.active.threadId === selection.active.threadId
			: active?.kind === 'untitled' && selection.kind === 'untitled' && active.session.untitledSessionId === selection.session.untitledSessionId;
	}

	public async reconcile(selection: SessionsViewSelection, detailsOnly: boolean): Promise<void> {
		if (!this.isCurrent(selection)) { return; }
		const changes = new SessionChangesEditorInput(selection);
		for (const group of this.documentGroups) {
			for (const input of group.inputs.filter(input => input.resource.scheme === 'ash-session-changes' && input.resource.toString() !== changes.resource.toString())) {
				try { await group.replaceEditor(input, changes); }
				catch (error) {
					if (!this.isCurrent(selection) || !this.documentGroups.includes(group)) { return; }
					throw error;
				}
				if (!this.isCurrent(selection) || !this.documentGroups.includes(group)) { return; }
			}
		}
		for (const group of this.documentGroups) {
			for (const input of group.inputs) {
				if (input instanceof DockedEditorInput) {
					input.capabilities = detailsOnly ? EditorInputCapabilities.CannotClose : EditorInputCapabilities.None;
					await this.editors.openEditor(input, { pinned: true, preserveFocus: true, inactive: true }, { groupId: group.id });
					if (!this.isCurrent(selection) || !this.documentGroups.includes(group)) { return; }
				}
			}
		}
	}

	public async removeRestoredDetailTabs(): Promise<void> {
		if (this.isDisposed) { return; }
		for (const group of this.documentGroups) {
			// Retired Files tabs disappear; compatible Changes inputs migrate to their independent host.
			const hasConversation = this.sessions.activeSelection?.kind === 'session';
			for (const input of group.inputs.filter(input => input.resource.scheme === 'ash-sessions-files' || input.resource.scheme === 'ash-session-changes')) {
				if (hasConversation && input instanceof SessionChangesEditorInput) {
					await this.changes.openChangesEditor(input.sessionResource, { changesetSelection: input.changesetSelection, preserveFocus: true });
					if (this.isDisposed) { return; }
				}
				await group.closeEditor(input, { skipConfirmation: true, reason: 'reset' });
				if (this.isDisposed) { return; }
			}
		}
	}

	public async openChanges(): Promise<void> {
		if (this.isDisposed) { return; }
		const selection = this.sessions.activeSelection;
		const resource = selection ? new SessionChangesEditorInput(selection).sessionResource : URI.parse('ash-session:/draft/empty');
		await this.changes.openChangesEditor(resource, { changesetSelection: { kind: 'id', id: undefined } });
	}

	public isManaged(input: IResourceEditorInput): boolean {
		return input instanceof DockedEditorInput;
	}
}
