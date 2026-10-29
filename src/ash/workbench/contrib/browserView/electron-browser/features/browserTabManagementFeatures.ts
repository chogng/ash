import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import {
	BrowserViewStorageScope,
	BrowserViewCommandId,
	normalizeBrowserViewUrl,
} from '../../../../../platform/browserView/common/browserView.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { filterQuickPickItems } from '../../../../../platform/quickinput/browser/quickInputList.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IBrowserViewWorkbenchService } from '../../common/browserView.js';

interface BrowserTabPick extends IQuickPickItem {
	readonly viewId?: string;
}

registerAction2(
	class QuickOpenBrowserAction extends Action2 {
		constructor() {
			super({
				id: BrowserViewCommandId.QuickOpen,
				title: localize2(
					{ bundle: 'ash.workbench', key: 'browser.quickOpenAction' },
					'Browser: Quick Open Browser Tab…',
				),
				f1: true,
			});
		}

		public override async run(accessor: ServicesAccessor): Promise<void> {
			const browsers = accessor.get(IBrowserViewWorkbenchService);
			const editors = accessor.get(IEditorService);
			const quickInput = accessor.get(IQuickInputService);
			await browsers.initialize();
			using picker = quickInput.createQuickPick<BrowserTabPick>();
			using listeners = new DisposableStore();
			using labels = new DisposableStore();
			picker.ariaLabel = localize({ bundle: 'ash.workbench', key: 'browser.tabs' }, 'Browser tabs');
			picker.placeholder = localize(
				{ bundle: 'ash.workbench', key: 'browser.tabSearch' },
				'Search browser tabs by title or address',
			);
			picker.sortByLabel = false;
			const newTab: BrowserTabPick = {
				label: localize({ bundle: 'ash.workbench', key: 'browser.newTab' }, 'Open new browser tab'),
				alwaysShow: true,
			};
			const render = (): void => {
				const active = picker.activeItems[0];
				const items = [...browsers.getContextualBrowserViews().values()].map(input => ({
					viewId: input.id,
					label: input.label,
					description: input.model?.state.url ?? input.serialize().url,
				}));
				const picks: BrowserTabPick[] = [...filterQuickPickItems(items, picker.value), newTab];
				picker.items = picks;
				const retained = active && picks.find(item => item.viewId === active.viewId);
				if (retained) {
					picker.activeItems = [retained];
				}
			};
			const refresh = (): void => {
				labels.clear();
				for (const input of browsers.getContextualBrowserViews().values()) {
					labels.add(input.onDidChangeLabel(render));
				}
				render();
			};
			let request: BrowserTabPick | undefined;
			await new Promise<void>(resolve => {
				listeners.add(picker.onDidHide(resolve));
				listeners.add(
					picker.onDidAccept(() => {
						request = picker.selectedItems[0];
						picker.hide();
					}),
				);
				listeners.add(picker.onDidChangeValue(render));
				listeners.add(browsers.onDidChangeBrowserViews(refresh));
				refresh();
				picker.show();
			});
			if (!request) {
				return;
			}
			if (request.viewId) {
				// Selection may outlive a page close or a Session switch while the picker is being dismissed.
				const input = browsers.getContextualBrowserViews().get(request.viewId);
				if (input && !input.isDisposed) {
					await editors.openEditor(input, { pinned: true });
				}
			} else {
				await browsers.createBrowserView({ initialUrl: 'about:blank', owner: { type: 'user' } });
			}
		}
	},
);

import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IEditorPart } from '../../../../browser/parts/editor/editorPart.js';
import { BrowserEditorInput } from '../../common/browserEditorInput.js';

