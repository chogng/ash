import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'mocha';
import { configurationChannel, ConfigurationMainService } from '../../electron-main/configurationMainService.js';
import { createConfigurationApi } from '../../electron-browser/configurationApi.js';
import { validateConfigurationSnapshot } from '../../common/configurationIpc.js';
import type { IMainProcessService } from '../../../ipc/common/mainProcessService.js';

test('configuration channel shares committed revisions across renderer adapters and rejects stale writes', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-configuration-ipc-'));
	try {
		const filePath = join(directory, 'settings.json');
		const service = await ConfigurationMainService.create({ filePath });
		try {
			const channel = configurationChannel(service);
			const renderer = (context: string) => createConfigurationApi({
				_serviceBrand: undefined,
				getChannel(name) {
					assert.equal(name, 'configuration');
					return { call: (command, arg) => channel.call(context, command, arg), listen: (event, arg) => channel.listen(context, event, arg) };
				},
				registerChannel() { throw new Error('Unexpected renderer channel'); },
			} satisfies IMainProcessService);
			const first = renderer('window:1');
			const second = renderer('window:2');
			const observed: unknown[] = [];
			const subscription = second.onDidChange(snapshot => observed.push(snapshot));
			try {
				const initial = validateConfigurationSnapshot(await first.read());
				const request = { expectedRevision: initial.revision, document: { version: 1 as const, source: '{"editor.fontSize":23}\n' } };
				const updated = validateConfigurationSnapshot(await first.update(request));
				assert.deepEqual({ second: await second.read(), observed }, { second: updated, observed: [updated] });
				await assert.rejects(second.update(request), /revision|conflict/i);
				await assert.rejects(channel.call('window:1', 'update', { ...request, windowId: 2 }), /exactly/);
				await assert.rejects(channel.call('window:1', 'read', {}), /does not accept parameters/);
			} finally { subscription.dispose(); }
		} finally { await service.close(); }
		const restored = await ConfigurationMainService.create({ filePath });
		try { assert.equal(restored.read().document.source, '{"editor.fontSize":23}\n'); } finally { await restored.close(); }
	} finally { await rm(directory, { recursive: true, force: true }); }
});
