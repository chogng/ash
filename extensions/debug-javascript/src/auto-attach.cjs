// Runtime interaction only. Selection, authorization and launch policy live in Rust.
'use strict';
(() => {
	if (!require('node:worker_threads').isMainThread || !process.env.ASH_JS_DEBUG_TOKEN || process.env.VSCODE_INSPECTOR_OPTIONS) return;
	const inspector = require('node:inspector');
	const flagged = !!inspector.url();
	if (!flagged && process.env.ASH_JS_DEBUG_MODE === 'onlyWithFlag') return;
	const helper = process.env.ASH_JS_DEBUG_HELPER;
	try {
		require('node:fs').accessSync(helper, require('node:fs').constants.X_OK);
		if (!flagged) inspector.open(0, '127.0.0.1');
		const address = inspector.url();
		const endpoint = new URL(address);
		// Match the Rust helper's address contract before entering a wait it must release.
		if (Buffer.byteLength(address) > 2048 || endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password || !endpoint.port) {
			if (!flagged) inspector.close();
			return;
		}
		const environment = { ...process.env };
		delete environment.NODE_OPTIONS;
		const payload = JSON.stringify({
			token: process.env.ASH_JS_DEBUG_TOKEN, address: process.env.ASH_JS_DEBUG_ADDRESS,
			inspector: address, pid: process.pid, cwd: process.cwd(), script: process.argv[1] || '', flagged
		});
		if (process.env.ASH_JS_DEBUG_CHILDREN === '0') delete process.env.ASH_JS_DEBUG_TOKEN;
		if (Buffer.byteLength(payload) > 8192) {
			if (!flagged) inspector.close();
			return;
		}
		const child = require('node:child_process').spawn(helper, ['--auto-attach'], { env: { ...environment, ASH_JS_DEBUG_REQUEST: payload }, stdio: 'ignore', windowsHide: true });
		child.on('error', () => { });
		if (!child.pid) {
			if (!flagged) inspector.close();
			return;
		}
		child.unref();
		// The Rust helper resumes this wait on rejection, timeout or a dead broker.
		inspector.waitForDebugger();
	} catch {
		if (!flagged) inspector.close();
	}
})();
