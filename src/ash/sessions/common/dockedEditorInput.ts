import type { URI } from '../../base/common/uri.js';
import { EditorInputCapabilities, type IResourceEditorInput } from '../../workbench/common/editor.js';

/**
 * Resource-only detail tabs share input capabilities without acquiring document leases.
 * Their panes own resolved content; the desktop layout owns visibility and close protection.
 */
export abstract class DockedEditorInput implements IResourceEditorInput {
	public abstract readonly resource: URI;
	public abstract readonly label: string;
	public readonly readOnly = true;
	public readonly showBreadcrumbs = false;
	private restrictions = EditorInputCapabilities.None;

	public get capabilities(): EditorInputCapabilities {
		return this.restrictions | EditorInputCapabilities.ExcludeFromEditorLimit;
	}

	public set capabilities(value: EditorInputCapabilities) {
		// A visibility transition may change close protection, but cannot remove the limit exemption.
		this.restrictions = value;
	}
}
