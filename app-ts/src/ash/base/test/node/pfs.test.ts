import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { suite, test } from 'mocha';
import { Promises } from '../../node/pfs.js';

suite('filesystem rename', () => {
	test('Windows replacement waits for temporary locks, while unrelated errors remain visible', async () => {
		const rename = fs.rename;
		try {
			let calls = 0;
			const locked = Object.assign(new Error('File is busy'), { code: 'EPERM' });
			fs.rename = async () => { if (++calls === 1) throw locked; };
			if (process.platform === 'win32') {
				await Promises.rename('source', 'target', 1000);
				assert.equal(calls, 2);
			} else {
				await assert.rejects(Promises.rename('source', 'target'), error => error === locked);
			}
			fs.rename = async () => { throw locked; };
			await assert.rejects(Promises.rename('source', 'target', false), error => error === locked);
			await assert.rejects(Promises.rename('source', 'target', 0), error => error === locked);
			const missing = Object.assign(new Error('Missing source'), { code: 'ENOENT' });
			fs.rename = async () => { throw missing; };
			await assert.rejects(Promises.rename('source', 'target'), error => error === missing);
		} finally {
			fs.rename = rename;
		}
	});
});
