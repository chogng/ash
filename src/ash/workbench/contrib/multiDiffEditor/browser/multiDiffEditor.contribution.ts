import { registerAction2 } from '../../../../platform/actions/common/actions.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { registerEditorPane } from '../../../browser/editor.js';
import { matchMultiDiffEditor, MULTI_DIFF_EDITOR_ID } from './multiDiffEditorInput.js';
import { MultiDiffCollapseAllAction, MultiDiffExpandAllAction, MultiDiffGoToFileAction, MultiDiffGoToNextChangeAction, MultiDiffGoToPreviousChangeAction, MultiDiffToggleCollapseAllAction, MultiDiffToggleCollapseUnchangedRegionsAction } from './multiDiffEditorActions.js';
import { MultiDiffEditor } from './multiDiffEditor.js';
import { IMultiDiffSourceResolverService, MultiDiffSourceResolverService } from './multiDiffSourceResolverService.js';

registerSingleton(IMultiDiffSourceResolverService, MultiDiffSourceResolverService, InstantiationType.Delayed);

registerAction2(MultiDiffGoToNextChangeAction);
registerAction2(MultiDiffGoToPreviousChangeAction);
registerAction2(MultiDiffCollapseAllAction);
registerAction2(MultiDiffExpandAllAction);
registerAction2(MultiDiffToggleCollapseAllAction);
registerAction2(MultiDiffGoToFileAction);
registerAction2(MultiDiffToggleCollapseUnchangedRegionsAction);

registerEditorPane({
	id: MULTI_DIFF_EDITOR_ID,
	name: 'Stanza Multi Diff',
	canOpen: matchMultiDiffEditor,
	create: options => {
		const instantiationService = options.instantiationService;
		if (!instantiationService) throw new Error('Stanza Multi Diff requires the Workbench instantiation service');
		return instantiationService.createInstance(MultiDiffEditor, {
			activeEditorId: options.input?.editorId,
		});
	},
});
