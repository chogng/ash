import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import type { Page } from '@playwright/test';
import { suite, test } from 'mocha';
import { hasWorkingCopyBackup } from './workingCopyBackups.js';

suite('Working-copy backup observation', () => {
	test('observing a fresh profile does not create the backup database', async () => {
		const fixture = createFixture({ exists: false });

		assert.equal(await hasWorkingCopyBackup(fixture.page, 'draft'), false);
		assert.deepEqual(fixture.state, { exists: false, opens: 0, closes: 0, aborts: 0 });
	});

	test('reads existing backups without changing them and closes every connection', async () => {
		const fixture = createFixture({ exists: true, records: [{ content: 'draft' }] });

		assert.deepEqual([
			await hasWorkingCopyBackup(fixture.page, 'draft'),
			await hasWorkingCopyBackup(fixture.page, 'other'),
			fixture.state,
		], [true, false, { exists: true, opens: 2, closes: 2, aborts: 0 }]);
	});

	test('an existing database without the backup store is a schema error', async () => {
		const fixture = createFixture({ exists: true, missingStore: true });

		await assert.rejects(hasWorkingCopyBackup(fixture.page, 'draft'), { name: 'NotFoundError' });
		assert.deepEqual(fixture.state, { exists: true, opens: 1, closes: 1, aborts: 0 });
	});

	test('catalog errors are not reported as an empty backup database', async () => {
		const error = new DOMException('Storage access is denied', 'SecurityError');
		const fixture = createFixture({ exists: true, catalogError: error });

		await assert.rejects(hasWorkingCopyBackup(fixture.page, 'draft'), error);
		assert.deepEqual(fixture.state, { exists: true, opens: 0, closes: 0, aborts: 0 });
	});

	test('database open errors remain visible', async () => {
		const error = new DOMException('Could not open database', 'UnknownError');
		const fixture = createFixture({ exists: true, openError: error });

		await assert.rejects(hasWorkingCopyBackup(fixture.page, 'draft'), error);
		assert.deepEqual(fixture.state, { exists: true, opens: 1, closes: 0, aborts: 0 });
	});

	test('a database deleted after the catalog read is not recreated', async () => {
		const fixture = createFixture({ exists: false, catalog: [{ name: 'ash-working-copy-backups', version: 1 }] });

		assert.equal(await hasWorkingCopyBackup(fixture.page, 'draft'), false);
		assert.deepEqual(fixture.state, { exists: false, opens: 1, closes: 0, aborts: 1 });
	});
});

function createFixture(options: {
	readonly exists: boolean;
	readonly missingStore?: boolean;
	readonly records?: readonly { readonly content: string }[];
	readonly catalog?: readonly IDBDatabaseInfo[];
	readonly catalogError?: DOMException;
	readonly openError?: DOMException;
}) {
	const state = { exists: options.exists, opens: 0, closes: 0, aborts: 0 };
	const database = {
		close: () => { state.closes++; },
		transaction(storeName: string, mode: string) {
			assert.deepEqual([storeName, mode], ['backups', 'readonly']);
			if (!options.exists || options.missingStore) throw new DOMException('Missing backups store', 'NotFoundError');
			return {
				objectStore(name: string) {
					assert.equal(name, 'backups');
					return {
						getAll() {
							const request = { result: options.records ?? [], onsuccess: undefined as (() => void) | undefined };
							queueMicrotask(() => request.onsuccess?.());
							return request;
						},
					};
				},
			};
		},
	};
	const indexedDB = {
		async databases() {
			if (options.catalogError) throw options.catalogError;
			return options.catalog ?? (state.exists ? [{ name: 'ash-working-copy-backups', version: 1 }] : []);
		},
		open(name: string) {
			assert.equal(name, 'ash-working-copy-backups');
			state.opens++;
			let aborted = false;
			const opening = {
				result: database,
				error: options.openError,
				transaction: { abort: () => { aborted = true; state.aborts++; } },
				onupgradeneeded: undefined as (() => void) | undefined,
				onsuccess: undefined as (() => void) | undefined,
				onerror: undefined as (() => void) | undefined,
			};
			queueMicrotask(() => {
				if (opening.error) { opening.onerror?.(); return; }
				if (!state.exists) {
					state.exists = true;
					opening.onupgradeneeded?.();
					if (aborted) {
						state.exists = false;
						opening.error = new DOMException('Creation aborted', 'AbortError');
						opening.onerror?.();
						return;
					}
				}
				opening.onsuccess?.();
			});
			return opening;
		},
	};
	const page = {
		evaluate: (callback: (content: string) => Promise<boolean>, expectedContent: string) =>
			// Playwright serializes callbacks into the page, so no module closure may be required.
			runInNewContext(`(${callback.toString()})(expectedContent)`, { indexedDB, expectedContent }),
	} as unknown as Page;
	return { page, state };
}
