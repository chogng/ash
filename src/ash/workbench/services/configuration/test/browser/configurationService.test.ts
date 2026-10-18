import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../../base/common/uri.js';
import { extUriBiasedIgnorePathCase, extUriIgnorePathCase } from '../../../../../base/common/resources.js';
import { TestWorkspaceService } from '../common/testServices.js';

test('Workspace membership preserves URI boundaries, root ranking and casing', () => {
	const rootUris = [
		'file:///project', 'file:///project/src', 'file:///project/src/',
		'file:///C:/Work', 'file:///c:/work', 'file:///C:/Work/src',
		'file://BUILD/share/Work', 'file://build/share/work/nested',
		'ash-remote://ssh+build/Work', 'ash-remote://ssh+build/Work/src',
		'ash-remote://ssh+other/Work', 'file:///%61%61%61', 'file:///aaa/b',
		'file:///trailing////////', 'file:///trailing/child',
		'ash-remote://ssh+build/repeated//root',
		'ash-remote://ssh+build/escaped/a%2Fb', 'ash-remote://ssh+build/escaped/a/b',
		'file:///decorated?root', 'file:///fragment#root',
	];
	const candidateUris = [
		'file:///project/src/file?preview#L2', 'file:///project/src-other/file',
		'file:///c:/WORK/src/file', 'file://build/share/WORK/nested/file',
		'ash-remote://ssh+build/Work/src/file', 'ash-remote://ssh+build/work/src/file',
		'ash-remote://ssh+other/Work/src/file', 'file:///aaa/b/file',
		'file:///trailing/child/file', 'file:///decorated/file', 'file:///fragment/file',
		'ash-remote://ssh+build/repeated//root/file', 'ash-remote://ssh+build/repeated/root/file',
		'ash-remote://ssh+build/escaped/a%2fb/file', 'ash-remote://ssh+build/escaped/a/b/file',
		'ash-remote://ssh+build/escaped/a%5Cb/file', 'file:///elsewhere',
	];
	const folders = rootUris.map((uri, index) => ({ id: `root-${index}`, uri: URI.parse(uri), name: `root-${index}`, index }));
	using workspace = new TestWorkspaceService({ id: 'membership', folders });
	for (const ordered of [folders, [...folders].reverse(), [...folders.slice(7), ...folders.slice(0, 7)]]) {
		workspace.updateWorkspace({ id: 'membership', folders: ordered.map((folder, index) => ({ ...folder, index })) });
		for (const source of candidateUris) {
			const resource = URI.parse(source);
			const candidate = resource.with({ query: null, fragment: null });
			// Reference the previous membership policy, including its encoded-length
			// ranking, so changing the collection cannot silently change root ownership.
			const matches = workspace.getWorkspace().folders.filter(folder => {
				const comparison = folder.uri.scheme === 'file' && (folder.uri.authority || /^\/[a-z]:($|\/)/i.test(folder.uri.path))
					? extUriIgnorePathCase : extUriBiasedIgnorePathCase;
				return comparison.isEqualOrParent(candidate, folder.uri);
			}).sort((left, right) => right.uri.toEncodedComponents().path.length - left.uri.toEncodedComponents().path.length);
			assert.equal(workspace.getWorkspaceFolder(resource), matches[0] ?? null, source);
		}
	}
});

test('Workspace membership commits its index before workspace listeners run', () => {
	using workspace = new TestWorkspaceService({ id: 'old', uri: URI.file('/old') });
	const resource = URI.file('/new/nested/file.ts');
	let notifications = 0;
	using listener = workspace.onDidChangeWorkspace(() => {
		notifications++;
		const folder = workspace.getWorkspaceFolder(resource);
		assert.equal(folder, workspace.getWorkspace().folders[1]);
		assert.equal(workspace.getWorkspaceFolder(URI.file('/old/file.ts')), null);
	});
	workspace.updateWorkspace({
		id: 'new', folders: [
			{ id: 'root', uri: URI.file('/new'), name: 'new', index: 0 },
			{ id: 'nested', uri: URI.file('/new/nested'), name: 'nested', index: 1 },
		]
	});
	assert.equal(notifications, 1);
	workspace.updateWorkspace(workspace.getWorkspace());
	assert.equal(notifications, 1);
});
