import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { EditorInputCapabilities } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

/** The editor restores its identity; its conversation belongs to the window's Chat owner. */
export class AgentSessionsWelcomeInput extends EditorInput {
	public static readonly TYPE_ID = 'workbench.editors.agentSessionsWelcomeInput';
	public static readonly RESOURCE = URI.from({ scheme: 'ash-welcome', path: '/agent-sessions' });
	public readonly onDidChangeLabel = Event.None;
	public readonly typeId = AgentSessionsWelcomeInput.TYPE_ID;
	public readonly resource = AgentSessionsWelcomeInput.RESOURCE;
	public readonly capabilities = EditorInputCapabilities.Singleton;
	public readonly readOnly = true;
	public readonly showBreadcrumbs = false;
	public getName(): string { return localize('agentSessionsWelcome.title', 'Agent Sessions Welcome'); }
	public getIcon(): typeof Lxicon.chat { return Lxicon.chat; }
}
