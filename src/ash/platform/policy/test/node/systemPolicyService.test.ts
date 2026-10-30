import assert from 'node:assert/strict';
import childProcess, { type ExecFileException } from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mock } from 'node:test';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../base/common/async.js';
import { NullLoggerService } from '../../../log/common/log.js';
import { SystemPolicyService } from '../../node/systemPolicyService.js';

interface MacReader {
	stdout: string;
	accessError?: NodeJS.ErrnoException;
	processError?: ExecFileException;
	defer: boolean;
	readonly started: DeferredPromise<AbortSignal>;
	complete?: (error: ExecFileException | null, stdout: string) => void;
}

// Exercise the default OS reader while keeping both filesystem access and process launch local
// to this fixture. No managed preferences or authorization state on the host is changed.
async function withMacReader(run: (source: SystemPolicyService, reader: MacReader) => Promise<void>): Promise<void> {
	const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
	const reader: MacReader = { stdout: '{"ChatDefaultModel":"managed-model","Unknown":true}', defer: false, started: new DeferredPromise<AbortSignal>() };
	const access = mock.method(fs, 'access', async (path: Parameters<typeof fs.access>[0]) => {
		assert.equal(path, '/Library/Managed Preferences/com.ash.desktop.plist');
		if (reader.accessError) throw reader.accessError;
	});
	const execute = mock.method(childProcess, 'execFile', ((executable: string, args: string[], options: childProcess.ExecFileOptionsWithStringEncoding, callback: (error: ExecFileException | null, stdout: string, stderr: string) => void) => {
		assert.equal(executable, '/usr/bin/plutil');
		assert.deepEqual(args, ['-convert', 'json', '-o', '-', '/Library/Managed Preferences/com.ash.desktop.plist']);
		const { signal, ...settings } = options;
		assert.deepEqual(settings, { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
		assert.ok(signal);
		void reader.started.complete(signal);
		reader.complete = (error, stdout) => callback(error, stdout, '');
		if (!reader.defer) reader.complete(reader.processError ?? null, reader.stdout);
		return new childProcess.ChildProcess();
	}) as typeof childProcess.execFile);
	Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
	syncBuiltinESMExports();
	try {
		using source = new SystemPolicyService(new NullLoggerService(), undefined, 100000);
		await run(source, reader);
	} finally {
		Object.defineProperty(process, 'platform', platform);
		access.mock.restore();
		execute.mock.restore();
		syncBuiltinESMExports();
	}
}

test('The default macOS reader converts the fixed managed plist and filters undeclared policies', async () => {
	await withMacReader(async source => {
		assert.deepEqual(await source.updatePolicyDefinitions({ ChatDefaultModel: { type: 'string' } }), { ChatDefaultModel: 'managed-model' });
	});
});

test('macOS read failures retain the last valid policy and authoritative plist absence withdraws it', async () => {
	await withMacReader(async (source, reader) => {
		await source.updatePolicyDefinitions({ ChatDefaultModel: { type: 'string' } });
		reader.stdout = '{';
		await assert.rejects(source.updatePolicyDefinitions({}), SyntaxError);
		reader.stdout = '{"ChatDefaultModel":false}';
		await assert.rejects(source.updatePolicyDefinitions({}), /Invalid policy value/);
		reader.accessError = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
		await assert.rejects(source.updatePolicyDefinitions({}), { code: 'EACCES' });
		reader.accessError = undefined;
		reader.processError = Object.assign(new Error('Conversion failed'), { code: 1 });
		await assert.rejects(source.updatePolicyDefinitions({}), /Conversion failed/);
		assert.equal(source.getPolicyValue('ChatDefaultModel'), 'managed-model');
		reader.accessError = Object.assign(new Error('Not found'), { code: 'ENOENT' });
		assert.deepEqual(await source.updatePolicyDefinitions({}), {});
	});
});

test('Disposing the macOS source aborts its converter and ignores late policy results', async () => {
	await withMacReader(async (source, reader) => {
		reader.defer = true;
		let changes = 0;
		using listener = source.onDidChange(() => { changes++; });
		const pending = source.updatePolicyDefinitions({ ChatDefaultModel: { type: 'string' } });
		const signal = await reader.started.p;
		assert.equal(signal.aborted, false);
		source.dispose();
		assert.equal(signal.aborted, true);
		reader.complete!(null, reader.stdout);
		assert.deepEqual(await pending, {});
		assert.equal(changes, 0);
	});
});