for (const id of [BrowserViewCommandId.Open, BrowserViewCommandId.NewTab]) {
	registerAction2(
		class OpenBrowserAction extends Action2 {
			constructor() {
				super({
					id,
					title:
						id === BrowserViewCommandId.Open
							? localize2(
									{ bundle: 'ash.workbench', key: 'command.OpenBrowser' },
									'Browser: Open Browser',
								)
							: localize2({ bundle: 'ash.workbench', key: 'browser.newTabCommand' }, 'Browser: New Tab'),
					f1: true,
				});
			}
			override async run(accessor: ServicesAccessor, url?: unknown): Promise<void> {
				if (url !== undefined && typeof url !== 'string') {
					throw new TypeError('Invalid browser address');
				}
				await accessor
					.get(IBrowserViewWorkbenchService)
					.createBrowserView({
						initialUrl: normalizeBrowserViewUrl(url ?? 'about:blank'),
						owner: { type: 'user' },
					});
			}
		},
	);
}
registerAction2(
	class OpenBrowserFileAction extends Action2 {
		constructor() {
			super({
				id: BrowserViewCommandId.OpenFile,
				title: localize2({ bundle: 'ash.workbench', key: 'browser.openFileCommand' }, 'Browser: Open File'),
				f1: true,
			});
		}
		override async run(accessor: ServicesAccessor): Promise<void> {
			const files = await accessor
				.get(IFileDialogService)
				.showOpenDialog({
					canSelectFiles: true,
					canSelectFolders: false,
					canSelectMany: false,
					availableFileSystems: ['file'],
				});
			if (files?.[0]) {
				await accessor
					.get(IBrowserViewWorkbenchService)
					.createBrowserView({ initialUrl: files[0].toString(), owner: { type: 'user' } });
			}
		}
	},
);
for (const id of [BrowserViewCommandId.CloseAll, BrowserViewCommandId.CloseAllInGroup]) {
	registerAction2(
		class CloseBrowserTabsAction extends Action2 {
			constructor() {
				super({
					id,
					title:
						id === BrowserViewCommandId.CloseAll
							? localize2(
									{ bundle: 'ash.workbench', key: 'browser.closeAllCommand' },
									'Browser: Close All Tabs',
								)
							: localize2(
									{ bundle: 'ash.workbench', key: 'browser.closeGroupCommand' },
									'Browser: Close Tabs in Group',
								),
					f1: true,
				});
			}
			override async run(accessor: ServicesAccessor): Promise<void> {
				const part = accessor.get(IEditorPart);
				const groups = id === BrowserViewCommandId.CloseAllInGroup ? [part.activeGroup] : [...part.groups];
				for (const group of groups) {
					for (const input of [...group.inputs]) {
						if (input instanceof BrowserEditorInput) {
							await group.closeEditor(input);
						}
					}
				}
			}
		},
	);
}

import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { URI } from '../../../../../base/common/uri.js';
import { OpenSettingsCommandId } from '../../../../contrib/preferences/common/preferences.js';
registerAction2(
	class OpenBrowserExternallyAction extends Action2 {
		constructor() {
			super({
				id: BrowserViewCommandId.OpenExternal,
				title: localize2(
					{ bundle: 'ash.workbench', key: 'browser.externalCommand' },
					'Browser: Open in System Browser',
				),
				f1: true,
			});
		}
		override async run(accessor: ServicesAccessor): Promise<void> {
			const input = accessor.get(IEditorService).activeEditor;
			if (input instanceof BrowserEditorInput && input.model && /^https?:/u.test(input.model.state.url)) {
				await accessor
					.get(IOpenerService)
					.open(URI.parse(input.model.state.url), {
						openExternal: true,
						allowContributedOpeners: false,
						allowCommands: false,
					});
			}
		}
	},
);
registerAction2(
	class OpenBrowserSettingsAction extends Action2 {
		constructor() {
			super({
				id: BrowserViewCommandId.OpenSettings,
				title: localize2({ bundle: 'ash.workbench', key: 'browser.settingsCommand' }, 'Browser: Open Settings'),
				f1: true,
			});
		}
		override async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(ICommandService).executeCommand(OpenSettingsCommandId, 'Browser');
		}
	},
);
