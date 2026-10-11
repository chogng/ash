const { app } = require('electron');

// Load before the product entrypoint so its first window cannot activate before Playwright attaches.
const mode = process.env.ASH_TEST_WINDOW_MODE;
if (mode !== 'hidden' && mode !== 'inactive') throw new Error(`Invalid test window mode: ${mode}`);

// macOS activates regular applications on launch even when all their windows stay hidden.
if (process.platform === 'darwin') app.setActivationPolicy('accessory');

app.on('browser-window-created', (_event, window) => {
	window.setFocusable(false);
	window.webContents.setBackgroundThrottling(false);
	window.show = mode === 'inactive' ? window.showInactive.bind(window) : () => { };
	if (mode === 'hidden') {
		// Restore/maximize and auxiliary windows can show without calling show().
		window.on('show', () => window.hide());
		window.hide();
	}
});
