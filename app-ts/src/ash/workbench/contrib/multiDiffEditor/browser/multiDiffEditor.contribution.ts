import { getBrowserTextModelService } from '../../../services/textmodelResolver/browser/browserTextModelService.js';
import { registerAction2 } from '../../../../platform/actions/common/actions.js';
import { registerEditorPane } from '../../../browser/parts/editor/editorRegistry.js';
import { getBrowserTextResourceStore } from '../../codeEditor/browser/browserTextResourceStore.js';
import { CodeEditorConfiguration } from '../../codeEditor/common/editorConfiguration.js';
import { IChatService } from '../../../services/chat/common/chatService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IGitService } from '../../../services/git/common/gitService.js';
import { IViewsService } from '../../../services/views/browser/viewsService.js';
import { ISessionsManagementService } from '../../../../sessions/services/sessions/common/sessionsManagementService.js';
import { matchMultiDiffEditor, MULTI_DIFF_EDITOR_ID } from './multiDiffEditorInput.js';
import { MultiDiffCollapseAllAction, MultiDiffExpandAllAction, MultiDiffGoToFileAction, MultiDiffGoToNextChangeAction, MultiDiffGoToPreviousChangeAction } from './multiDiffEditorActions.js';
import { MultiDiffEditorPane } from './multiDiffEditorPane.js';
import { OpenScmMultiDiffEditorAction } from './scmMultiDiffAction.js';

registerAction2(MultiDiffGoToNextChangeAction);
registerAction2(MultiDiffGoToPreviousChangeAction);
registerAction2(MultiDiffCollapseAllAction);
registerAction2(MultiDiffExpandAllAction);
registerAction2(MultiDiffGoToFileAction);
registerAction2(OpenScmMultiDiffEditorAction);

registerEditorPane({
	id: MULTI_DIFF_EDITOR_ID,
	name: 'Stanza Multi Diff',
	canOpen: matchMultiDiffEditor,
	create: options => {
		if (!options.textFileService) throw new Error('Stanza Multi Diff requires the Workbench text file service');
		if (!options.diffService) throw new Error('Stanza Multi Diff requires the Workbench diff service');
		const diffService = options.diffService;
		const instantiationService = options.instantiationService;
		if (!instantiationService) throw new Error('Stanza Multi Diff requires the Workbench instantiation service');
		const resourceStore = getBrowserTextResourceStore(options.textFileService);
		const configuration = options.configurationService;
		return instantiationService.createInstance(MultiDiffEditorPane, {
			modelService: getBrowserTextModelService(resourceStore),
			createComputationService: () => diffService.createComputationService(),
			lineHeight: configuration?.getValue(CodeEditorConfiguration.lineHeight),
			fontFamily: configuration?.getValue(CodeEditorConfiguration.fontFamily) || undefined,
			fontSize: configuration?.getValue(CodeEditorConfiguration.fontSize),
			fontLigatures: configuration?.getValue(CodeEditorConfiguration.fontLigatures),
			showLineNumbers: configuration?.getValue(CodeEditorConfiguration.diffShowLineNumbers),
			showInlineChanges: configuration?.getValue(CodeEditorConfiguration.diffShowInlineChanges),
			loopChanges: configuration?.getValue(CodeEditorConfiguration.diffLoopChanges),
			gitService: instantiationService.getOptional(IGitService),
			chatService: instantiationService.getOptional(IChatService),
			sessionsService: instantiationService.getOptional(ISessionsManagementService),
			editorService: instantiationService.getOptional(IEditorService),
			viewsService: instantiationService.getOptional(IViewsService),
			fileActions: options.actionServices,
		});
	},
});
