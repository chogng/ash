import { localize, localize2 } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerEditorPane } from '../../../browser/editor.js';
import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import { ActiveEditorContext } from '../../../common/contextkeys.js';
import { IIssueFormService, IWorkbenchIssueService, type IssueReporterData } from '../common/issue.js';
import { WorkbenchIssueService, issueReporterEditorId } from './issueService.js';
import { IssueReporterEditorPane } from './issueReporterEditorPane.js';

registerSingleton(IWorkbenchIssueService, WorkbenchIssueService, InstantiationType.Delayed);
registerEditorPane({
	id: issueReporterEditorId, name: localize('issue.title', 'Report an issue'),
	canOpen: input => input.resource.toString() === 'ash-issue:/report' ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: options => {
		if (!options.instantiationService) { throw new Error('Issue reporter requires Workbench services'); }
		return options.instantiationService.createInstance(IssueReporterEditorPane);
	},
});

for (const id of ['workbench.action.openIssueReporter', 'vscode.openIssueReporter']) {
	registerAction2(class OpenIssueReporter extends Action2 {
		constructor() { super({ id, title: localize2('issue.title', 'Report an issue'), f1: id === 'workbench.action.openIssueReporter' }); }
		override run(accessor: ServicesAccessor, data?: IssueReporterData): Promise<void> { return accessor.get(IWorkbenchIssueService).openReporter(data); }
	});
}

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.IssueReporter, defaultValue: true,
	parse: value => { if (typeof value !== 'boolean') { throw new TypeError('Issue reporter accessibility verbosity must be boolean'); } return value; },
	setting: { valueType: 'boolean', title: localize('issue.verbosity', 'Issue reporter accessibility help'), description: localize('issue.verbosityDescription', 'Announce how to open keyboard help in the issue reporter.') },
});

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		type, priority: 100, name: `issueReporter.${type}`, when: ActiveEditorContext.isEqualTo(issueReporterEditorId),
		getProvider: accessor => {
			const pane = accessor.get(IEditorPart).activePane;
			if (!(pane instanceof IssueReporterEditorPane)) { return undefined; }
			const form = accessor.get(IIssueFormService);
			const focused = pane.getControl().ownerDocument.activeElement;
			return new AccessibleContentProvider(AccessibleViewProviderId.IssueReporter, { type },
				() => type === AccessibleViewType.Help ? localize('issue.help', 'Use Tab and Shift+Tab to move between the issue type, title, description, diagnostic checkboxes and actions. Preview shows the exact report that will be sent. Search similar issues works without signing in. Sign in to GitHub before submitting. A successful submission shows the new issue link. Closing this tab keeps your draft until the window closes. Use New report after submission to start another. Escape closes accessibility help.') + '\n\n' + localize('issue.diagnosticsHelp', 'System information lists App Server and browser details separately. Desktop reports also include local system and process metrics.') : `${form.state.issueTitle}\n\n${form.serialize()}\n\n${form.state.similarIssues.map(issue => `${issue.title}\n${issue.html_url}`).join('\n')}`,
				() => { if (focused instanceof HTMLElement && focused.isConnected) { focused.focus(); } }, AccessibilityVerbositySettingId.IssueReporter);
		},
	});
}
