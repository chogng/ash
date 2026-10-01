import type { App } from 'electron';
import { resolve } from 'node:path';
import { expect, test } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';
import type { AppServerDaemonLauncher } from '../../../../src/ash/platform/app-server-daemon/electron-main/appServerDaemonLauncher.js';

interface StartupProbeApp extends App {
	sessionsStartupProbe: { readonly events: string[]; readonly dispose: () => void };
}

test.use({ openWorkspace: false });

test('Agents starts its connection before loading the page and reconnects on reload', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required' || target.workbenchMode !== 'code', 'Requires Code Electron with App Server');
	if (!('windows' in application)) throw new Error('Expected Electron');
	const mainRoot = resolve(import.meta.dirname, '../../../../../.build/app-ts/main/src');
	await application.evaluate(({ app }, mainRoot) => {
		const require = process.getBuiltinModule('module').createRequire(process.execPath);
		const { AppServerDaemonLauncher: Launcher } = require(`${mainRoot}/ash/platform/app-server-daemon/electron-main/appServerDaemonLauncher.js`) as { AppServerDaemonLauncher: typeof AppServerDaemonLauncher };
		const events: string[] = [];
		const launch = Launcher.prototype.launch;
		Launcher.prototype.launch = function () {
			if (this.environment.ASH_APP_SERVER_CONNECTION_ROLE === 'agents') events.push('connection-started');
			return launch.call(this);
		};
		const created = (_event: unknown, window: Electron.BrowserWindow): void => {
			window.webContents.once('did-start-navigation', () => events.push('page-loading'));
		};
		app.on('browser-window-created', created);
		(app as StartupProbeApp).sessionsStartupProbe = {
			events,
			dispose: () => { Launcher.prototype.launch = launch; app.off('browser-window-created', created); },
		};
	}, mainRoot);
	try {
		const opened = application.waitForEvent('window');
		await workbench.page.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
		const agents = await opened;
		const input = agents.getByRole('textbox', { name: 'Chat message', exact: true });
		await expect(input).toBeEditable();
		const editor = new Editor(agents.locator('.ash-sessions-chat-input').first());
		await editor.waitForEditorFocus();
		await agents.keyboard.insertText('Keep this draft after reload');
		await editor.waitForEditorContents(value => value === 'Keep this draft after reload');
		expect(await application.evaluate(({ app }) => (app as StartupProbeApp).sessionsStartupProbe.events)).toEqual(['connection-started', 'page-loading']);
		await agents.reload();
		await expect(input).toBeEditable();
		await editor.waitForEditorFocus();
		await agents.keyboard.press('ControlOrMeta+A');
		await agents.keyboard.press('Backspace');
		await agents.keyboard.insertText('Connection reinitialized');
		await editor.waitForEditorContents(value => value === 'Connection reinitialized');
		expect(await application.evaluate(({ app }) => (app as StartupProbeApp).sessionsStartupProbe.events)).toEqual(['connection-started', 'page-loading', 'connection-started']);
	} finally {
		await application.evaluate(({ app }) => (app as StartupProbeApp).sessionsStartupProbe.dispose());
	}
});
