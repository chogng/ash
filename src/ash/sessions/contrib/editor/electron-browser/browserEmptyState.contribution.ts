import { Button } from '../../../../base/browser/ui/button/button.js';
import { BrowserViewStorageScope } from '../../../../platform/browserView/common/browserView.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { localize } from '../../../../nls.js';
import type { IBrowserViewModel } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { BrowserEditor, BrowserEditorContribution, BrowserWidgetLocation, type IBrowserEditorWidget } from '../../../../workbench/contrib/browserView/electron-browser/browserEditor.js';
import { BrowserNavigationFeatures } from '../../../../workbench/contrib/browserView/electron-browser/features/browserNavigationFeatures.js';

/** Exposes the attached page's history from the Browser card's existing blank page. */
class SessionsBrowserEmptyState extends BrowserEditorContribution {
	private readonly historyButton: Button;

	constructor(editor: BrowserEditor) {
		super(editor);
		this.historyButton = this._register(new Button(editor.browserContainer.ownerDocument.createElement('div'), {
			...defaultButtonStyles,
			presentation: 'secondary',
			label: localize({ bundle: 'ash.workbench', key: 'browser.history' }, 'History'),
			onClick: () => {
				void editor.getContribution(BrowserNavigationFeatures)?.history.show().catch(error => editor.report(error));
			},
		}));
		this.historyButton.domNode.hidden = true;
	}

	public override get widgets(): readonly IBrowserEditorWidget[] {
		return [{ location: BrowserWidgetLocation.WelcomeActions, element: this.historyButton.domNode, order: 0 }];
	}

	public override get accessibilityHelp(): string | undefined {
		return this.historyButton.domNode.hidden ? undefined : localize('sessions.browser.blankHistoryHelp', 'On a blank Browser page, use Tab to reach History and press Enter to open visits from this storage session.');
	}

	protected override onModelAttached(model: IBrowserViewModel): void {
		const scope = model.info.session.scope;
		this.historyButton.domNode.hidden = scope !== BrowserViewStorageScope.Global && scope !== BrowserViewStorageScope.Workspace;
	}

	public override onModelDetached(): void {
		this.historyButton.domNode.hidden = true;
	}
}

BrowserEditor.registerContribution(SessionsBrowserEmptyState);
