import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../../editor/browser/editorExtensions.js';
import { registerWorkbenchServiceContribution } from '../../../browser/workbenchServiceContributions.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { ActiveEditorContext } from '../../../common/contextkeys.js';
import { IGitService } from '../../../services/git/common/gitService.js';
import { IDiffService } from '../../../services/diff/common/diffService.js';
import { CODE_EDITOR_ID } from '../../../browser/parts/editor/textResourceEditor.js';
import { IQuickDiffEditorControllerService, IQuickDiffModelService, IQuickDiffService } from '../common/quickDiff.js';
import { GitQuickDiffProvider } from './gitQuickDiffProvider.js';
import { QuickDiffEditorController, QuickDiffEditorControllerService } from './quickDiffEditorController.js';
import { QuickDiffModelService } from './quickDiffModel.js';
import { WorkbenchQuickDiffService } from './workbenchQuickDiffService.js';

registerWorkbenchServiceContribution({
	service: IQuickDiffService,
	dependencies: [],
	install: context => context.register(new WorkbenchQuickDiffService()),
});

registerWorkbenchServiceContribution({
	service: IQuickDiffEditorControllerService,
	dependencies: [],
	install: context => context.register(new QuickDiffEditorControllerService()),
});

registerWorkbenchServiceContribution({
	service: IQuickDiffModelService,
	dependencies: [IQuickDiffService, IDiffService, IConfigurationService],
	install: context => context.register(context.container.createInstance(QuickDiffModelService, context.container.get(IQuickDiffService), context.container.get(IDiffService))),
});

registerWorkbenchContribution('workbench.contrib.gitQuickDiffProvider', WorkbenchPhase.BlockRestore, accessor => {
	const resources = new DisposableStore();
	const provider = resources.add(new GitQuickDiffProvider(accessor.get(IGitService)));
	resources.add(accessor.get(IQuickDiffService).addProvider(provider));
	return resources;
});

registerEditorContribution({
	id: 'workbench.contrib.quickDiffEditorController',
	instantiation: EditorContributionInstantiation.AfterFirstRender,
	install: context => {
		if (context.kind !== 'text') return;
		return context.instantiationService.createInstance(QuickDiffEditorController, context.editor, context.view);
	},
});

const CodeEditorActive = ActiveEditorContext.isEqualTo(CODE_EDITOR_ID);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'scm.quickDiff.next',
			title: 'Go to Next Quick Diff Change',
			f1: true,
			precondition: CodeEditorActive,
			keybinding: { primary: Keybinding.single(logicalKey('F3', { altKey: true })), when: CodeEditorActive },
		});
	}
	override run(accessor: ServicesAccessor): void {
		accessor.get(IQuickDiffEditorControllerService).activeController?.showNextChange();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'scm.quickDiff.previous',
			title: 'Go to Previous Quick Diff Change',
			f1: true,
			precondition: CodeEditorActive,
			keybinding: { primary: Keybinding.single(logicalKey('F3', { altKey: true, shiftKey: true })), when: CodeEditorActive },
		});
	}
	override run(accessor: ServicesAccessor): void {
		accessor.get(IQuickDiffEditorControllerService).activeController?.showPreviousChange();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'scm.quickDiff.close', title: 'Close Quick Diff', f1: true, precondition: CodeEditorActive });
	}
	override run(accessor: ServicesAccessor): void {
		accessor.get(IQuickDiffEditorControllerService).activeController?.close();
	}
});
