import { Button } from '../../../../base/browser/ui/button/button.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IAccessibleViewService, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { ViewPane, type IViewPaneOptions } from '../../../../workbench/browser/parts/views/viewPane.js';
import type { CreatorModeContribution } from './creatorWorkspace.js';

const views = new WeakMap<Element, CreatorWorkspaceView>();

/** Each contribution owns an entry pane; opening it lazily creates its workspace. */
export class CreatorWorkspaceView extends ViewPane {
	constructor(
		private readonly contribution: CreatorModeContribution,
		parent: HTMLElement,
		options: IViewPaneOptions,
		@ICommandService commands: ICommandService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IAccessibleViewService accessibleViews: IAccessibleViewService,
	) {
		super(parent, { ...options, minimumBodySize: 52, maximumBodySize: 52 });
		this.contentElement.classList.add('ash-creator-navigation');
		views.set(this.contentElement, this);
		this._register(contextKeys.createScoped(this.contentElement)).createKey('sessionsCreatorNavigationFocused', true);
		const hint = accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.Creator);
		if (hint) { this.contentElement.setAttribute('aria-description', hint); }
		const button = this._register(new Button(this.contentElement, {
			label: contribution.title,
			icon: contribution.icon,
			onClick: () => { void commands.executeCommand('sessions.creator.openMode', contribution.id); },
		}));
		button.domNode.setAttribute('aria-description', contribution.description);
	}

	public static getFocused(element: HTMLElement): CreatorWorkspaceView | undefined {
		const root = element.closest('.ash-creator-navigation');
		return root ? views.get(root) : undefined;
	}

	public getAccessibleContent(): string { return `${this.contribution.title}: ${this.contribution.description}\n${this.contribution.help}`; }
	public focus(): void { this.contentElement.querySelector<HTMLButtonElement>('button')!.focus(); }
}
