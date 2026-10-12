const { app } = require('electron');

// The product must not interpret this test-only preload path as an app entry or file to open.
const preloadIndex = process.argv.findIndex((argument, index) => argument === '--require' && process.argv[index + 1] === __filename);
if (preloadIndex >= 0) process.argv.splice(preloadIndex, 2);
const inlinePreloadIndex = process.argv.indexOf(`--require=${__filename}`);
if (inlinePreloadIndex >= 0) process.argv.splice(inlinePreloadIndex, 1);

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
