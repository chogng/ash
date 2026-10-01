import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { autorun, transaction } from '../../../../../base/common/observable.js';
import { observableMemento } from '../../../../../platform/observable/common/observableMemento.js';
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../browser/storageService.js';

test('stored observables preserve local identity, batch notifications and reload other writers without writing back', () => {
	const dom = new JSDOM('<!doctype html>', { url: 'https://ash.test' });
	try {
		using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, applicationId: 'code', workspaceId: 'test', backend: dom.window.localStorage, flushInterval: 0 });
		storage.store('state', 'invalid', StorageScope.PROFILE, StorageTarget.USER);
		using value = observableMemento<readonly number[]>({ key: 'state', defaultValue: [], toStorage: state => JSON.stringify(state), fromStorage: serialized => JSON.parse(serialized) })(StorageScope.PROFILE, StorageTarget.USER, storage);
		const observed: Array<readonly number[]> = [];
		let writes = 0;
		using listener = storage.onDidChangeValue(() => writes++);
		using reaction = autorun(reader => observed.push(value.read(reader)));
		const finalValue = [2, 3] as const;
		transaction(tx => {
			value.set([1], tx);
			value.set(finalValue, tx);
		});
		assert.deepEqual(observed, [[], finalValue]);
		assert.strictEqual(value.get(), finalValue);
		assert.equal(storage.get('state', StorageScope.PROFILE), '[2,3]');
		assert.equal(writes, 2);
		storage.store('state', '[4]', StorageScope.PROFILE, StorageTarget.USER);
		assert.deepEqual(value.get(), [4]);
		assert.equal(writes, 3);
		storage.remove('state', StorageScope.PROFILE);
		assert.deepEqual(value.get(), []);
		value.dispose();
		storage.store('state', '[5]', StorageScope.PROFILE, StorageTarget.USER);
		assert.deepEqual(value.get(), []);
	} finally {
		dom.window.close();
	}
});
