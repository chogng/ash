import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from '../../../automation/test.js';
import type { URI as FileResource } from '../../../../src/ash/base/common/uri.js';

test(
	'concurrent generic folder copies preserve the published disk target and Explorer contents',
	{ tag: ['@electron-app-server'] },
	async ({ application, workbench, testWorkspace }, testInfo) => {
		if (!('windows' in application)) throw new Error('Electron is required');
		for (const name of ['copy-first', 'copy-second']) {
			await mkdir(join(testWorkspace.directory, name));
			await writeFile(
				join(testWorkspace.directory, name, 'kept.txt'),
				name === 'copy-first' ? 'losing copy\n' : 'winning copy\n',
			);
		}
		for (const failure of ['read', 'publish'] as const) {
			// Exercise the production generic copy and disk provider in Electron. The
			// source alias selects cross-provider traversal; disk operations stay real.
			const result = await application.evaluate(
				async (_electron, { moduleRoot, directory, failure }) => {
					const require = process.getBuiltinModule('module').createRequire(moduleRoot + '/fileService.js');
					const { FileService } = require(
						moduleRoot + '/fileService.js',
					) as typeof import('../../../../src/ash/platform/files/common/fileService.js');
					const { DiskFileSystemProvider } = require(
						moduleRoot + '/../node/diskFileSystemProvider.js',
					) as typeof import('../../../../src/ash/platform/files/node/diskFileSystemProvider.js');
					const { URI } = require(
						moduleRoot + '/../../../base/common/uri.js',
					) as typeof import('../../../../src/ash/base/common/uri.js');
					const { FileNotFoundError } = require(
						moduleRoot + '/files.js',
					) as typeof import('../../../../src/ash/platform/files/common/files.js');
					const disk = new DiskFileSystemProvider([URI.file(directory)]);
					const files = new FileService();
					const target = URI.joinPath(URI.file(directory), `copy-${failure}`);
					let releaseStats!: () => void;
					const stats = new Promise<void>(resolve => {
						releaseStats = resolve;
					});
					let missing = 0;
					const stat = disk.stat.bind(disk);
					disk.stat = async resource => {
						try {
							return await stat(resource);
						} catch (error) {
							if (resource.path === target.path && error instanceof FileNotFoundError && missing < 2) {
								if (++missing === 2) releaseStats();
								await stats;
							}
							throw error;
						}
					};
					let releaseRead!: () => void;
					const readGate = new Promise<void>(resolve => {
						releaseRead = resolve;
					});
					const source = new Proxy(disk, {
						get(provider, property) {
							if (property === 'stat')
								return (resource: FileResource) => stat(resource.with({ scheme: 'file' }));
							if (property === 'readDirectory')
								return async (resource: FileResource) =>
									(await provider.readDirectory(resource.with({ scheme: 'file' }))).map(entry => ({
										...entry,
										resource: entry.resource.with({ scheme: 'ash-copy-source' }),
									}));
							if (property === 'readFile')
								return async (resource: FileResource) => {
									if (resource.path.includes('/copy-first/')) {
										await readGate;
										if (failure === 'read') throw new Error('Deliberate source read failure');
									}
									return provider.readFile(resource.with({ scheme: 'file' }));
								};
							const member = Reflect.get(provider, property, provider);
							return typeof member === 'function' ? member.bind(provider) : member;
						},
					});
					try {
						files.registerProvider('ash-copy-source', source);
						files.registerProvider('file', disk);
						const first = files
							.copy(
								URI.joinPath(URI.file(directory), 'copy-first').with({ scheme: 'ash-copy-source' }),
								target,
							)
							.then(
								() => 'unexpected success',
								error => String(error),
							);
						try {
							await files.copy(
								URI.joinPath(URI.file(directory), 'copy-second').with({ scheme: 'ash-copy-source' }),
								target,
							);
						} finally {
							releaseRead();
						}
						return {
							error: await first,
							content: new TextDecoder().decode(
								(await disk.readFile(URI.joinPath(target, 'kept.txt'))).bytes,
							),
						};
					} finally {
						releaseStats();
						releaseRead();
						files.dispose();
						disk.dispose();
					}
				},
				{
					moduleRoot: resolve('.build/desktop/main/src/ash/platform/files/common'),
					directory: testWorkspace.directory,
					failure,
				},
			);
			expect(result.error).toMatch(failure === 'read' ? /Deliberate source read failure/ : /exists/i);
			expect(result.content).toBe('winning copy\n');
			expect(await readFile(join(testWorkspace.directory, `copy-${failure}`, 'kept.txt'), 'utf8')).toBe(
				'winning copy\n',
			);
		}
		expect((await readdir(testWorkspace.directory)).filter(name => name.startsWith('.ash-copy-'))).toEqual([]);
		await workbench.quickaccess.runCommand('workbench.files.action.refreshFilesExplorer');
		const folder = workbench.page
			.locator('.ash-explorer')
			.getByRole('treeitem', { name: 'copy-read', exact: true });
		await expect(folder).toBeVisible();
		await folder.locator('.ash-tree-twistie').click();
		await workbench.page
			.locator('.ash-explorer')
			.getByRole('treeitem')
			.filter({ has: workbench.page.getByText('kept.txt', { exact: true }) })
			.dblclick();
		await workbench.editors.groupAt(0).editor.waitForEditorContents(text => text === 'winning copy\n');
		await testInfo.attach('concurrent-copy-disk-and-explorer', {
			body: await workbench.page.screenshot(),
			contentType: 'image/png',
		});
	},
);
