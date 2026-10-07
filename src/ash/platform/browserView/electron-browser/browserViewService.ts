import { BROWSER_VIEW_CLOSE_CHANNEL, BROWSER_VIEW_CREATE_CHANNEL, BROWSER_VIEW_EVENT_CHANNEL, BROWSER_VIEW_GO_BACK_CHANNEL, BROWSER_VIEW_GO_FORWARD_CHANNEL, BROWSER_VIEW_LAYOUT_CHANNEL, BROWSER_VIEW_NAVIGATE_CHANNEL, BROWSER_VIEW_RELOAD_CHANNEL, BROWSER_VIEW_STATE_CHANNEL, BROWSER_VIEW_STOP_CHANNEL, BROWSER_VIEW_VISIBILITY_CHANNEL, type BrowserViewEvent, type IBrowserViewService, type IBrowserViewState } from "../common/browserView.js";
import { invoke, subscribe } from "../../ipc/electron-browser/rendererIpc.js";
import { BROWSER_VIEW_FOCUS_CHANNEL, BROWSER_VIEW_LIST_CHANNEL, BROWSER_VIEW_SHARING_CHANNEL, type IBrowserViewInfo } from '../common/browserView.js';
import type { AppServerProtocolClient } from '../../app-server/browser/appServerProtocolClient.js';
import { APP_SERVER_METHODS } from '../../../../../.build/protocol/typescript/index.js';
import { BROWSER_VIEW_PERMISSION_CHANNEL, BROWSER_VIEW_PERMISSIONS_CLEAR_CHANNEL, BROWSER_VIEW_DOWNLOAD_CANCEL_CHANNEL } from '../common/browserView.js';
import { toDisposable } from '../../../base/common/lifecycle.js';

export function createBrowserViewService(client: AppServerProtocolClient): IBrowserViewService {
	return {
		respondToPermission: (id, requestId, allowed) => invoke<void>(BROWSER_VIEW_PERMISSION_CHANNEL, { targetId: id, requestId, allowed }),
		clearPermissions: id => invoke<void>(BROWSER_VIEW_PERMISSIONS_CLEAR_CHANNEL, { targetId: id }),
		cancelDownloads: id => invoke<void>(BROWSER_VIEW_DOWNLOAD_CANCEL_CHANNEL, { targetId: id }),
		getSharing: id => invoke<readonly string[]>(BROWSER_VIEW_SHARING_CHANNEL, { targetId: id }),
		setSharing: async (id, threadIds) => { await client.request(APP_SERVER_METHODS['browser/sharing/set'], { targetId: id, threadIds: [...threadIds] }); },
		getBrowserViews: () => invoke<IBrowserViewInfo[]>(BROWSER_VIEW_LIST_CHANNEL),
		getOrCreateBrowserView: (id, options) => invoke<IBrowserViewInfo>(BROWSER_VIEW_CREATE_CHANNEL, { targetId: id, options }),
		getState: id => invoke<IBrowserViewState>(BROWSER_VIEW_STATE_CHANNEL, { targetId: id }),
		layout: (id, bounds) => invoke<void>(BROWSER_VIEW_LAYOUT_CHANNEL, { targetId: id, bounds }),
		setVisible: (id, visible) => invoke<void>(BROWSER_VIEW_VISIBILITY_CHANNEL, { targetId: id, visible }),
		loadURL: (id, url) => invoke<void>(BROWSER_VIEW_NAVIGATE_CHANNEL, { targetId: id, url }),
		goBack: id => invoke<void>(BROWSER_VIEW_GO_BACK_CHANNEL, { targetId: id }),
		goForward: id => invoke<void>(BROWSER_VIEW_GO_FORWARD_CHANNEL, { targetId: id }),
		reload: id => invoke<void>(BROWSER_VIEW_RELOAD_CHANNEL, { targetId: id }),
		stop: id => invoke<void>(BROWSER_VIEW_STOP_CHANNEL, { targetId: id }),
		focus: id => invoke<void>(BROWSER_VIEW_FOCUS_CHANNEL, { targetId: id }),
		destroyBrowserView: id => invoke<void>(BROWSER_VIEW_CLOSE_CHANNEL, { targetId: id }),
		onDidEvent: listener => {
			const subscription = subscribe<BrowserViewEvent>(BROWSER_VIEW_EVENT_CHANNEL, listener);
			return toDisposable(() => subscription.dispose());
		},
	};
}
