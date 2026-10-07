import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { OperatingSystem } from '../../../../base/common/platform.js';
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
	using labels = new LabelService(workspace, OperatingSystem.Linux);

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
	using labels = new LabelService(workspace, OperatingSystem.Windows);
	assert.deepEqual([
		labels.getUriLabel(resource),
		labels.getUriLabel(resource, { separator: '/' }),
		labels.getUriLabel(resource, { relative: true }),
		resource.path,
	], ['E:\\workspace\\src\\main.ts', 'E:/workspace/src/main.ts', 'src\\main.ts', '/e:/workspace/src/main.ts']);
});
