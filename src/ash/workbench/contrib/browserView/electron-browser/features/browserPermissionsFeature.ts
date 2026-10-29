import { BrowserNavigationFeatures } from './browserNavigationFeatures.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import type { IAction } from '../../../../../base/common/actions.js';
import { localize } from '../../../../../nls.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IBrowserViewService } from '../../../../../platform/browserView/common/browserView.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import type { IBrowserViewModel } from '../../common/browserView.js';

/** User sharing is explicit and backend-authorized; permission reset stays scoped to the page session. */
export class BrowserPermissionsFeature extends Disposable {
	private model: IBrowserViewModel | undefined;
	constructor(
		private readonly status: (message: string) => void,
		private readonly report: (error: unknown) => void,
		@IDialogService private readonly dialogService: IDialogService,
		@IChatSessionNavigationService private readonly conversations: IChatSessionNavigationService,
		@IBrowserViewService private readonly pageService: IBrowserViewService,
	) {
		super();
	}
	public setModel(model: IBrowserViewModel | undefined): void {
		this.model = model;
	}
	public getActions(): readonly IAction[] {
		return [
			{
				id: 'browser.managePermissions',
				label: localize({ bundle: 'ash.workbench', key: 'browser.managePermissions' }, 'Manage website permissions'),
				enabled: !!toOriginKey(this.model?.state.url),
				tooltip: '',
				run: () => this.manage().catch(this.report),
			},
			{
				id: 'browser.share',
				label: localize({ bundle: 'ash.workbench', key: 'browser.share' }, 'Share with Agent'),
				enabled: this.model?.info.owner.type === 'user',
				tooltip: '',
				run: () => this.share().catch(this.report),
			},
			{
				id: 'browser.permissions',
				label: localize({ bundle: 'ash.workbench', key: 'browser.resetPermissions' }, 'Reset all website permissions'),
				enabled: !!this.model,
				tooltip: '',
				run: () => this.model && this.pageService.clearPermissions(this.model.id).catch(this.report),
			},
			{
				id: 'browser.cancelDownloads',
				label: localize({ bundle: 'ash.workbench', key: 'browser.cancelDownloads' }, 'Cancel downloads'),
				enabled: !!this.model,
				tooltip: '',
				run: () => this.model && this.pageService.cancelDownloads(this.model.id).catch(this.report),
			},
		];
	}
	public async manage(): Promise<void> {
		const model = this.model;
		const origin = toOriginKey(model?.state.url);
		if (!model || !origin) {
			return;
		}
		const category = await this.dialogService.prompt<PermissionCategory>({
			title: localize({ bundle: 'ash.workbench', key: 'browser.managePermissions' }, 'Manage website permissions'),
			message: origin,
			buttons: [
				{
					label: localize({ bundle: 'ash.workbench', key: 'browser.locationCategory' }, 'Location'),
					run: () => PermissionCategory.Location,
				},
				{
					label: localize({ bundle: 'ash.workbench', key: 'browser.cameraCategory' }, 'Camera'),
					run: () => PermissionCategory.Camera,
				},
				{
					label: localize({ bundle: 'ash.workbench', key: 'browser.microphoneCategory' }, 'Microphone'),
					run: () => PermissionCategory.Microphone,
				},
				{
					label: localize({ bundle: 'ash.workbench', key: 'browser.notificationsCategory' }, 'Notifications'),
					run: () => PermissionCategory.Notifications,
				},
				{
					label: localize({ bundle: 'ash.workbench', key: 'browser.clipboardCategory' }, 'Clipboard'),
					run: () => PermissionCategory.Clipboard,
				},
			],
			cancelButton: localize({ bundle: 'ash.workbench', key: 'browser.cancel' }, 'Cancel'),
		});
		if (category.result === undefined || this.isDisposed || this.model !== model || toOriginKey(model.state.url) !== origin) {
			return;
		}
		const result = await this.dialogService.prompt<{ state: PermissionDecision | null }>({
			title: localize({ bundle: 'ash.workbench', key: 'browser.managePermissions' }, 'Manage website permissions'),
			message: localize({ bundle: 'ash.workbench', key: 'browser.sitePermissionChoice' }, 'Choose the permission decision for {0}.', origin),
			detail: localize(
				{ bundle: 'ash.workbench', key: 'browser.sitePermissionCurrent' },
				'Current decision: {0}',
				model.state.permissions?.origins[origin]?.[category.result] === 'allow'
					? localize({ bundle: 'ash.workbench', key: 'browser.allow' }, 'Allow')
					: model.state.permissions?.origins[origin]?.[category.result] === 'deny'
						? localize({ bundle: 'ash.workbench', key: 'browser.deny' }, 'Deny')
						: localize({ bundle: 'ash.workbench', key: 'browser.permissionDefault' }, 'Restore default'),
			),
			buttons: [
				{
					label: localize({ bundle: 'ash.workbench', key: 'browser.allow' }, 'Allow'),
					run: () => ({ state: 'allow' }),
				},
				{
					label: localize({ bundle: 'ash.workbench', key: 'browser.deny' }, 'Deny'),
					run: () => ({ state: 'deny' }),
				},
				{
					label: localize({ bundle: 'ash.workbench', key: 'browser.permissionDefault' }, 'Restore default'),
					run: () => ({ state: null }),
				},
			],
			cancelButton: localize({ bundle: 'ash.workbench', key: 'browser.cancel' }, 'Cancel'),
		});
		if (result.result !== undefined && !this.isDisposed && this.model === model && toOriginKey(model.state.url) === origin) {
			await this.pageService.setPermissions(model.id, origin, [{ category: category.result, state: result.result.state }]);
		}
	}
	private async share(): Promise<void> {
		const model = this.model!;
		if (model.info.owner.type !== 'user') {
			return;
		}
		const audience = await model.getSharing();
		const choices = this.conversations.getConversations();
		const result = await this.dialogService.prompt<readonly string[]>({
			title: localize({ bundle: 'ash.workbench', key: 'browser.share' }, 'Share with Agent'),
			message: localize(
				{ bundle: 'ash.workbench', key: 'browser.shareDescription' },
				'Allow a conversation to observe this page, including its signed-in content. Agent input and navigation require an isolated Agent page. Access ends when you revoke it or this connection closes.',
			),
			detail: audience.length
				? localize({ bundle: 'ash.workbench', key: 'browser.shared' }, 'This page is currently shared.')
				: localize({ bundle: 'ash.workbench', key: 'browser.private' }, 'This page is private.'),
			buttons: [
				...choices.map(choice => ({ label: choice.title, run: () => [choice.threadId] })),
				{
					label: localize({ bundle: 'ash.workbench', key: 'browser.revoke' }, 'Revoke all access'),
					run: () => [],
				},
			],
			cancelButton: localize({ bundle: 'ash.workbench', key: 'browser.cancel' }, 'Cancel'),
		});
		if (result.result !== undefined && !this.isDisposed && this.model === model) {
			await model.setSharing(result.result);
			this.status(
				result.result.length
					? localize({ bundle: 'ash.workbench', key: 'browser.shared' }, 'This page is currently shared.')
					: localize({ bundle: 'ash.workbench', key: 'browser.private' }, 'This page is private.'),
			);
		}
	}
}

