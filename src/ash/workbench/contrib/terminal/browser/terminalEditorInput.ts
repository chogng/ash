import { terminalStrings } from '../common/terminalStrings.js';
import type { Event } from '../../../../base/common/event.js';
import type { URI } from '../../../../base/common/uri.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import type { ITerminalInstance } from '../../../services/terminal/browser/terminal.js';
import { parseTerminalUri } from './terminalUri.js';

/** The editor owns a resource value; the terminal service retains the process and screen. */
export class TerminalEditorInput implements IResourceEditorInput {
	static readonly ID = 'workbench.editor.terminal';
	readonly typeId = TerminalEditorInput.ID;
	readonly editorId = TerminalEditorInput.ID;
	readonly readOnly = true;
	readonly showBreadcrumbs = false;

	constructor(readonly resource: URI, readonly terminalInstance?: ITerminalInstance, readonly onDidChangeLabel?: Event<void>) {
		parseTerminalUri(resource);
	}

	get label(): string { return this.terminalInstance?.title ?? (this.resource.fragment || terminalStrings.terminal); }
	getIcon(): ITerminalInstance['profile']['icon'] { return this.terminalInstance?.profile.icon; }
}
