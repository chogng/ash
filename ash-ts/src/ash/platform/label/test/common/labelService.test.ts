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
