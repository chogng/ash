import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'mocha';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IPCClient } from '../../../../base/parts/ipc/common/ipc.js';
import { ConfigurationService } from '../../common/configurationService.js';
import { ConfigurationTarget } from '../../common/configuration.js';
import { DiskFileSystemProviderClient, LOCAL_FILE_SYSTEM_CHANNEL_NAME } from '../../../files/common/diskFileSystemProviderClient.js';
import { FileService } from '../../../files/common/fileService.js';
import { IFileService, FileRevisionConflictError } from '../../../files/common/files.js';
import { DiskFileSystemProviderChannel } from '../../../files/electron-main/diskFileSystemProviderServer.js';
import { DiskFileSystemProvider } from '../../../files/node/diskFileSystemProvider.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { ILogService, NullLoggerService } from '../../../log/common/log.js';
import { IPolicyService, NullPolicyService } from '../../../policy/common/policy.js';

function connect(resources: DisposableStore, disk: DiskFileSystemProvider, root: URI, identity: string) {
	const incoming = resources.add(new Emitter<VSBuffer>());
	const outgoing = resources.add(new Emitter<VSBuffer>());
	const server = resources.add(new IPCClient({ onMessage: incoming.event, send: value => outgoing.fire(value) }, identity));
	const peer = resources.add(new IPCClient({ onMessage: outgoing.event, send: value => incoming.fire(value) }, identity));
	const channel = resources.add(new DiskFileSystemProviderChannel(disk, root, URI.file(tmpdir())));
	server.registerChannel(LOCAL_FILE_SYSTEM_CHANNEL_NAME, channel);
	const provider = resources.add(new DiskFileSystemProviderClient(peer.getChannel(LOCAL_FILE_SYSTEM_CHANNEL_NAME)));
	const files = resources.add(new FileService());
	resources.add(files.registerProvider('file', provider));
	const services = resources.add(new InstantiationService());
	services.registerInstance(IFileService, files);
	services.registerInstance(ILogService, new NullLoggerService());
	services.registerInstance(IPolicyService, new NullPolicyService());
	const resource = URI.joinPath(root, 'settings.json');
	const configuration = resources.add(services.createInstance(ConfigurationService, resource));
	return { configuration, resource, files };
}

test('configuration uses the ordinary file IPC for two hosts, opaque conflicts and restart', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-settings-files-'));
	try {
		using resources = new DisposableStore();
		const root = URI.file(directory);
		const disk = resources.add(new DiskFileSystemProvider([root]));
		const watchErrors: string[] = [];
		resources.add(disk.onDidWatchError(error => watchErrors.push(error)));
		resources.add(disk.watch(root, { recursive: false, excludes: [] }));
		const first = connect(resources, disk, root, 'window:1');
		const second = connect(resources, disk, root, 'window:2');
		await Promise.all([first.configuration.initialize(), second.configuration.initialize()]);
		await first.configuration.updateValue('test.persistence', 'first');
		const stale = await second.files.readFile(second.resource);
		await second.configuration.updateValue('test.persistence', 'second');
		await first.configuration.reloadConfiguration();
		assert.equal(first.configuration.getValue('test.persistence'), 'second');
		await assert.rejects(first.files.writeFile({ resource: first.resource, content: '{}', expectedRevision: stale.revision }), FileRevisionConflictError);
		assert.equal(JSON.parse((await first.files.readFile(first.resource)).content)['test.persistence'], 'second');
		const restarted = connect(resources, disk, root, 'window:3');
		await restarted.configuration.initialize();
		assert.equal(restarted.configuration.getValue('test.persistence'), 'second');
		await assert.rejects(restarted.configuration.updateValue('test.persistence', 'invalid-target', ConfigurationTarget.WORKSPACE), /only user/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('configuration retains valid values after invalid external edits and releases file watches', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-settings-watch-'));
	try {
		using resources = new DisposableStore();
		const root = URI.file(directory);
		const disk = resources.add(new DiskFileSystemProvider([root]));
		const watchErrors: string[] = [];
		resources.add(disk.onDidWatchError(error => watchErrors.push(error)));
		resources.add(disk.watch(root, { recursive: false, excludes: [] }));
		const host = connect(resources, disk, root, 'window:1');
		await host.configuration.initialize();
		await host.configuration.updateValue('test.watch', 'before');
		// The host's disk watch binds asynchronously; repeat the external edit until
		// its actual notification reaches the configuration consumer.
		for (let attempt = 0; attempt < 100 && host.configuration.getValue('test.watch') !== 'external'; attempt++) {
			await writeFile(host.resource.fsPath, '// preserve comment\n{ "test.watch": "external", }');
			await new Promise<void>(resolve => setTimeout(resolve, 10));
		}
		assert.deepEqual(watchErrors, []);
		assert.equal(host.configuration.getValue('test.watch'), 'external');
		await writeFile(host.resource.fsPath, '{ broken');
		await assert.rejects(host.configuration.reloadConfiguration(), /JSONC/);
		assert.equal(host.configuration.getValue('test.watch'), 'external');
		host.configuration.dispose();
		await writeFile(host.resource.fsPath, '{ "test.watch": "after-disposal" }');
		assert.equal(host.configuration.getValue('test.watch'), 'external');
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
