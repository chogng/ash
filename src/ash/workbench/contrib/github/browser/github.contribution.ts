import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerEditorPane } from '../../../browser/editor.js';
import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import { ActiveEditorContext } from '../../../common/contextkeys.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { GitHubEditor, githubEditorId } from './githubEditor.js';
import { GitHubReviewModel, IGitHubReviewModel } from './githubReviewModel.js';

registerSingleton(IGitHubReviewModel, GitHubReviewModel, InstantiationType.Delayed);
registerEditorPane({
	id: githubEditorId, name: localize('github.editor.title', 'GitHub Pull Requests and Issues'),
	canOpen: input => input.resource.scheme === 'ash-github' ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: options => {
		if (!options.instantiationService) { throw new Error('GitHub editor requires Workbench services'); }
		return options.instantiationService.createInstance(GitHubEditor);
	},
});

registerAction2(class OpenGitHub extends Action2 {
	constructor() { super({ id: 'workbench.action.github.open', title: localize2('github.editor.title', 'GitHub Pull Requests and Issues'), f1: true }); }
	public override run(accessor: ServicesAccessor): Promise<unknown> {
		return accessor.get(IEditorService).openEditor({ resource: URI.parse('ash-github:/'), label: localize('github.editor.title', 'GitHub Pull Requests and Issues'), readOnly: true, showBreadcrumbs: false });
	}
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.GitHubEditor, defaultValue: true,
	parse: value => { if (typeof value !== 'boolean') { throw new TypeError('GitHub editor accessibility verbosity must be boolean'); } return value; },
	setting: { valueType: 'boolean', title: localize('github.editor.verbosity', 'GitHub editor accessibility help'), description: localize('github.editor.verbosityDescription', 'Announce how to open keyboard help in the GitHub editor.') },
});

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		type, priority: 100, name: `githubEditor.${type}`, when: ActiveEditorContext.isEqualTo(githubEditorId),
		getProvider: accessor => {
			const pane = accessor.get(IEditorPart).activePane;
			if (!(pane instanceof GitHubEditor)) { return undefined; }
			const focused = pane.getControl().ownerDocument.activeElement;
			return new AccessibleContentProvider(AccessibleViewProviderId.GitHubEditor, { type },
				() => type === AccessibleViewType.Help ? localize('github.editor.help', 'Use Tab and Shift+Tab to move between repository fields, lists, diff editors and review actions. Use the arrow keys in the PR and issue list. Select a changed file and place the cursor on an original or modified diff line before adding a line comment. Add comments to the draft, then submit a review, approve or request changes. Drafts remain in this window when you close the tab. Refresh loads the latest commit; an older draft must be discarded before reviewing a changed PR. Checks and discussions have Load more actions. Merge asks you to confirm the reviewed commit. Alt+F1 opens this help; Escape closes it. Switching GitHub accounts clears private content and drafts. Choose an account in the header; Connect with token supports your Enterprise host. Reviewer actions request or remove users and teams. Your own review comments have edit and delete actions. Local repository actions choose the checkout and remote before checking out the reviewed commit or pushing local commits. Select Notifications and load to browse your account inbox; filter unread, all, or participating notifications, and use the read actions. The repository menu creates forks and starts Enterprise browser authorization. Notifications require OAuth App authorization or a classic token with notifications permission. Request Codex review posts @codex review as your GitHub account. Codex review settings opens the shared settings page for official Connector authorization and automatic review management. Refresh and Load more PR comments read the resulting conversation.') : pane.accessibleContent(),
				() => { if (focused instanceof HTMLElement && focused.isConnected) { focused.focus(); } else { pane.focus(); } }, AccessibilityVerbositySettingId.GitHubEditor);
		},
	});
}

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.GitHubSettings, defaultValue: true,
	parse: value => { if (typeof value !== 'boolean') { throw new TypeError('GitHub settings accessibility verbosity must be boolean'); } return value; },
	setting: { valueType: 'boolean', get title() { return localize('github.settings.verbosity', 'GitHub settings accessibility help'); }, get description() { return localize('github.settings.verbosityDescription', 'Announce how to open accessibility help in GitHub settings.'); } },
});
