import type { IResourceEditorInput } from '../../../common/editor.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { DISASSEMBLY_VIEW_ID } from './debug.js';

/** One editor identity follows the active debug session rather than a stored address. */
export class DisassemblyViewInput implements IResourceEditorInput {
	public static readonly ID = 'debug.disassemblyView.input';
	public readonly editorId = DISASSEMBLY_VIEW_ID;
	public readonly resource = URI.from({ scheme: Schemas.internal, authority: 'debug', path: '/disassembly' });
	public readonly readOnly = true;
	public readonly showBreadcrumbs = false;
	public get label(): string { return localize('debug.disassembly', 'Disassembly'); }
}
