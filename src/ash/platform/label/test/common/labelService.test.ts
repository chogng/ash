import { BrowserPathService } from '../../../../workbench/services/path/browser/pathService.js';
import { createDisconnectedRendererApi } from '../../../agentHost/browser/rendererApi.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { operatingSystem, OperatingSystem } from '../../../../base/common/platform.js';
import { WorkbenchState, type IWorkspaceContextService } from '../../../workspace/common/workspace.js';
import { LabelService } from '../../common/labelService.js';

test('LabelService formats workspace paths and invalidates registered formatters', () => {
	const root = URI.file('/workspace');
	const resource = URI.file('/workspace/src/main.ts');
	const workspace: IWorkspaceContextService = {
		onDidChangeWorkspace: Event.None,
		getWorkspace: () => ({ id: 'workspace', folders: [{ id: 'root', uri: root, name: 'workspace', index: 0 }] }),
		getWorkbenchState: () => WorkbenchState.FOLDER,
		getWorkspaceFolder: () => ({ id: 'root', uri: root, name: 'workspace', index: 0 }),
	};
	using labels = createTestLabelService(workspace, OperatingSystem.Linux);

	assert.equal(labels.getUriLabel(resource, { relative: true }), 'src/main.ts');
	assert.equal(labels.getUriBasenameLabel(resource), 'main.ts');
	assert.equal(labels.getSeparator(resource), '/');

	const changes: string[] = [];
	using listener = labels.onDidChangeFormatters(event => changes.push(event.scheme));
	using formatter = labels.registerFormatter({
		scheme: 'file',
		priority: 10,
		format: candidate => `formatted:${candidate.path}`,
	});
	assert.equal(labels.getUriLabel(resource), 'formatted:/workspace/src/main.ts');
	assert.deepEqual(changes, ['file']);
	formatter.dispose();
	assert.equal(labels.getUriLabel(resource, { relative: true }), 'src/main.ts');
	assert.deepEqual(changes, ['file', 'file']);
});

test('LabelService normalizes absolute Windows drive labels while retaining workspace-relative paths', () => {
	const root = URI.from({ scheme: 'file', path: '/e:/workspace' });
	const resource = root.with({ path: '/e:/workspace/src/main.ts' });
	const folder = { id: 'root', uri: root, name: 'workspace', index: 0 };
	const workspace: IWorkspaceContextService = {
		onDidChangeWorkspace: Event.None,
		getWorkspace: () => ({ id: 'workspace', folders: [folder] }),
		getWorkbenchState: () => WorkbenchState.FOLDER,
		getWorkspaceFolder: () => folder,
	};
	using labels = createTestLabelService(workspace, OperatingSystem.Windows);
	assert.deepEqual([
		labels.getUriLabel(resource),
		labels.getUriLabel(resource, { separator: '/' }),
		labels.getUriLabel(resource, { relative: true }),
		resource.path,
	], ['E:\\workspace\\src\\main.ts', 'E:/workspace/src/main.ts', 'src\\main.ts', '/e:/workspace/src/main.ts']);
});

function createTestLabelService(workspace: ConstructorParameters<typeof LabelService>[0], os: OperatingSystem = operatingSystem): LabelService {
	const api = createDisconnectedRendererApi();
	const host = { ...api, hasAppServer: true, appServer: { ...api.appServer, operatingSystem: os } };
	return new LabelService(workspace, new BrowserPathService(host, workspace), host);
}

test('LabelService reads connection home for each label and invalidates labels on replacement and disconnect', () => {
	using changes = new Emitter<import('../../../agentHost/common/appServerApi.js').AppServerConnectionState>();
	const api = createDisconnectedRendererApi();
	let os: OperatingSystem | undefined = OperatingSystem.Linux;
	let home: string | undefined = '/home/remote';
	const host = {
		...api, hasAppServer: true, appServer: {
			...api.appServer,
			get operatingSystem() { return os; }, get userHome() { return home; },
			onConnectionState: changes.event,
		}
	};
	const workspace = {
		onDidChangeWorkspace: Event.None, getWorkspace: () => ({ id: 'label-home', folders: [] }),
		getWorkbenchState: () => WorkbenchState.EMPTY, getWorkspaceFolder: () => null
	};
	using labels = new LabelService(workspace, new BrowserPathService(host, workspace), host);
	const resource = URI.parse('file:///home/remote/notes.txt');
	const values = [labels.getUriLabel(resource)];
	let invalidations = 0;
	using listener = labels.onDidChangeFormatters(() => invalidations++);
	home = '/home/other';
	changes.fire('ready');
	values.push(labels.getUriLabel(resource));
	os = OperatingSystem.Windows;
	home = 'C:\\Users\\remote';
	changes.fire('ready');
	values.push(labels.getUriLabel(URI.parse('file:///C:/Users/remote/notes.txt')));
	home = undefined;
	os = undefined;
	changes.fire('stopped');
	values.push(labels.getUriLabel(resource));
	assert.deepEqual({ values, invalidations }, { values: ['~/notes.txt', '/home/remote/notes.txt', 'C:\\Users\\remote\\notes.txt', '/home/remote/notes.txt'], invalidations: 3 });
	labels.dispose();
	assert.equal(changes.hasListeners(), false);
});
