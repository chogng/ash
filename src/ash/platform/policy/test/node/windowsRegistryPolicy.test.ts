import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'mocha';
import { NullLoggerService } from '../../../log/common/log.js';
import { SystemPolicyService } from '../../node/systemPolicyService.js';

test('Native registry snapshots preserve Unicode, numeric types, live updates and last valid policy', async function () {
	if (process.platform !== 'win32') {
		this.skip();
		return;
	}
	const { default: koffi } = await import('koffi');
	const { readWindowsRegistryPolicies } = await import('../../node/windowsRegistryPolicy.js');
	const registry = koffi.load(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'advapi32.dll'));
	const create = registry.func(
		'int32_t __stdcall RegCreateKeyExW(void *key, const char16_t *path, uint32_t reserved, void *className, uint32_t options, uint32_t access, void *security, _Out_ void **result, void *disposition)',
	);
	const set = registry.func('int32_t __stdcall RegSetValueExW(void *key, const char16_t *name, uint32_t reserved, uint32_t type, const uint8_t *data, uint32_t size)');
	const remove = registry.func('int32_t __stdcall RegDeleteValueW(void *key, const char16_t *name)');
	const close = registry.func('int32_t __stdcall RegCloseKey(void *key)');
	const deleteTree = registry.func('int32_t __stdcall RegDeleteTreeW(void *key, const char16_t *path)');
	// Only this unique test-owned key is writable. Production always reads HKLM.
	const location = { hive: 'user' as const, path: `Software\\AshPolicyTests\\${randomUUID()}` };
	const root = BigInt.asUintN(process.arch === 'ia32' ? 32 : 64, -2147483647n);
	const key: [bigint | null] = [null];
	using log = new NullLoggerService();
	using source = new SystemPolicyService(log, async definitions => readWindowsRegistryPolicies(definitions, location), 20);
	const definitions = {
		Text: { type: 'string' as const },
		Count: { type: 'number' as const },
		Wide: { type: 'number' as const },
		Enabled: { type: 'boolean' as const },
	};
	assert.deepEqual(await source.updatePolicyDefinitions(definitions), {});
	assert.equal(create(root, location.path, 0, null, 0, 0x103, null, key, null), 0);
	const write = (name: string, type: number, data: Buffer): void => {
		assert.equal(set(key[0], name, 0, type, data, data.length), 0);
	};
	const dword = (value: number): Buffer => {
		const bytes = Buffer.alloc(4);
		bytes.writeInt32LE(value);
		return bytes;
	};
	try {
		write('Text', 1, Buffer.from('策略 😀\n第二行\0', 'utf16le'));
		write('Count', 4, dword(-1));
		const wide = Buffer.alloc(8);
		wide.writeBigInt64LE(-4294967296n);
		write('Wide', 11, wide);
		write('Enabled', 4, dword(1));
		write('Unregistered', 3, Buffer.from([1, 2]));
		const expected = { Text: '策略 😀\n第二行', Count: -1, Wide: -4294967296, Enabled: true };
		assert.deepEqual(await source.updatePolicyDefinitions({}), expected);
		write('Enabled', 4, dword(0));
		assert.equal((await source.updatePolicyDefinitions({})).Enabled, false);
		write('Enabled', 4, dword(2));
		await assert.rejects(source.updatePolicyDefinitions({}), /Invalid policy value: Enabled/);
		assert.equal(source.getPolicyValue('Enabled'), false);
		write('Enabled', 4, dword(1));
		write('Text', 2, Buffer.from('%PATH%\0', 'utf16le'));
		await assert.rejects(source.updatePolicyDefinitions({}), /Unsupported registry policy kind: Text/);
		assert.equal(source.getPolicyValue('Text'), expected.Text);
		const maximumText = 'x'.repeat(1024 * 1024);
		write('Text', 1, Buffer.from(maximumText + '\0', 'utf16le'));
		assert.equal((await source.updatePolicyDefinitions({})).Text, maximumText);
		write('Text', 1, Buffer.from('x'.repeat(1024 * 1024 + 1) + '\0', 'utf16le'));
		await assert.rejects(source.updatePolicyDefinitions({}), /Policy value too large: Text/);
		assert.equal(remove(key[0], 'Text'), 0);
		assert.equal((await source.updatePolicyDefinitions({})).Text, undefined);
		write('Later', 1, Buffer.from('新增\0', 'utf16le'));
		assert.equal((await source.updatePolicyDefinitions({ Later: { type: 'string' } })).Later, '新增');
		// Exercise the service's timer and notification, not just explicit refreshes.
		let changed!: () => void;
		const updated = new Promise<void>(resolve => {
			changed = resolve;
		});
		using listener = source.onDidChange(() => {
			if (source.getPolicyValue('Later') === '已更新') changed();
		});
		write('Later', 1, Buffer.from('已更新\0', 'utf16le'));
		await updated;
		// Notifications fire inside refresh; let that pending snapshot finish before
		// deleting its key and requesting another snapshot.
		await source.updatePolicyDefinitions({});
	} finally {
		assert.equal(close(key[0]), 0);
		assert.equal(deleteTree(root, location.path), 0);
	}
	assert.deepEqual(await source.updatePolicyDefinitions({}), {});
});
