import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { registerCodeEditorServices } from '../../../../../editor/test/browser/testCodeEditor.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { FileKind, IFileService, type IFileStat } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { TestWorkspaceService } from '../../../../services/configuration/test/common/testServices.js';
import { IEditorService, type EditorOpenOptions, type EditorOpenTarget } from '../../../../services/editor/common/editorService.js';
import { TestNotificationService } from '../../../../services/notification/test/common/testNotificationService.js';
import { emptyEditorServiceState } from '../../../../test/common/testEditorService.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { DebugLinkHoverBehavior, LinkDetector } from '../../browser/linkDetector.js';

suite('Debug Console text links', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('preserves plain text, HTML-looking output, empty lines and trailing newline', () => {
		using f = fixture();
		for (const text of ['', 'plain\n\nlast\n', '<script>throw 1</script>', 'a'.repeat(50000)]) {
			const row = f.render(text);
			assert.equal(row.element.textContent, text);
			assert.equal(row.element.querySelectorAll('script,[role=link]').length, 0);
		}
	});

	test('detects multiple web/mail links and excludes surrounding punctuation without truncating balanced parentheses', async () => {
		using f = fixture();
		const text = '(HTTPS://EXAMPLE.test/a(b)), https://two.test/path?q=a#b. mailto:me@example.test!';
		const row = f.render(text);
		assert.equal(row.element.textContent, text);
		assert.deepEqual(
			row.links().map(link => link.textContent),
			['HTTPS://EXAMPLE.test/a(b)', 'https://two.test/path?q=a#b', 'mailto:me@example.test'],
		);
		for (const link of row.links()) key(link, 'Enter');
		await settle();
		assert.deepEqual(f.external, ['https://example.test/a(b)', 'https://two.test/path?q=a#b', 'mailto:me@example.test']);
	});

	test('does not turn commands, scripts, data or malformed URLs into executable links', () => {
		using f = fixture();
		const row = f.render('command:delete javascript:alert(1) data:text/html,<b>x</b> https:// mailto:no-address');
		assert.equal(row.links().length, 0);
		assert.equal(row.element.querySelectorAll('b').length, 0);
	});

	test('keeps oversized URL candidates as literal output', () => {
		using f = fixture();
		const text = 'https://example.test/' + 'a'.repeat(40000) + ')'.repeat(1000);
		const row = f.render(text);
		assert.equal(row.element.textContent, text);
		assert.equal(row.links().length, 0);
	});

	test('does not guess filesystem authority when the originating folder is unavailable', async () => {
		using f = fixture();
		let reads = 0;
		f.files.stat = async () => {
			reads++;
			throw new Error('No execution context');
		};
		const text = '/workspace/main.ts:2 and src/main.ts:3';
		const row = f.render(text, DebugLinkHoverBehavior.None, false);
		await settle();
		assert.equal(row.element.textContent, text);
		assert.equal(row.links().length, 0);
		assert.equal(reads, 0);
	});

	test('plain clicks and selected output do not open links; platform modifier clicks do', async () => {
		using f = fixture();
		const row = f.render('https://example.test');
		const link = row.links()[0]!;
		click(link);
		const selection = document.getSelection()!;
		selection.selectAllChildren(link);
		click(link, { ctrlKey: true });
		selection.removeAllRanges();
		assert.deepEqual(f.external, []);
		click(link, { metaKey: true });
		await settle();
		assert.deepEqual(f.external, ['https://example.test/']);
	});

	test('row disposal removes activation listeners and pending hover UI', async () => {
		using f = fixture();
		const row = f.render('https://example.test');
		const link = row.links()[0]!;
		row.store.dispose();
		key(link, 'Enter');
		click(link, { ctrlKey: true });
		await settle();
		assert.deepEqual(f.external, []);
		assert.equal(document.querySelector('.ash-hover'), null);
	});

	test('basic and absent hover policies use the same link activation lifetime', () => {
		using f = fixture();
		assert.ok(f.render('https://example.test', DebugLinkHoverBehavior.Basic).links()[0]!.title);
		assert.equal(f.render('https://example.test', DebugLinkHoverBehavior.None).links()[0]!.title, '');
	});

	for (const [name, root, text, target, line, column] of [
		['POSIX path', 'file:///workspace', '/workspace/main.ts:7:3', 'file:///workspace/main.ts', 7, 3],
		['relative path', 'file:///workspace', 'src/main.ts:8', 'file:///workspace/src/main.ts', 8, 1],
		['dot path', 'file:///workspace', './main.ts:9:4', 'file:///workspace/main.ts', 9, 4],
		['Windows path', 'file:///C:/work', 'C:\\work\\main.ts:12:2', 'file:///C:/work/main.ts', 12, 2],
		['file URI', 'file:///workspace', 'file:///workspace/main.ts:10:5', 'file:///workspace/main.ts', 10, 5],
		['escaped file URI', 'file:///workspace', 'file:///workspace/a%20b.ts:2', 'file:///workspace/a%20b.ts', 2, 1],
		['Remote absolute path', 'ash-remote://ssh+links/workspace', '/workspace/main.ts:3:6', 'ash-remote://ssh+links/workspace/main.ts', 3, 6],
		['Remote relative path', 'ash-remote://ssh+links/workspace', 'src/main.ts:4:2', 'ash-remote://ssh+links/workspace/src/main.ts', 4, 2],
		['Remote file URI', 'ash-remote://ssh+links/workspace', 'file:///workspace/main.ts:5:2', 'ash-remote://ssh+links/workspace/main.ts', 5, 2],
	] as const) {
		test(`opens an existing ${name} through its captured authority and selection`, async () => {
			using f = fixture(URI.parse(root));
			const resource = URI.parse(target);
			if (name === 'Windows path') {
				// This POSIX test host has no Windows filesystem; assert the URI at the stat boundary.
				f.files.stat = async candidate => {
					assert.equal(candidate.toString(), resource.toString());
					return {
						resource: candidate,
						kind: FileKind.File,
						sizeBytes: 6,
						readonly: false,
						modifiedAtMillis: undefined,
					};
				};
			} else {
				await f.files.createDirectory(resource.with({ path: resource.path.slice(0, resource.path.lastIndexOf('/')) }));
				await f.files.writeFile({ resource, content: 'source' }, { create: true, overwrite: true });
			}
			const row = f.render(text);
			await settle();
			assert.equal(row.links().length, 1);
			const event = key(row.links()[0]!, 'Enter', { shiftKey: true });
			assert.equal(event.defaultPrevented, true);
			await settle();
			assert.equal(f.opened[0]?.resource.toString(), resource.toString());
			assert.equal(f.opened[0]?.options?.selection?.startLineNumber, line);
			assert.equal(f.opened[0]?.options?.selection?.startColumn, column);
			assert.equal(f.opened[0]?.target, 'sideGroup');
		});
	}

	test('missing files, directories and invalid line/column numbers remain plain text', async () => {
		using f = fixture();
		await f.files.createDirectory(URI.file('/workspace/folder'));
		const text = '/workspace/missing.ts:2 /workspace/folder /workspace/main.ts:0:2 /workspace/main.ts:2:0';
		const row = f.render(text);
		await settle();
		assert.equal(row.element.textContent, text);
		assert.equal(row.links().length, 0);
	});

	for (const change of ['row disposal', 'workspace replacement'] as const) {
		test(`discards a held file stat after ${change}`, async () => {
			using f = fixture();
			const reply = new DeferredPromise<IFileStat>();
			f.files.stat = async () => reply.p;
			const row = f.render('/workspace/main.ts:2');
			if (change === 'row disposal') row.store.dispose();
			else f.workspace.updateWorkspace({ id: 'other', uri: URI.file('/other') });
			await reply.complete({
				resource: URI.file('/workspace/main.ts'),
				kind: FileKind.File,
				sizeBytes: 0,
				readonly: false,
				modifiedAtMillis: undefined,
			});
			await settle();
			assert.equal(row.links().length, 0);
		});
	}

	test('opening failures report through notifications only while the row is current', async () => {
		using f = fixture();
		const reply = new DeferredPromise<boolean>();
		f.openers.setDefaultExternalOpener({ openExternal: async () => reply.p });
		const row = f.render('https://example.test');
		key(row.links()[0]!, 'Enter');
		row.store.dispose();
		await reply.error(new Error('retired'));
		await settle();
		assert.equal(f.notifications.model.getNotifications().length, 0);
		f.openers.setDefaultExternalOpener({
			openExternal: async () => {
				throw new Error('Open failed');
			},
		});
		key(f.render('https://example.test').links()[0]!, 'Enter');
		await settle();
		assert.equal(f.notifications.model.getNotifications()[0]?.message, 'Open failed');
	});
});

