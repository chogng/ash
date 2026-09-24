import type { BrowserWindow } from "electron/main";
import { dialog } from "electron/main";
import type { IRemoteWindowMainHost } from "./remoteWindowMainContext.js";

/** Binds Remote window prompts and events to one trusted Electron window. */
export function electronRemoteWindowMainHost(window: BrowserWindow): IRemoteWindowMainHost {
	return {
		send: (channel, payload) => {
			if (!window.isDestroyed()) window.webContents.send(channel, payload);
		},
		confirmRuntimeRollback: async () => {
			if (window.isDestroyed()) throw new Error("Remote runtime rollback requires an open window");
			const confirmation = await dialog.showMessageBox(window, {
				type: "warning",
				title: "Roll back Remote runtime",
				message: "Use the previous verified Remote runtime?",
				detail: "Ash will verify and select the previous runtime, disconnect this window's Remote backend and terminals, then reconnect the Workspace.",
				buttons: ["Roll Back and Reconnect", "Cancel"],
				defaultId: 1,
				cancelId: 1,
				noLink: true,
			});
			return confirmation.response === 0 ? "confirmed" : "cancelled";
		},
		reportRuntimeRollbackFailure: async message => {
			if (window.isDestroyed()) return;
			await dialog.showMessageBox(window, {
				type: "error",
				title: "Remote runtime rollback failed",
				message: "Ash could not roll back the Remote runtime.",
				detail: message,
				buttons: ["OK"],
				defaultId: 0,
				cancelId: 0,
				noLink: true,
			});
		},
	};
}
