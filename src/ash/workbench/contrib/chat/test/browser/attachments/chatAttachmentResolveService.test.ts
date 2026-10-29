import '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { isCancellationError } from '../../../../../../base/common/errors.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { Range } from '../../../../../../editor/common/core/range.js';
import type { LanguageWorkspaceSymbol } from '../../../../../../editor/common/languages.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { getSingletonServiceDescriptors } from '../../../../../../platform/instantiation/common/extensions.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../../platform/instantiation/common/serviceCollection.js';
import { IFileSearchService } from '../../../../../../platform/search/common/fileSearch.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { createBinaryDiffEditorInput, createDiffEditorInput } from '../../../../../common/editor/diffEditorInput.js';
import { IWorkingCopyService } from '../../../../../services/workingCopy/common/workingCopyService.js';
import '../../../browser/chat.shared.contribution.js';
import { IChatAttachmentResolveService } from '../../../browser/attachments/chatAttachmentResolveService.js';

function services(
	resources: DisposableStore,
	read: () => Promise<string>,
	options: { readonly text?: string; readonly files?: IFileService } = {},
): InstantiationService {
	const owner = resources.add(new InstantiationService());
	const descriptor = getSingletonServiceDescriptors().find(([id]) => id === IChatAttachmentResolveService)![1];
	owner.registerCollection(new ServiceCollection([IChatAttachmentResolveService, descriptor]));
	owner.registerInstance(
		IFileService,
		options.files ??
			({ hasProvider: () => true, readFile: async () => ({ content: await read() }) } as unknown as IFileService),
	);
	owner.registerInstance(IWorkingCopyService, {
		get: () => (options.text === undefined ? [] : [{ backupKind: 'text', backup: () => options.text }]),
	} as unknown as IWorkingCopyService);
	owner.registerInstance(IFileSearchService, {} as IFileSearchService);
	owner.registerInstance(IWorkspaceContextService, {} as IWorkspaceContextService);
	return owner;
}

test('Registered attachment resolver requires its real services before creation', () => {
	using owner = new InstantiationService();
	const descriptor = getSingletonServiceDescriptors().find(([id]) => id === IChatAttachmentResolveService)![1];
	assert.throws(() => owner.createInstance(descriptor), /Unknown service: fileService/u);
});

test('Editor context reads the modified working copy and freezes the selected content', async () => {
	using resources = new DisposableStore();
	const owner = services(
		resources,
		async () => {
			assert.fail('A dirty editor must not read disk');
		},
		{ text: 'Unsaved modified text' },
	);
	const resolver = owner.get(IChatAttachmentResolveService);
	const modified = URI.file('/workspace/modified.ts');
	const input = createDiffEditorInput(
		{ resource: URI.file('/workspace/original.ts') },
		{ resource: modified, initialText: 'Initial text' },
	);
	const attachment = await resolver.resolveEditorAttachContext(input);
	assert.equal(attachment!.resource?.toString(), modified.toString());
	assert.deepEqual(await attachment!.resolve(), { name: 'modified.ts', content: 'Unsaved modified text' });
});

test('Editor context retains providerless snapshots and rejects binary editor inputs', async () => {
	using resources = new DisposableStore();
	const owner = services(resources, async () => {
		assert.fail('A versioned snapshot must not read disk');
	});
	const resolver = owner.get(IChatAttachmentResolveService);
	const resource = URI.parse('git-change:/staged/file.ts');
	const attachment = await resolver.resolveEditorAttachContext({
		resource,
		initialText: 'Index snapshot',
		readOnly: true,
	});
	assert.deepEqual(await attachment!.resolve(), { name: 'file.ts', content: 'Index snapshot' });
	assert.equal(
		await resolver.resolveEditorAttachContext({ resource, initialBytes: new Uint8Array([0, 1]) }),
		undefined,
	);
	const binary = createBinaryDiffEditorInput(
		{ resource: URI.file('/workspace/before.bin') },
		{ resource: URI.file('/workspace/after.bin') },
	);
	assert.equal(await resolver.resolveEditorAttachContext(binary), undefined);
});

test('Cancelling resource preparation rejects even when its file provider finishes late', async () => {
	using resources = new DisposableStore();
	const read = new DeferredPromise<string>();
	const started = new DeferredPromise<void>();
	const owner = services(resources, async () => {
		await started.complete();
		return read.p;
	});
	const controller = new AbortController();
	const pending = owner
		.get(IChatAttachmentResolveService)
		.resolveResourceAttachContext(URI.file('/workspace/file.ts'), false, controller.signal);
	await started.p;
	controller.abort();
	await read.complete('Late text');
	await assert.rejects(pending, isCancellationError);
});

test('Resource images exceeding the processing limit are rejected before their bytes are read', async () => {
	using resources = new DisposableStore();
	const owner = services(
		resources,
		async () => {
			assert.fail('Images must not use text decoding');
		},
		{
			files: {
				hasProvider: () => true,
				stat: async () => ({ sizeBytes: 20 * 1024 * 1024 + 1 }),
				readFileBytes: async () => {
					assert.fail('Oversized images must not allocate their bytes');
				},
			} as unknown as IFileService,
		},
	);
	await assert.rejects(
		owner.get(IChatAttachmentResolveService).resolveResourceAttachContext(URI.file('/workspace/large.PNG'), false),
		/20 MB image limit/u,
	);
});

test('Open editor resolution skips providerless pages without losing versioned text snapshots', async () => {
	using resources = new DisposableStore();
	const owner = services(
		resources,
		async () => {
			assert.fail('Providerless pages must not be read as files');
		},
		{ files: { hasProvider: () => false } as unknown as IFileService },
	);
	const resolver = owner.get(IChatAttachmentResolveService);
	assert.equal(await resolver.resolveEditorAttachContext({ resource: URI.parse('ash-welcome:/welcome') }), undefined);
	const snapshot = await resolver.resolveEditorAttachContext({
		resource: URI.parse('git-change:/index/file.ts'),
		initialText: 'Index text',
	});
	assert.deepEqual(await snapshot!.resolve(), { name: 'file.ts', content: 'Index text' });
});