function fixture(root = URI.file('/workspace')) {
	const resources = new DisposableStore();
	const files = resources.add(new FileService());
	const provider = resources.add(new InMemoryFileSystemProvider());
	resources.add(files.registerProvider('file', provider));
	resources.add(files.registerProvider('ash-remote', provider));
	const workspace = resources.add(new TestWorkspaceService({ id: 'workspace', uri: root }));
	const notifications = resources.add(new TestNotificationService());
	const opened: { resource: URI; options?: EditorOpenOptions; target?: EditorOpenTarget }[] = [];
	const editors: IEditorService = {
		...emptyEditorServiceState,
		openEditor: async (input, options, target) => {
			opened.push({ resource: input.resource, options, target });
		},
		focusActiveEditor() {},
	};
	const services = workbenchInstantiationService(resources).createChild(
		new ServiceCollection([IFileService, files], [IWorkspaceContextService, workspace], [IEditorService, editors], [INotificationService, notifications]),
	);
	registerCodeEditorServices(services);
	const openers = services.get(IOpenerService);
	const external: string[] = [];
	openers.setDefaultExternalOpener({
		openExternal: async value => {
			external.push(value);
			return true;
		},
	});
	const detector = services.createInstance(LinkDetector);
	return Object.assign(resources, {
		files,
		workspace,
		notifications,
		openers,
		opened,
		external,
		render(text: string, type = DebugLinkHoverBehavior.Rich, withFolder = true) {
			const store = resources.add(new DisposableStore());
			const element = detector.linkify(text, { type, store }, true, withFolder ? workspace.getWorkspace().folders[0] : undefined);
			document.body.append(element);
			resources.add(toDisposable(() => element.remove()));
			return { element, store, links: () => [...element.querySelectorAll<HTMLElement>('[role=link]')] };
		},
	});
}

function key(target: HTMLElement, key: string, options: KeyboardEventInit = {}): KeyboardEvent {
	const event = new browserEnvironment.window.KeyboardEvent('keydown', {
		key,
		bubbles: true,
		cancelable: true,
		...options,
	});
	target.dispatchEvent(event);
	return event;
}

function click(target: HTMLElement, options: MouseEventInit = {}): void {
	target.dispatchEvent(new browserEnvironment.window.MouseEvent('click', { bubbles: true, ...options }));
}

async function settle(): Promise<void> {
	await new Promise<void>(resolve => setImmediate(resolve));
}
