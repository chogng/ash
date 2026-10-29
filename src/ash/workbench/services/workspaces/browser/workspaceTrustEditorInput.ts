import { Disposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import type { IResourceEditorInput } from '../../../common/editor.js';

/** One window-owned permission page; its inputs never carry grants or session-host selection. */
export class WorkspaceTrustEditorInput extends Disposable implements IResourceEditorInput {
	static readonly ID = 'workbench.input.workspaceTrust';
	readonly resource = URI.parse('ash-workspace-trust:/workspaceTrustEditor');
	readonly contentType = WorkspaceTrustEditorInput.ID;
	readonly readOnly = true;
	get label(): string { return localize('workspaceTrust.editorTitle', 'Workspace Trust'); }
	getIcon(): typeof Lxicon.lock { return Lxicon.lock; }
}
