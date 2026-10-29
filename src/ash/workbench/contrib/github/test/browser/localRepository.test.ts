import assert from 'node:assert/strict';
import { test } from 'mocha';
import { CommandsRegistry, type ICommandService } from '../../../../../platform/commands/common/commands.js';
import { readLocalRepositories } from '../../common/localRepository.js';

const repository = {
	id: 'repo',
	label: 'Repository',
	path: '/repo',
	root: 'file:///repo',
	head: { type: 'branch', name: 'feature', objectId: 'commit' },
	remotes: [],
};

test('optional Git contexts retain provider counts without inventing values for older providers', async () => {
	using registration = CommandsRegistry.register('git.getRepositoryContexts', () => undefined);
	let result: unknown = [repository];
	const commands = { executeCommand: async () => result } as unknown as ICommandService;
	const [older] = await readLocalRepositories(commands);
	assert.equal(older!.uncommittedChanges, undefined);
	assert.equal(older!.head.upstream, undefined);
	result = [
		{
			...repository,
			uncommittedChanges: 3,
			head: { ...repository.head, upstream: { name: 'origin/feature', ahead: 2, behind: 1 } },
		},
	];
	const [current] = await readLocalRepositories(commands);
	assert.equal(current!.uncommittedChanges, 3);
	assert.deepEqual(current!.head.upstream, { name: 'origin/feature', ahead: 2, behind: 1 });
});

test('repository count decoding rejects malformed extension data at the command boundary', async () => {
	using registration = CommandsRegistry.register('git.getRepositoryContexts', () => undefined);
	for (const value of [-1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
		const commands = {
			executeCommand: async () => [{ ...repository, uncommittedChanges: value }],
		} as unknown as ICommandService;
		await assert.rejects(readLocalRepositories(commands), /Invalid repository context count/u);
	}
	const commands = {
		executeCommand: async () => [{ ...repository, head: { ...repository.head, upstream: { name: 'origin/main', ahead: 0, behind: -1 } } }],
	} as unknown as ICommandService;
	await assert.rejects(readLocalRepositories(commands), /Invalid repository context count/u);
});

test('window-owned Git contexts are read even without a global command contribution', async () => {
	assert.equal(CommandsRegistry.hasCommand('git.getRepositoryContexts'), false);
	const commands = { executeCommand: async () => [repository] } as unknown as ICommandService;
	assert.equal((await readLocalRepositories(commands))[0]?.id, 'repo');
	const absent = {
		executeCommand: async () => {
			throw new Error('Unknown command: git.getRepositoryContexts');
		},
	} as unknown as ICommandService;
	assert.deepEqual(await readLocalRepositories(absent), []);
	const failed = {
		executeCommand: async () => {
			throw new Error('Git discovery failed');
		},
	} as unknown as ICommandService;
	await assert.rejects(readLocalRepositories(failed), /Git discovery failed/);
});
