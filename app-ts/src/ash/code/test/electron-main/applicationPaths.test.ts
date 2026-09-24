import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'mocha';
import { AshRendererDirectory } from '../../common/application.js';
import { resolveApplicationDataPaths, resolvePackagedRendererRoot } from '../../electron-main/applicationPaths.js';

test('Desktop data paths use the single Ash application identity', () => {
	assert.deepEqual(resolveApplicationDataPaths('/application-data'), {
		userDataPath: join('/application-data', 'Ash'),
		sessionDataPath: join('/application-data', 'Ash', 'session-data'),
	});
});

test('packaged renderer contains the shared Workbench and Code Sessions entry', () => {
	const rendererRoot = mkdtempSync(join(tmpdir(), 'ash-renderer-'));
	try {
		assert.throws(() => resolvePackagedRendererRoot(rendererRoot), /renderer is incomplete/);
		const packagedRoot = join(rendererRoot, AshRendererDirectory);
		const workbenchRoot = join(packagedRoot, 'electron-browser', 'workbench');
		const sessionsRoot = join(packagedRoot, 'electron-browser', 'sessions');
		mkdirSync(workbenchRoot, { recursive: true });
		writeFileSync(join(workbenchRoot, 'workbench.html'), '<!doctype html>');
		assert.throws(() => resolvePackagedRendererRoot(rendererRoot), /sessions-code\.html/);
		mkdirSync(sessionsRoot, { recursive: true });
		writeFileSync(join(sessionsRoot, 'sessions-code.html'), '<!doctype html>');
		assert.equal(resolvePackagedRendererRoot(rendererRoot), packagedRoot);
	} finally {
		rmSync(rendererRoot, { force: true, recursive: true });
	}
});
