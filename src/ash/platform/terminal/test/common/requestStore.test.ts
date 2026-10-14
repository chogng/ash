import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { isCancellationError } from '../../../../base/common/errors.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLoggerService } from '../../../log/common/log.js';
import { RequestStore } from '../../common/requestStore.js';
import { resetNlsResolver } from '../../../../nls.js';
import { initializeTestLocalization } from '../../../../workbench/services/localization/test/common/localizationTestUtils.js';

suite('Terminal request lifecycle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('pairs synchronous and out-of-order replies without sharing transport identities', async () => {
		using store = new RequestStore<string, { name: string; }>(undefined, new NullLoggerService());
		const ids: number[] = [];
		using listener = store.onCreateRequest(({ requestId, name }) => {
			ids.push(requestId);
			if (name === 'synchronous') store.acceptReply(requestId, name);
		});
		assert.equal(await store.createRequest({ name: 'synchronous' }), 'synchronous');
		const first = store.createRequest({ name: 'first' });
		const second = store.createRequest({ name: 'second' });
		store.acceptReply(ids[2]!, 'second');
		store.acceptReply(ids[1]!, 'first');
		assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
		store.acceptReply(ids[1]!, 'duplicate');
	});

	test('disposal rejects outstanding callbacks immediately and rejects new work', async () => {
		using store = new RequestStore<string, object>(undefined, new NullLoggerService());
		const rejected = assert.rejects(store.createRequest({}), isCancellationError);
		store.dispose();
		await rejected;
		await assert.rejects(store.createRequest({}), isCancellationError);
	});

	test('times out with localized diagnostics and discards a late reply', async () => {
		initializeTestLocalization('zh-CN');
		try {
			using store = new RequestStore<string, object>(1, new NullLoggerService());
			let id = 0;
			using listener = store.onCreateRequest(({ requestId }) => { id = requestId; });
			await assert.rejects(store.createRequest({}), /终端请求已超时/);
			store.acceptReply(id, 'late');
		} finally { resetNlsResolver(); }
	});
});
