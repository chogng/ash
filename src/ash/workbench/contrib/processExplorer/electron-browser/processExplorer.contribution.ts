import '../browser/processExplorer.contribution.js';
import { localize } from '../../../../nls.js';
import { registerEditorPane } from '../../../browser/editor.js';
import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { ProcessExplorerEditor } from '../browser/processExplorerEditor.js';
import { ProcessExplorerEditorInput } from '../browser/processExplorerEditorInput.js';

registerEditorPane({
	id: ProcessExplorerEditorInput.ID,
	name: localize('processExplorer.title', 'Process Explorer'),
	canOpen: input => input.editorId === ProcessExplorerEditorInput.ID ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: options => {
		if (!options.instantiationService) { throw new Error('Process Explorer requires Workbench services'); }
		return options.instantiationService.createInstance(ProcessExplorerEditor);
	},
});
