import { strict as assert } from 'node:assert';
import { test } from 'mocha';
import { createSshRemoteWorkspaceUri } from '../../../../platform/remote/common/remote.js';
import { getRemoteWorkspacePath, withRemoteWorkspacePath } from '../../../../platform/remote/common/remote.js';
import { URI } from '../../../../base/common/uri.js';

test('Windows drive and UNC workspaces round-trip independently of the client OS', () => {
	for (const [input, expected] of [
		['c:\\Users\\开发者\\Ash project', 'C:/Users/开发者/Ash project'],
		['\\\\server\\share\\project', '//server/share/project'],
		['C:/', 'C:/'],
		['\\\\?\\C:\\work\\file.ts', 'C:/work/file.ts'],
		['\\\\?\\UNC\\server\\share\\file.ts', '//server/share/file.ts'],
		['\\\\server\\share\\', '//server/share'],
	]) {
		const uri = createSshRemoteWorkspaceUri('windows-dev', input!);
		assert.equal(getRemoteWorkspacePath(uri), expected);
		assert.equal(getRemoteWorkspacePath(URI.parse(uri.toString())), expected);
	}
	for (const path of [
		'C:relative',
		'C:/../project',
		'C:/NUL.txt',
		'C:/NUL .txt',
		'C:/file:stream',
		'C:/x ',
		'//server',
		'C:/x\n',
	]) {
		assert.throws(() => createSshRemoteWorkspaceUri('windows-dev', path));
	}
});

test('Remote Workspace URIs preserve legal POSIX backslashes', () => {
	const resource = createSshRemoteWorkspaceUri('BUILD-LINUX', '/srv/project\\archive');

	assert.equal(resource.toString(), 'ash-remote://ssh+build-linux/srv/project%5Carchive');
	assert.equal(getRemoteWorkspacePath(resource), '/srv/project\\archive');
});

test('Remote POSIX resource names preserve trailing spaces across adapter round trips', () => {
	const owner = createSshRemoteWorkspaceUri('build-linux', '/srv/project');
	const resource = withRemoteWorkspacePath(owner, '/srv/project/part\\name #1.rs ');
	assert.equal(resource.toString(), 'ash-remote://ssh+build-linux/srv/project/part%5Cname%20%231.rs%20');
	assert.equal(getRemoteWorkspacePath(resource), '/srv/project/part\\name #1.rs ');
});

test('adapter paths retain Remote ownership and canonical Windows drive spelling', () => {
	for (const owner of [
		createSshRemoteWorkspaceUri('windows-dev', 'C:/workspace'),
		URI.from({ scheme: 'ash-remote', authority: 'team+build', path: '/C:/workspace' }),
	]) {
		for (const path of ['c:\\workspace\\源文件.ts', '\\\\server\\share\\源文件.ts']) {
			const resource = withRemoteWorkspacePath(owner, path);
			assert.equal(resource.authority, owner.authority);
			assert.equal(
				getRemoteWorkspacePath(resource),
				path.startsWith('c:') ? 'C:/workspace/源文件.ts' : '//server/share/源文件.ts',
			);
		}
		assert.throws(() => withRemoteWorkspacePath(owner, 'C:relative'));
	}
	assert.throws(() => withRemoteWorkspacePath(URI.file('/workspace'), '/other'));
});

test('Remote Workspace URIs reject non-canonical POSIX paths instead of rewriting them', () => {
	assert.throws(() => createSshRemoteWorkspaceUri('build-linux', '/srv/project/'), /canonical/);
	assert.throws(() => createSshRemoteWorkspaceUri('build-linux', '/srv//project'), /canonical/);
	assert.throws(() => createSshRemoteWorkspaceUri('build-linux', '/srv/../project'), /canonical/);
});

test('extension-resolved folders retain canonical paths without requiring an SSH authority', () => {
	assert.equal(
		getRemoteWorkspacePath(URI.parse('ash-remote://team+build/srv/project%20%E4%B8%AD')),
		'/srv/project 中',
	);
	for (const path of ['/srv//project', '/srv/project/']) {
		assert.throws(
			() => getRemoteWorkspacePath(URI.from({ scheme: 'ash-remote', authority: 'team+build', path })),
			/canonical/,
		);
	}
	// URI parsing normalizes literal dot segments; escaped separators remain part of the decoded path.
	assert.throws(() => getRemoteWorkspacePath(URI.parse('ash-remote://team+build/srv/..%2Fproject')), /canonical/);
	assert.throws(
		() => getRemoteWorkspacePath(URI.parse('ash-remote://team+build/srv/project?ticket=secret')),
		/query or fragment/,
	);
	assert.throws(() => getRemoteWorkspacePath(URI.parse('ash-remote://ssh+-oBad/srv/project')), /valid OpenSSH/);
});
