import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../../base/common/uri.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { FileKind, type IFileChangeEvent, type IFileService } from '../../../../../platform/files/common/files.js';
import { WorkspaceContextService } from '../../../../services/workspaces/browser/workspaceContextService.js';
import { ExplorerService } from '../../browser/explorerService.js';
import { ExplorerItem } from '../../common/explorerModel.js';

test('Explorer service exposes the current view and releases it on disposal', () => {
	using workspace = new WorkspaceContextService({ id: 'project', uri: URI.file('/project') });
	using service = new ExplorerService(workspace, { onDidChangeFiles: Event.None } as IFileService);
	const selected = new ExplorerItem(URI.file('/project/main.ts'), 'main.ts', FileKind.File);
	let focused = 0;
	assert.deepEqual(service.getContext(), []);
	assert.equal(service.getAccessibleContent(), undefined);
	const view = {
		getContext: () => [selected],
		getAccessibleContent: () => 'main.ts',
		focus: () => { focused++; },
	};
	const registration = service.registerView(view);
	assert.deepEqual(service.getContext(), [selected]);
	assert.equal(service.getAccessibleContent(), 'main.ts');
	service.focus();
	assert.equal(focused, 1);
	assert.throws(() => service.registerView(view), /already registered/);
	registration.dispose();
	assert.deepEqual(service.getContext(), []);
	assert.equal(service.getAccessibleContent(), undefined);
	using next = service.registerView(view);
	assert.deepEqual(service.getContext(), [selected]);
});

test('Explorer service owns roots and workspace file invalidations without a view', () => {
	const firstRoot = URI.file('/project');
	const secondRoot = URI.file('/next');
	using workspace = new WorkspaceContextService({ id: 'project', uri: firstRoot });
	using changes = new Emitter<IFileChangeEvent>();
	using service = new ExplorerService(workspace, { onDidChangeFiles: changes.event } as IFileService);
	const observed: string[] = [];
	using rootListener = service.onDidChangeRoot(() => observed.push(service.getRoot()?.resource.toString() ?? 'empty'));
	using fileListener = service.onDidChangeResources(resources => observed.push(resources?.[0]?.toString() ?? 'all'));

	changes.fire({ resources: [URI.file('/outside/file.txt'), URI.file('/project/main.ts')] });
	workspace.updateWorkspace({ id: 'next', uri: secondRoot });
	changes.fire({ resources: [URI.file('/project/main.ts'), URI.file('/next/other.ts')] });

	assert.deepEqual(observed, [URI.file('/project/main.ts').toString(), secondRoot.toString(), URI.file('/next/other.ts').toString()]);
});
