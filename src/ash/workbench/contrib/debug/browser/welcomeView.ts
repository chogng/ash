import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService, ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ViewPane, type IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { OpenFolderWorkspaceSupportContext, BrowserLocalFolderSupportContext } from '../../../common/contextkeys.js';
import { DEBUG_CONFIGURE_COMMAND_ID } from './debugCommands.js';

/** Owns welcome content and configuration requests while the sidebar owns pane visibility. */
export class WelcomeView extends ViewPane {
	public static readonly ID = 'workbench.debug.welcome';
	private readonly button: Button;
	private readonly description: HTMLElement;
	private readonly configurationRequest = this._register(new MutableDisposable<DisposableStore>());

	constructor(container: HTMLElement, options: IViewPaneOptions,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IFileDialogService private readonly fileDialogs: IFileDialogService,
		@IContextKeyService private readonly contexts: IContextKeyService,
		@ICommandService private readonly commands: ICommandService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super(container, { minimumBodySize: 32, ...options });
		this.element.classList.add('ash-debug-section');
		this.contentElement.classList.add('ash-debug-section-content', 'ash-debug-welcome-content');
		this.button = this._register(new Button(this.contentElement, {
			...defaultButtonStyles,
			label: localize('debug.createLaunch', 'Create a launch.json file'),
			presentation: 'primary',
			onClick: () => {
				void this.configure().catch(error => {
					if (!isCancellationError(error)) {
						this.notifications.error(error instanceof Error ? error.message : String(error));
					}
				});
			},
		}));
		this.description = h(container.ownerDocument, 'p');
		this.contentElement.append(this.description);
		this._register(workspace.onDidChangeWorkspace(() => this.updateWelcome()));
		this.updateWelcome();
		this._register(this.onDidChangeVisibility(visible => {
			if (!visible) this.configurationRequest.clear();
		}));
	}

	private updateWelcome(): void {
		const hasFolder = this.workspace.getWorkspace().folders.length > 0;
		this.button.label = hasFolder ? localize('debug.createLaunch', 'Create a launch.json file') : localize('debug.openFolder', 'Open Folder');
		this.button.enabled = hasFolder || this.contexts.contextMatchesRules(ContextKeyExpr.or(OpenFolderWorkspaceSupportContext.isEqualTo(true), BrowserLocalFolderSupportContext.isEqualTo(true)));
		this.description.textContent = hasFolder
			? localize('debug.welcomeConfigure', 'To customize Run and Debug, create a launch.json file and add a debug configuration.')
			: localize('debug.welcomeOpenFolder', 'To customize Run and Debug, open a folder and create a launch.json file.');
	}

	private async configure(): Promise<void> {
		if (this.workspace.getWorkspace().folders.length === 0) {
			await this.fileDialogs.pickFolderAndOpen();
			return;
		}
		const controller = new AbortController();
		const lifetime = new DisposableStore();
		lifetime.add(toDisposable(() => controller.abort()));
		lifetime.add(this.workspace.onDidChangeWorkspace(() => controller.abort()));
		this.configurationRequest.value = lifetime;
		try {
			await this.commands.executeCommand(DEBUG_CONFIGURE_COMMAND_ID, undefined, false, controller.signal);
		} finally {
			if (this.configurationRequest.value === lifetime) {
				this.configurationRequest.clear();
			}
		}
	}
}
