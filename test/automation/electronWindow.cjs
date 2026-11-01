const { app } = require('electron');

// A startup regression can prohibit backend package discovery before Main loads.
const backendLookup = process.env.ASH_TEST_REJECT_BACKEND_PACKAGE;
if (backendLookup) {
	const fs = require('node:fs');
	const readdir = fs.readdirSync;
	fs.readdirSync = function (path, ...args) {
		if (String(path).replaceAll('\\', '/').includes('/.build/runtime/dev/store-v1/')) {
			fs.writeFileSync(backendLookup, String(path));
			throw new Error('UI startup must not resolve backend packages');
		}
		return readdir.call(this, path, ...args);
	};
	require('node:module').syncBuiltinESMExports();
	fs.writeFileSync(`${backendLookup}.ready`, 'ready');
}

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
