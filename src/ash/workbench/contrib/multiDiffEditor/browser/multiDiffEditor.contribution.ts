import { getBrowserTextModelService } from '../../../services/textmodelResolver/browser/browserTextModelService.js';
import { MenuId, MenusRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ToggleCollapseUnchangedRegions } from '../../../../editor/browser/widget/diffEditor/commands.js';
import { ActiveEditorContext } from '../../../common/contextkeys.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { registerEditorPane } from '../../../browser/editor.js';
import { getBrowserTextResourceStore } from '../../codeEditor/browser/browserTextResourceStore.js';
import { CodeEditorConfiguration } from '../../codeEditor/common/editorConfiguration.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IGitService } from '../../../contrib/git/common/gitService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { matchMultiDiffEditor, MULTI_DIFF_EDITOR_ID } from './multiDiffEditorInput.js';
import { MultiDiffCollapseAllAction, MultiDiffExpandAllAction, MultiDiffGoToFileAction, MultiDiffGoToNextChangeAction, MultiDiffGoToPreviousChangeAction } from './multiDiffEditorActions.js';
import { MultiDiffEditor } from './multiDiffEditor.js';
import { OpenScmMultiDiffEditorAction } from './scmMultiDiffAction.js';
import { IMultiDiffSourceResolverService, MultiDiffSourceResolverService } from './multiDiffSourceResolverService.js';

registerSingleton(IMultiDiffSourceResolverService, MultiDiffSourceResolverService, InstantiationType.Delayed);

registerAction2(MultiDiffGoToNextChangeAction);
registerAction2(MultiDiffGoToPreviousChangeAction);
registerAction2(MultiDiffCollapseAllAction);
registerAction2(MultiDiffExpandAllAction);
registerAction2(MultiDiffGoToFileAction);
registerAction2(OpenScmMultiDiffEditorAction);

MenusRegistry.appendMenuItem(MenuId.EditorTitle, {
	command: new ToggleCollapseUnchangedRegions().desc,
	when: ActiveEditorContext.isEqualTo(MULTI_DIFF_EDITOR_ID),
	group: 'navigation', order: 21,
});

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
		return instantiationService.createInstance(MultiDiffEditor, {
			modelService: getBrowserTextModelService(resourceStore, instantiationService),
			createComputationService: () => diffService.createComputationService(),
			lineHeight: configuration?.getValue(CodeEditorConfiguration.lineHeight),
			fontFamily: configuration?.getValue(CodeEditorConfiguration.fontFamily) || undefined,
			fontSize: configuration?.getValue(CodeEditorConfiguration.fontSize),
			fontLigatures: configuration?.getValue(CodeEditorConfiguration.fontLigatures),
			showLineNumbers: configuration?.getValue(CodeEditorConfiguration.diffShowLineNumbers),
			showInlineChanges: configuration?.getValue(CodeEditorConfiguration.diffShowInlineChanges),
			loopChanges: configuration?.getValue(CodeEditorConfiguration.diffLoopChanges),
			gitService: instantiationService.getOptional(IGitService),
			editorService: instantiationService.getOptional(IEditorService),
			viewsService: instantiationService.getOptional(IViewsService),
			fileActions: options.actionServices,
		});
	},
});
