import { WorkspaceContextService } from '../../../workspaces/browser/workspaceContextService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { createDisconnectedRendererApi } from '../../../../../platform/agentHost/browser/rendererApi.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IPathService } from '../../../../../platform/path/common/pathService.js';
import { createSshRemoteWorkspaceUri } from '../../../../../platform/remote/common/remote.js';
import { IRendererHostService } from '../../../../../platform/renderer/common/rendererHost.js';
import '../../browser/pathService.js';

suite('PathService', () => {
	test('uses server facts for disk resources and keeps browser and SSH rules distinct', async () => {
		using services = createServices(() => OperatingSystem.Windows);
		const paths = services.get(IPathService);
		const disk = URI.parse('file:///work');
		const remote = createSshRemoteWorkspaceUri('build', '/work');
		const browser = URI.parse('file:///@browser/id/work');
		assert.deepEqual(await Promise.all([
			paths.hasValidBasename(disk, 'CON.txt'),
			paths.hasValidBasename(disk, 'part\\name.txt'),
			paths.hasValidBasename(remote, 'CON.txt'),
			paths.hasValidBasename(remote, 'part\\name.txt'),
			paths.hasValidBasename(browser, 'CON.txt'),
			paths.hasValidBasename(browser, 'part\\name.txt'),
			paths.hasValidBasename(remote, '../escape'),
		]), [false, false, true, true, true, false, false]);
	});

	test('reads changed connection facts instead of retaining retired OS rules', async () => {
		let os: OperatingSystem | undefined = OperatingSystem.Windows;
		using services = createServices(() => os);
		const paths = services.get(IPathService);
		const disk = URI.parse('file:///work/part%5Cname.txt');
		const results = [await paths.hasValidBasename(disk)];
		os = OperatingSystem.Linux;
		results.push(await paths.hasValidBasename(disk));
		os = undefined;
		results.push(await paths.hasValidBasename(disk));
		os = OperatingSystem.Macintosh;
		results.push(await paths.hasValidBasename(disk));
		assert.deepEqual(results, [false, true, false, true]);
	});

	test('requires its host dependency through the registered creation path', () => {
		using services = new InstantiationService(new ServiceCollection(...getSingletonServiceDescriptors()));
		assert.throws(() => services.get(IPathService), /rendererHostService/);
	});

	test('converts server paths using connection facts and preserves POSIX filename characters', async () => {
		let os: OperatingSystem | undefined = OperatingSystem.Windows;
		using services = createServices(() => os);
		const paths = services.get(IPathService);
		assert.deepEqual(await paths.fileURI('C:\\work\\notes #1.txt'), URI.parse('file:///C:/work/notes%20%231.txt'));
		assert.deepEqual(await paths.fileURI('\\\\server\\share\\notes.txt'), URI.parse('file://server/share/notes.txt'));
		assert.deepEqual(await paths.fileURI('\\\\server'), URI.parse('file://server/'));
		os = OperatingSystem.Linux;
		assert.deepEqual(await paths.fileURI('/work/part\\name.txt '), URI.parse('file:///work/part%5Cname.txt%20'));
		await assert.rejects(paths.fileURI('C:\\work'), /absolute/);
		await assert.rejects(paths.fileURI('../work'), /absolute/);
		await assert.rejects(paths.fileURI(''), /absolute/);
		os = undefined;
		assert.equal(await paths.getOperatingSystem(URI.parse('file:///work')), undefined);
		assert.deepEqual(await paths.fileURI('C:\\work'), URI.parse('file:///C:/work'));
		assert.deepEqual(await paths.fileURI('/work/part\\name.txt'), URI.parse('file:///work/part%5Cname.txt'));
	});

	test('reports only known disk OS facts and leaves SSH and browser storage unspecified', async () => {
		using services = createServices(() => OperatingSystem.Windows);
		const paths = services.get(IPathService);
		assert.deepEqual(await Promise.all([
			paths.getOperatingSystem(URI.parse('file:///C:/work')),
			paths.getOperatingSystem(createSshRemoteWorkspaceUri('build', '/work')),
			paths.getOperatingSystem(URI.parse('file:///@browser/id/work')),
			paths.getOperatingSystem(URI.parse('mem:/work')),
		]), [OperatingSystem.Windows, undefined, undefined, undefined]);
	});
});

function createServices(getOS: () => OperatingSystem | undefined, getHome: () => string | undefined = () => undefined, localUserHome?: URI): InstantiationService {
	const host = createDisconnectedRendererApi();
	const services = new InstantiationService(new ServiceCollection(...getSingletonServiceDescriptors(), [IRendererHostService, {
		...host,
		hasAppServer: true,
		localUserHome,
		appServer: { ...host.appServer, get operatingSystem() { return getOS(); }, get userHome() { return getHome(); } },
	}]));
	services.registerSingleton(IWorkspaceContextService, () => new WorkspaceContextService({ id: 'path-test', folders: [] }));
	return services;
}

test('PathService separates local and target homes and follows replacement connections', async () => {
	let os: OperatingSystem | undefined = OperatingSystem.Windows;
	let home: string | undefined = 'C:\\Users\\remote';
	const local = URI.parse('file:///Users/local');
	using services = createServices(() => os, () => home, local);
	const paths = services.get(IPathService);
	assert.deepEqual([paths.userHome({ preferLocal: true }), await paths.userHome(), (await paths.path).sep], [local, URI.parse('file:///C:/Users/remote'), '\\']);
	os = OperatingSystem.Linux;
	home = '/home/remote';
	assert.deepEqual([await paths.userHome(), (await paths.path).sep], [URI.parse('file:///home/remote'), '/']);
	os = undefined;
	home = undefined;
	assert.equal(paths.resolvedUserHome, undefined);
	await assert.rejects(paths.userHome(), /unavailable/);
	await assert.rejects(paths.path, /unavailable/);
	assert.deepEqual(paths.userHome({ preferLocal: true }), local);
});

test('PathService uses POSIX operations for SSH resources and browser handles independently of the server', async () => {
	using services = createServices(() => OperatingSystem.Windows);
	const paths = services.get(IPathService);
	const results = await Promise.all([
		paths.getPath(createSshRemoteWorkspaceUri('build', '/work')),
		paths.getPath(URI.parse('file:///@browser/id/work')),
		paths.getPath(URI.parse('file:///C:/work')),
		paths.getPath(URI.parse('mem:/work')),
	]);
	assert.deepEqual(results.map(path => path?.normalize('/work/part\\name/../notes')), ['/work/notes', '/work/notes', '\\work\\part\\notes', undefined]);
});
