import { URI } from '../../../../base/common/uri.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import type { SessionsViewSelection } from '../../../services/sessions/browser/sessionsService.js';
import { DockedEditorInput } from '../../../common/dockedEditorInput.js';
import { EditorInputSerializers, requireRecord, requireString } from '../../../../workbench/services/editor/common/editorInputSerializer.js';
import type { ISessionChangesEditorOptions } from '../common/sessionChangesService.js';
import './media/sessionChangesEditorInput.css';

/** Session identity persists independently of the resolved diff documents. */
export class SessionChangesEditorInput extends DockedEditorInput {
	public readonly contentType = 'application/vnd.ash.session-changes';
	public readonly resource: URI;
	constructor(selection: SessionsViewSelection | URI, public readonly changesetSelection?: ISessionChangesEditorOptions['changesetSelection']) {
		super();
		if (selection instanceof URI) {
			this.resource = selection.with({ scheme: 'ash-session-changes' });
		} else if (selection.kind === 'session') {
			this.resource = URI.from({ scheme: 'ash-session-changes', path: `/${selection.active.session.sessionId}`, query: new URLSearchParams({ thread: selection.active.threadId }).toString() });
		} else {
			this.resource = URI.from({ scheme: 'ash-session-changes', path: `/draft/${selection.session.untitledSessionId}` });
		}
	}
	public get label(): string { return localize('sessions.changes.title', 'Changes'); }
	public getIcon(): typeof Lxicon.diff { return Lxicon.diff; }
	public getLabelExtraClasses(): readonly string[] { return ['ash-session-changes-editor-label']; }
	public get sessionResource(): URI { return this.resource.with({ scheme: 'ash-session' }); }
}

EditorInputSerializers.registerStatic({
	typeId: 'sessions.editorInput.changes',
	canSerialize: input => input.resource.scheme === 'ash-session-changes',
	serialize: input => ({
		resource: input.resource.toString(),
		changesetId: input instanceof SessionChangesEditorInput
			? (input.changesetSelection?.kind === 'transient' ? input.changesetSelection.changeset.id : input.changesetSelection?.id)
			: undefined,
	}),
	deserialize: value => {
		const record = requireRecord(value, 'session Changes input');
		const resource = URI.parse(requireString(record.resource, 'session Changes resource'));
		if (resource.scheme !== 'ash-session-changes' || !resource.path.startsWith('/') || resource.path.length < 2) {
			throw new TypeError('Invalid session Changes resource');
		}
		return new SessionChangesEditorInput(resource, record.changesetId === undefined ? undefined : { kind: 'id', id: requireString(record.changesetId, 'session changeset ID') });
	},
});
