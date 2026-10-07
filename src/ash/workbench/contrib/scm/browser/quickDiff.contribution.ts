import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import type { ScmDiffDecorationsIgnoreTrimWhitespace } from '../common/quickDiff.js';
import { localize2 } from '../../../../nls.js';
import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import { type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../../editor/browser/editorExtensions.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ActiveEditorContext } from '../../../common/contextkeys.js';
import { CODE_EDITOR_ID } from '../../../browser/parts/editor/textResourceEditor.js';
import { IQuickDiffEditorControllerService, IQuickDiffModelService, IQuickDiffService } from '../common/quickDiff.js';
import { QuickDiffEditorController, QuickDiffEditorControllerService } from './quickDiffWidget.js';
import { QuickDiffModelService } from './quickDiffModel.js';
import { QuickDiffService } from '../common/quickDiffService.js';

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
type ScmDiffDecorations = 'all' | 'gutter' | 'overview' | 'minimap' | 'none';
type ScmDiffDecorationsGutterAction = 'diff' | 'none';

configurationRegistry.registerConfiguration<ScmDiffDecorations>({
	key: 'scm.diffDecorations',
	defaultValue: 'all',
	parse(value: unknown): ScmDiffDecorations {
		if (value !== 'all' && value !== 'gutter' && value !== 'overview' && value !== 'minimap' && value !== 'none') {
			throw new TypeError('scm.diffDecorations must be all, gutter, overview, minimap, or none');
		}
		return value;
	},
});
configurationRegistry.registerConfiguration<ScmDiffDecorationsIgnoreTrimWhitespace>({
	key: 'scm.diffDecorationsIgnoreTrimWhitespace',
	defaultValue: 'false',
	parse(value: unknown): ScmDiffDecorationsIgnoreTrimWhitespace {
		if (value === 'true' || value === 'false' || value === 'inherit') return value;
		throw new TypeError('scm.diffDecorationsIgnoreTrimWhitespace must be true, false, or inherit');
	},
	setting: {
		title: 'Quick Diff whitespace',
		description: 'Choose whether Source Control diff decorations ignore leading and trailing whitespace.',
		valueType: 'select',
		options: [
			{ value: 'true', label: 'Ignore whitespace' },
			{ value: 'false', label: 'Show whitespace changes' },
			{ value: 'inherit', label: 'Inherit Diff editor setting' },
		],
	},
});
configurationRegistry.registerConfiguration<ScmDiffDecorationsGutterAction>({
	key: 'scm.diffDecorationsGutterAction',
	defaultValue: 'diff',
	parse(value: unknown): ScmDiffDecorationsGutterAction {
		if (value !== 'diff' && value !== 'none') throw new TypeError('scm.diffDecorationsGutterAction must be diff or none');
		return value;
	},
});

registerSingleton(IQuickDiffService, QuickDiffService, InstantiationType.Delayed);
registerSingleton(IQuickDiffEditorControllerService, QuickDiffEditorControllerService, InstantiationType.Delayed);
registerSingleton(IQuickDiffModelService, QuickDiffModelService, InstantiationType.Delayed);

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
			title: localize2({ bundle: 'ash.workbench', key: 'command.scm.quickDiff.next' }, 'Go to Next Quick Diff Change'),
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
			title: localize2({ bundle: 'ash.workbench', key: 'command.scm.quickDiff.previous' }, 'Go to Previous Quick Diff Change'),
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
		super({ id: 'scm.quickDiff.close', title: localize2({ bundle: 'ash.workbench', key: 'command.scm.quickDiff.close' }, 'Close Quick Diff'), f1: true, precondition: CodeEditorActive });
	}
	override run(accessor: ServicesAccessor): void {
		accessor.get(IQuickDiffEditorControllerService).activeController?.close();
	}
});
