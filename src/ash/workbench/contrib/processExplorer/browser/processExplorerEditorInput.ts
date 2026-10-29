import type { IResourceEditorInput } from '../../../common/editor.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';

/** A stable resource identity lets repeated commands reveal the existing tab. */
export class ProcessExplorerEditorInput implements IResourceEditorInput {
	public static readonly ID = 'workbench.editor.processExplorer';
	public static readonly RESOURCE = URI.from({ scheme: 'process-explorer', path: '/default' });
	public readonly editorId = ProcessExplorerEditorInput.ID;
	public readonly resource = ProcessExplorerEditorInput.RESOURCE;
	public readonly readOnly = true;
	public readonly showBreadcrumbs = false;
	public get label(): string { return localize('processExplorer.title', 'Process Explorer'); }
}
