import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'mocha';
import { OperatingSystem } from '../../../../base/common/platform.js';
import {
	parseUserKeyboardLayoutResource,
	USER_KEYBOARD_LAYOUT_DEFAULT_CONTENT,
} from '../../../../platform/keyboardLayout/common/userKeyboardLayout.js';
import { UserKeyboardLayoutMainService } from '../../../../platform/keyboardLayout/electron-main/userKeyboardLayoutMainService.js';

test('user keyboard layout parser accepts VS Code debug JSON and canonical Ash JSON', () => {
	const windows = parseUserKeyboardLayoutResource({
		layout: { name: '00000409', id: '00000409', text: 'US', isUSStandard: true },
		rawMapping: { KeyA: mappingEntry('a', 'A', 'VK_A') },
	});
	assert.deepEqual(windows?.layout, {
		id: '00000409',
		label: 'US',
		source: 'user',
		operatingSystem: OperatingSystem.Windows,
		isUSStandard: true,
	});
	assert.equal(windows?.mapping.KeyA.vkey, 'VK_A');

	const canonical = parseUserKeyboardLayoutResource({
		layout: {
			id: 'custom.academic',
			label: 'Custom Academic',
			source: 'native',
			operatingSystem: OperatingSystem.Linux,
		},
		rawMapping: { KeyQ: mappingEntry('x', 'X') },
	});
	assert.equal(canonical?.layout.source, 'user');
	assert.equal(canonical?.layout.id, 'custom.academic');
	assert.throws(() => parseUserKeyboardLayoutResource({
		layout: { id: 'bad', label: 'Bad', operatingSystem: OperatingSystem.Linux },
		rawMapping: { KeyA: { ...mappingEntry('a', 'A'), unexpected: true } },
	}), /unknown fields/);
});

test('profile keyboard-layout.json is created and hot-reloaded, including invalidation', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-keyboard-layout-'));
	try {
		const filePath = join(directory, 'keyboard-layout.json');
		const errors: unknown[] = [];
		let openedResource: string | undefined;
		const service = await UserKeyboardLayoutMainService.create({
			filePath,
			onError: (error) => errors.push(error),
			openResource: async (resource) => {
				openedResource = resource;
				return '';
			},
		});
		try {
			assert.equal(await service.readKeyboardLayout(), undefined);
			assert.equal(await service.ensureResource(), filePath);
			assert.equal(await readFile(filePath, 'utf8'), USER_KEYBOARD_LAYOUT_DEFAULT_CONTENT);
			await service.openResource();
			assert.equal(openedResource, filePath);

			const loaded = nextChange(service);
			await writeFile(filePath, `${JSON.stringify({
				layout: { id: 'custom.test', label: 'Custom Test', source: 'user', operatingSystem: 'linux' },
				rawMapping: { KeyT: mappingEntry('t', 'T') },
			}, null, 2)}\n`, 'utf8');
			await loaded;
			assert.equal((await service.readKeyboardLayout())?.layout.id, 'custom.test');

			const invalidated = nextChange(service);
			await writeFile(filePath, '{ invalid', 'utf8');
			await invalidated;
			assert.equal(await service.readKeyboardLayout(), undefined);
			assert.equal(errors.length, 1);
		} finally {
			await service.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

function mappingEntry(value: string, withShift: string, vkey?: string) {
	return {
		value,
		withShift,
		withAltGr: '',
		withShiftAltGr: '',
		...(vkey ? { vkey } : {}),
	};
}

function nextChange(service: UserKeyboardLayoutMainService): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			listener.dispose();
			reject(new Error('Timed out waiting for keyboard layout reload'));
		}, 2_000);
		const listener = service.onDidChangeKeyboardLayout(() => {
			clearTimeout(timeout);
			listener.dispose();
			resolve();
		});
	});
}
