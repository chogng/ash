import './media/markdown.css';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerEditorPane } from '../../../browser/editor.js';
import { resolveCommandsContext } from '../../../browser/parts/editor/editorCommandsContext.js';
import { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { CODE_EDITOR_ID } from '../../../browser/parts/editor/textResourceEditor.js';
import { ActiveEditorContext, ResourceLanguageIdContext } from '../../../common/contextkeys.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { CustomEditorInput } from '../../customEditor/browser/customEditorInput.js';
import '../../customEditor/browser/customEditorInputFactory.js';
import { MARKDOWN_EDITOR_ID } from '../common/arkdownEditor.js';
import { MarkdownImageDropOrPaste } from './markdownImageDropOrPaste.js';

registerWorkbenchContribution('workbench.markdown.imageDropOrPaste', WorkbenchPhase.BlockRestore,
	accessor => accessor.get(IInstantiationService).createInstance(MarkdownImageDropOrPaste));

const editorId = MARKDOWN_EDITOR_ID;
const previewId = 'vscode.markdown.preview.editor';
const markdownFile = /\.(?:md|markdown|mdown|mkd|mkdn)$/iu;

function supportsMarkdown(input: IResourceEditorInput): boolean {
	return (!input.editorId || input.editorId === CODE_EDITOR_ID || input.editorId === previewId || input.editorId === editorId)
		&& (input.languageId === 'markdown' || markdownFile.test(input.resource.path));
}

registerEditorPane({
	id: editorId,
	name: localize({ bundle: 'ash.arkdown', key: 'markdownEditor' }, 'Markdown Editor'),
	canOpen: input => supportsMarkdown(input) ? EditorPaneMatch.Optional : EditorPaneMatch.None,
	createInput: input => input.editorId === editorId ? input : new CustomEditorInput(input.toUntyped?.() ?? input, editorId),
	create: async options => {
		if (!options.instantiationService) throw new Error('The Markdown editor requires Workbench services');
		const { ArkdownEditorPane } = await import('./arkdown/arkdownEditorPane.js');
		return options.instantiationService.createInstance(ArkdownEditorPane, { id: editorId, onSave: options.onSave, fileEditor: true });
	},
});

const formattedMarkdown = ContextKeyExpr.or(ActiveEditorContext.isEqualTo(previewId), ActiveEditorContext.isEqualTo(editorId));

function registerMarkdownEditorAction(id: string, title: ReturnType<typeof localize2>, targetId: string, replace: boolean, order: number): void {
	const source = targetId === CODE_EDITOR_ID;
	const precondition = ContextKeyExpr.and(ResourceLanguageIdContext.isEqualTo('markdown'),
		source ? formattedMarkdown : ContextKeyExpr.or(ActiveEditorContext.isEqualTo(CODE_EDITOR_ID), formattedMarkdown));
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id, title, icon: source ? Lxicon.bracket : Lxicon.edit, f1: true, precondition,
				menu: [
					{ id: MenuId.EditorTitleContext, group: '1_open', order },
					...(source && replace ? [{ id: MenuId.EditorTitle, group: 'navigation', order: 2, when: ActiveEditorContext.isEqualTo(previewId) }] : []),
				],
			});
		}

		async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
			const groups = accessor.get(IEditorGroupsService);
			const part = accessor.get(IEditorPart);
			const { groupedEditors, preserveFocus } = resolveCommandsContext(args, groups);
			for (const { group, editors } of groupedEditors) {
				const owner = part.groups.find(candidate => candidate.id === group.id);
				if (!owner) continue;
				for (const input of editors) {
					if (!supportsMarkdown(input)) continue;
					if (replace) {
						await owner.reopenEditorWith(input, targetId, preserveFocus);
					} else {
						const untyped = input.toUntyped?.() ?? input;
						const target = source ? untyped : input.editorId === editorId ? input : new CustomEditorInput(untyped, editorId);
						await owner.openEditor(target, { preferredEditorId: targetId, pinned: true, preserveFocus });
					}
				}
			}
		}
	});
}

registerMarkdownEditorAction('markdown.reopenAsRichEditor', localize2({ bundle: 'ash.arkdown', key: 'reopenMarkdownEditor' }, 'Reopen in Markdown Editor'), editorId, true, 11);
registerMarkdownEditorAction('markdown.showRichEditor', localize2({ bundle: 'ash.arkdown', key: 'openMarkdownEditor' }, 'Open Markdown Editor'), editorId, false, 12);
registerMarkdownEditorAction('markdown.showSource', localize2({ bundle: 'ash.arkdown', key: 'openSource' }, 'Show Source'), CODE_EDITOR_ID, false, 10);
registerMarkdownEditorAction('markdown.reopenAsSource', localize2({ bundle: 'ash.arkdown', key: 'reopenSource' }, 'Reopen as Source'), CODE_EDITOR_ID, true, 11);