test('Open untitled editors capture unsaved content through the resolver without a file provider', async () => {
	using resources = new DisposableStore();
	const options = { text: 'Unsaved untitled content' };
	const owner = services(
		resources,
		async () => {
			assert.fail('Untitled content must never read disk');
		},
		options,
	);
	const resolver = owner.get(IChatAttachmentResolveService);
	const resource = URI.parse('untitled:/Untitled-1');
	const captured = await resolver.resolveEditorAttachContext({ resource, initialText: 'Initial content' });
	options.text = 'Later edits';
	assert.equal(captured!.resource, resource);
	assert.equal((await captured!.resolve()).content, 'Unsaved untitled content');
	const readonly = await resolver.resolveUntitledEditorAttachContext({
		resource,
		initialText: 'Displayed snapshot',
		readOnly: true,
	});
	assert.equal((await readonly!.resolve()).content, 'Displayed snapshot');
});

test('Symbol admission captures the declaration range while Search retains revision validation', async () => {
	using resources = new DisposableStore();
	const options = { text: 'before\nfunction captured() {}\nafter' };
	const owner = services(
		resources,
		async () => {
			assert.fail('Symbol attachment must read unsaved source');
		},
		options,
	);
	const symbol: LanguageWorkspaceSymbol = {
		name: 'captured',
		kind: 'function',
		resource: URI.file('/workspace/source.ts'),
		range: new Range(2, 10, 2, 18),
		data: { source: 'codebaseSymbols', declarationRange: new Range(2, 1, 2, 23) },
	};
	const resolver = owner.get(IChatAttachmentResolveService);
	const [captured] = await resolver.resolveSymbolsAttachContext([symbol]);
	options.text = 'Changed after capture';
	assert.equal(captured!.resource!.fragment, '2,1-2,23');
	assert.equal(
		(await captured!.resolve()).content,
		'Symbol: captured\nSource: file:///workspace/source.ts#2,1-2,23\n\nfunction captured() {}',
	);
	await assert.rejects(
		resolver.resolveSymbolsAttachContext([
			{ ...symbol, data: { source: 'codebaseSymbols', sourceRevision: 'sha256:stale' } },
		]),
		/source changed/u,
	);
});

suite('Displayed editor attachment versions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const diff of [false, true])
		test(`${diff ? 'diff' : 'file'} readonly content wins over another working copy at the same URI`, async () => {
			using resources = new DisposableStore();
			const owner = services(
				resources,
				async () => {
					assert.fail('A readonly editor snapshot must not read disk');
				},
				{ text: 'Different unsaved working copy' },
			);
			const displayed = {
				resource: URI.file('/workspace/version.ts'),
				initialText: 'Displayed readonly version',
				readOnly: true,
			};
			const input = diff
				? resources.add(
						createDiffEditorInput(
							{ resource: URI.file('/workspace/before.ts'), initialText: 'Before', readOnly: true },
							displayed,
						),
					)
				: displayed;
			const attachment = await owner.get(IChatAttachmentResolveService).resolveEditorAttachContext(input);
			assert.deepEqual(await attachment!.resolve(), {
				name: 'version.ts',
				content: 'Displayed readonly version',
			});
		});
});

suite('Dropped source ranges', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const eol of ['\n', '\r\n'])
		test(`source range captures the working copy with ${JSON.stringify(eol)} and keeps its original URI`, async () => {
			using resources = new DisposableStore();
			const text = ['first line', 'let captured = 42;', 'last line'].join(eol);
			const owner = services(
				resources,
				async () => {
					assert.fail('Dirty source ranges must not read disk');
				},
				{ text },
			);
			const source = URI.parse('file:///workspace/source.ts#2,5-3,5');
			const attachment = await owner
				.get(IChatAttachmentResolveService)
				.resolveResourceAttachContext(source, false);
			assert.equal(attachment.resource?.toString(), source.toString());
			assert.equal(attachment.kind, 'codeSelection');
			assert.deepEqual(await attachment.resolve(), {
				name: 'source.ts (2-3)',
				content: 'captured = 42;' + eol + 'last',
			});
		});

	test('a resolved drop never rereads the source after file contents change', async () => {
		using resources = new DisposableStore();
		let content = 'old captured line';
		const reads: string[] = [];
		const owner = services(resources, async () => content, {
			files: {
				hasProvider: () => true,
				readFile: async (resource: URI) => {
					reads.push(resource.toString());
					return { content };
				},
			} as unknown as IFileService,
		});
		const source = URI.parse('file:///workspace/source.ts#1,5-1,13');
		const attachment = await owner.get(IChatAttachmentResolveService).resolveResourceAttachContext(source, false);
		content = 'new contents after the drop';
		assert.equal((await attachment.resolve()).content, 'captured');
		assert.equal((await attachment.resolve()).content, 'captured');
		assert.deepEqual(reads, ['file:///workspace/source.ts']);
	});

	for (const range of ['1,1-9,1', '2,1-1,2', '1,1-1,200'])
		test(`unavailable source range ${range} rejects without a misleading whole-file snapshot`, async () => {
			using resources = new DisposableStore();
			const owner = services(resources, async () => 'first\nsecond');
			await assert.rejects(
				owner
					.get(IChatAttachmentResolveService)
					.resolveResourceAttachContext(URI.parse(`file:///workspace/source.ts#${range}`), false),
				/source range/u,
			);
		});
});
