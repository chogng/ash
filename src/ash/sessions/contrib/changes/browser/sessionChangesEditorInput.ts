import { URI } from '../../../../base/common/uri.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import type { SessionsViewSelection } from '../../../services/sessions/browser/sessionsService.js';
import { EditorInputCapabilities, type IResourceEditorInput } from '../../../../workbench/common/editor.js';
import { EditorInputSerializers, requireRecord, requireString } from '../../../../workbench/services/editor/common/editorInputSerializer.js';

/** Session identity persists independently of the resolved diff documents. */
export class SessionChangesEditorInput implements IResourceEditorInput {
	public capabilities = EditorInputCapabilities.None;
	public readonly contentType = 'application/vnd.ash.session-changes';
	public readonly readOnly = true;
	public readonly showBreadcrumbs = false;
	public readonly resource: URI;
	constructor(selection: SessionsViewSelection | URI) {
		if (selection instanceof URI) {
			this.resource = selection;
		} else if (selection.kind === 'session') {
			this.resource = URI.from({ scheme: 'ash-session-changes', path: `/${selection.active.session.sessionId}`, query: new URLSearchParams({ thread: selection.active.threadId }).toString() });
		} else {
			this.resource = URI.from({ scheme: 'ash-session-changes', path: `/draft/${selection.session.untitledSessionId}` });
		}
	}
	public get label(): string { return localize('sessions.changes.title', 'Changes'); }
	public getIcon(): typeof Lxicon.diff { return Lxicon.diff; }
}

EditorInputSerializers.registerStatic({
	typeId: 'sessions.editorInput.changes',
	canSerialize: input => input.resource.scheme === 'ash-session-changes',
	serialize: input => ({ resource: input.resource.toString() }),
	deserialize: value => new SessionChangesEditorInput(URI.parse(requireString(requireRecord(value, 'session Changes input').resource, 'session Changes resource'))),
});
