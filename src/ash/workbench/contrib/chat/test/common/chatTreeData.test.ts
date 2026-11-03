import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { reviveChatTreeData } from '../../common/chatService/chatService.js';

const tree = (children: unknown[] = []) => ({ kind: 'treeData', treeData: { label: 'workspace', uri: 'file:///workspace', children } });
const file = (uri = 'file:///workspace/main.ts') => ({ label: 'main.ts', uri, type: 'file' });

suite('Chat structured file tree boundary', () => {
	test('revives nested local and remote snapshot URIs without loading any resources', () => {
		const data = reviveChatTreeData(JSON.stringify(tree([file(), { label: 'src', uri: 'file:///workspace/src', children: [{ label: '内容.md', uri: 'file:///workspace/src/内容.md' }] }])));
		assert.equal(data?.treeData.children?.[1]?.children?.[0]?.uri.path, '/workspace/src/内容.md');
		assert.equal(data?.treeData.type, 'directory');
		const remote = reviveChatTreeData(JSON.stringify({ kind: 'treeData', treeData: { label: 'Remote', uri: 'ash-remote://ssh-host/project', children: [{ label: 'entry', uri: 'ash-remote://ssh-host/project/entry' }] } }));
		assert.equal(remote?.treeData.children?.[0]?.uri.authority, 'ssh-host');
	});
	test('ordinary structured data and incomplete or invalid payloads remain ordinary resources', () => {
		for (const input of ['{', '{}', JSON.stringify({ kind: 'markdownContent', treeData: tree().treeData }), JSON.stringify({ kind: 'treeData', treeData: { uri: 'file:///workspace' } })]) assert.equal(reviveChatTreeData(input), undefined);
	});
	test('rejects executable, cross-host, parent-traversal and out-of-root resources', () => {
		for (const uri of ['command:run', 'https://example.invalid/file', 'file:///outside', 'file:///workspace/../private', 'file:///workspace/a?x=1', 'file:///workspace/a#L1', 'ash-remote://other/workspace/a']) assert.equal(reviveChatTreeData(JSON.stringify(tree([file(uri)]))), undefined, uri);
	});
	test('rejects repeated identities, malformed children and file nodes with children', () => {
		for (const payload of [tree([file(), file()]), tree([{ ...file(), children: [] }]), tree([{ label: 'bad', uri: 'file:///workspace/bad', children: 'not a list' }])]) assert.equal(reviveChatTreeData(JSON.stringify(payload)), undefined);
	});
	test('bounds text, labels, depth and total node count', () => {
		assert.equal(reviveChatTreeData(' '.repeat(262145)), undefined);
		assert.equal(reviveChatTreeData(JSON.stringify(tree([{ ...file(), label: 'x'.repeat(513) }]))), undefined);
		assert.equal(reviveChatTreeData(JSON.stringify(tree(Array.from({ length: 1000 }, (_, i) => ({ label: String(i), uri: `file:///workspace/${i}` }))))), undefined);
		const deep: { label: string; uri: string; children: typeof deep[]; } = { label: 'root', uri: 'file:///workspace', children: [] };
		let cursor = deep;
		for (let i = 0; i < 34; i++) {
			const child = { label: 'nested', uri: cursor.uri + '/d', children: [] };
			cursor.children.push(child); cursor = child;
		}
		assert.equal(reviveChatTreeData(JSON.stringify({ kind: 'treeData', treeData: deep })), undefined);
	});
	test('treats markup in labels as inert user content', () => {
		const data = tree([{ ...file(), label: '<img onerror=alert(1)>' }]);
		assert.equal(reviveChatTreeData(JSON.stringify(data))?.treeData.children?.[0]?.label, '<img onerror=alert(1)>');
	});
});