import { PermissionCategory, type PermissionDecision, toOriginKey } from '../../../../../platform/browserView/common/browserPermissions.js';

import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { BrowserViewCommandId } from '../../../../../platform/browserView/common/browserView.js';
import { IEditorPart } from '../../../../browser/parts/editor/editorPart.js';
import { BrowserViewEditorId } from '../../common/browserView.js';
import { ActiveEditorContext } from '../../../../common/contextkeys.js';
import { localize2 } from '../../../../../nls.js';
import type { BrowserEditor } from '../browserEditor.js';
registerAction2(
	class ManageBrowserPermissionsAction extends Action2 {
		constructor() {
			super({
				id: BrowserViewCommandId.ManagePermissions,
				title: localize2({ bundle: 'ash.workbench', key: 'browser.managePermissionsCommand' }, 'Browser: Manage Website Permissions'),
				f1: true,
				precondition: ActiveEditorContext.isEqualTo(BrowserViewEditorId),
			});
		}
		override async run(accessor: import('../../../../../platform/instantiation/common/instantiation.js').ServicesAccessor): Promise<void> {
			const pane = accessor.get(IEditorPart).activePane;
			if (pane?.id === BrowserViewEditorId) {
				await (pane as BrowserEditor).getContribution(BrowserNavigationFeatures)?.permissions.manage();
			}
		}
	},
);
