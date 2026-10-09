import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../../../base/common/event.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import type { INativeHostApi } from '../../../../../platform/native/common/nativeHost.js';
import type { IColorScheme } from '../../../../../platform/window/common/window.js';
import { INativeHostService } from '../../../../common/services.js';
import { NativeHostColorSchemeService } from '../../electron-browser/nativeHostColorSchemeService.js';

test('a system event wins over an older startup read and disposed windows ignore pending replies', async () => {
	using events = new Emitter<IColorScheme>();
	const pending: ((value: IColorScheme) => void)[] = [];
	const unexpected = (): never => { throw new Error('Unexpected window capability in appearance test'); };
	const host: INativeHostApi = {
		isAdmin: unexpected,
		getOSColorScheme: () => new Promise(resolve => pending.push(resolve)),
		onDidChangeColorScheme: listener => events.event(listener),
		onDidRequestOpenExternalUri: () => ({ dispose() { } }),
		openExternal: unexpected, showMessageBox: unexpected, installShellCommand: unexpected, uninstallShellCommand: unexpected,
		listWindows: unexpected, focusWindowById: unexpected, focusWindow: unexpected, closeWindow: unexpected, closeOtherWindows: unexpected,
		getZoomLevel: unexpected, onDidChangeZoomLevel: unexpected, setZoomLevel: unexpected,
		isAlwaysOnTop: unexpected, setAlwaysOnTop: unexpected, performNativeTabAction: unexpected, openNewWindowTab: unexpected,
		pickFolder: unexpected, showOpenDialog: unexpected, openWorkspace: unexpected, openWindow: unexpected, openAgentsWindow: unexpected,
		syncSystemWideKeybindings: unexpected,
		revealFile: unexpected, setWindowTheme: unexpected, setWindowDimmed: unexpected, toggleDeveloperTools: unexpected,
		showSaveDialog: unexpected, isAccessibilitySupportEnabled: unexpected, onDidChangeAccessibilitySupport: unexpected,
	};
	using services = new InstantiationService();
	services.registerInstance(INativeHostService, host);
	using colors = services.createInstance(NativeHostColorSchemeService, { dark: false, highContrast: false });
	const changes: IColorScheme[] = [];
	using listener = colors.onDidChangeColorScheme(() => changes.push({ dark: colors.dark, highContrast: colors.highContrast }));
	const initialization = colors.initialize();
	events.fire({ dark: true, highContrast: true });
	pending.shift()!({ dark: false, highContrast: false });
	await initialization;
	assert.deepEqual(changes, [{ dark: true, highContrast: true }]);
	const secondRead = colors.initialize();
	colors.dispose();
	pending.shift()!({ dark: false, highContrast: false });
	await secondRead;
	events.fire({ dark: false, highContrast: false });
	assert.deepEqual([colors.dark, colors.highContrast, changes.length], [true, true, 1]);
});
