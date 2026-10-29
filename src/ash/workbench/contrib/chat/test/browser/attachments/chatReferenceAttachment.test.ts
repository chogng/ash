import '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Event } from '../../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { URI } from '../../../../../../base/common/uri.js';
import { Schemas } from '../../../../../../base/common/network.js';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { MarkdownString } from '../../../../../../base/common/htmlContent.js';
import { addDisposableListener } from '../../../../../../base/browser/dom.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { IChatSessionNavigationService } from '../../../../../services/chat/common/chatSessionNavigationService.js';
import type { ChatContextAttachment } from '../../../../../services/chat/common/chatContextService.js';
import {
	ChatAttachmentWidgetRegistry,
	IChatAttachmentWidgetRegistry,
	type ChatAttachmentWidgetFactory,
	type IChatAttachmentWidgetInstance,
} from '../../../browser/attachments/chatAttachmentWidgetRegistry.js';
import { ChatReferenceAttachmentWidgetContribution } from '../../../browser/attachments/chatReferenceAttachmentWidget.contribution.js';
import {
	ChatReferenceAttachmentWidget,
	DefaultChatAttachmentWidget,
	ElementChatAttachmentWidget,
	SCMHistoryItemAttachmentWidget,
	SCMHistoryItemChangeAttachmentWidget,
	FileAttachmentWidget,
	ImageAttachmentWidget,
	PromptFileAttachmentWidget,
	TerminalCommandAttachmentWidget,
	ToolSetOrToolItemAttachmentWidget,
} from '../../../browser/attachments/chatAttachmentWidgets.js';
import { IResourceIconRenderer } from '../../../../../browser/labels.js';
import { noFileIconTheme } from '../../../../../../platform/theme/common/themeService.js';
import { BrowserContextViewService } from '../../../../../../platform/contextview/browser/contextViewService.js';
import {
	IContextMenuService,
	IContextViewService,
	type IContextMenuMenuDelegate,
} from '../../../../../../platform/contextview/browser/contextView.js';
import {
	ContextKeyService,
	IContextKeyService,
} from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { ILabelService } from '../../../../../../platform/label/common/label.js';
import { MenuService } from '../../../../../../platform/actions/common/menuService.js';
import { MenuId } from '../../../../../../platform/actions/common/actions.js';
import { ResourceSchemeContext } from '../../../../../common/contextkeys.js';
import '../../../../files/browser/fileActions.contribution.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { TerminalCommandId } from '../../../../terminal/common/terminal.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { SCMHistoryItemUri } from '../../../../scm/common/history.js';
import type { CancellationToken } from '../../../../../../base/common/cancellation.js';

suite('Registered Chat reference attachments', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const attachment: ChatContextAttachment = {
		id: 'reference',
		kind: 'sessionReference',
		name: 'Earlier design',
		resource: URI.from({
			scheme: Schemas.internal,
			authority: 'chat-session',
			query: 'sessionId=source-session&threadId=source-thread',
		}),
		resolve: async () => {
			throw new Error('Rendering or opening a reference must not reread its snapshot');
		},
	};

	function fixture(
		resources: DisposableStore,
		openConversation: IChatSessionNavigationService['openConversation'] = async () => {},
	) {
		const services = resources.add(new InstantiationService());
		const errors: unknown[] = [];
		services.registerInstance(IChatSessionNavigationService, { openConversation } as IChatSessionNavigationService);
		services.registerInstance(INotificationService, {
			error: error => {
				errors.push(error);
			},
		} as INotificationService);
		services.registerSingleton(IChatAttachmentWidgetRegistry, () => new ChatAttachmentWidgetRegistry());
		const container = document.createElement('div');
		document.body.append(container);
		resources.add(toDisposable(() => container.remove()));
		return { services, errors, container };
	}

	function specializedFixture(
		resources: DisposableStore,
		commands: ICommandService = {
			executeCommand: async () => {
				throw new Error('Unexpected command');
			},
		} as unknown as ICommandService,
	) {
		const result = fixture(resources);
		result.services.registerInstance(ICommandService, commands);
		result.services.registerInstance(IResourceIconRenderer, {
			onDidChangeResourceIcons: Event.None,
			getFileIconTheme: () => noFileIconTheme,
			renderFileIcon() {},
		});
		const views = resources.add(new BrowserContextViewService(document.body));
		result.services.registerInstance(IContextViewService, views);
		const contextKeys = resources.add(new ContextKeyService());
		result.services.registerInstance(IContextKeyService, contextKeys);
		const menus: IContextMenuMenuDelegate[] = [];
		result.services.registerInstance(IContextMenuService, {
			contextMenuStyle: 'custom',
			onDidShowContextMenu: Event.None,
			onDidHideContextMenu: Event.None,
			showContextMenu: menu => {
				menus.push(menu);
			},
			hideContextMenu() {},
		});
		result.services.registerInstance(ILabelService, {
			getUriLabel: uri => (uri.scheme === 'file' ? uri.fsPath : uri.toString()),
		} as ILabelService);
		return { ...result, views, contextKeys, menus };
	}

	test('file resource gestures target the captured source, isolate context and retire with the control', async () => {
		using resources = new DisposableStore();
		const calls: unknown[][] = [];
		const { services, container, menus, contextKeys } = specializedFixture(resources, {
			executeCommand: async (...args: unknown[]) => {
				calls.push(args);
			},
		} as unknown as ICommandService);
		ResourceSchemeContext.bindTo(contextKeys).set('https');
		const resource = URI.parse('file:///workspace/captured.ts#4,2-5,8');
		using widget = services.createInstance(
			FileAttachmentWidget,
			{ ...attachment, kind: 'file', resource },
			{ supportsDeletion: false, shouldFocusClearButton: false },
			container,
		);
		let opened = 0;
		resources.add(
			widget.onDidOpen(() => {
				opened++;
			}),
		);
		const source = widget.element.querySelector<HTMLButtonElement>('button')!;
		assert.equal(source.draggable, true);
		const transfer = new Map<string, string>();
		const drag = new MouseEvent('dragstart', { bubbles: true, cancelable: true });
		const dataTransfer = {
			setData: (type: string, value: string) => transfer.set(type, value),
			setDragImage() {},
			effectAllowed: '',
		};
		Object.defineProperty(drag, 'dataTransfer', { value: dataTransfer });
		source.dispatchEvent(drag);
		assert.equal(transfer.get('text/uri-list'), resource.toString());
		assert.deepEqual(JSON.parse(transfer.get('ResourceURLs')!), [resource.toString()]);
		assert.deepEqual(JSON.parse(transfer.get('CodeFiles')!), ['/workspace/captured.ts']);
		assert.equal(dataTransfer.effectAllowed, 'copyLink');
		assert.ok(![...transfer.values()].some(value => value.includes('Earlier design')));
		source.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }),
		);
		assert.equal(menus.length, 1);
		const menu = menus[0]!;
		assert.equal(menu.menuId, MenuId.ChatInputResourceAttachmentContext);
		assert.equal(menu.getAnchor(), source);
		assert.equal(document.activeElement, source);
		assert.equal(menu.contextKeyService!.getContext().getValue('resourceScheme'), 'file');
		assert.equal(menu.contextKeyService!.getContext().getValue('resource'), resource.toString());
		assert.equal(contextKeys.getContext().getValue('resourceScheme'), 'https');
		const actions = services
			.createInstance(MenuService)
			.getMenuActions(menu.menuId!, menu.menuActionOptions, menu.contextKeyService)
			.flatMap(([, actions]) => actions);
		assert.deepEqual(
			actions.map(action => action.id),
			['explorer.openToSide', 'revealInExplorer', 'copyFilePath', 'copyRelativeFilePath'],
		);
		await actions[0]!.run();
		assert.deepEqual(calls, [['explorer.openToSide', resource]]);
		assert.equal(opened, 0);
		widget.dispose();
		assert.equal(menu.cancellationToken!.isCancellationRequested, true);
		assert.equal(source.draggable, false);
		source.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		assert.equal(menus.length, 1);
	});

	test('file actions own native deletion and opening without acquiring or changing the saved snapshot', () => {
		using resources = new DisposableStore();
		const { services, container } = specializedFixture(resources);
		using widget = services.createInstance(
			FileAttachmentWidget,
			{ ...attachment, kind: 'file', name: 'saved.ts' },
			{ supportsDeletion: true, shouldFocusClearButton: true },
			container,
		);
		const buttons = widget.element.querySelectorAll<HTMLButtonElement>('button');
		assert.equal(document.activeElement, buttons[1]);
		let opened = 0;
		let removed = 0;
		resources.add(
			widget.onDidOpen(() => {
				opened++;
			}),
		);
		resources.add(
			widget.onDidDelete(() => {
				removed++;
			}),
		);
		buttons[0]!.click();
		buttons[1]!.click();
		buttons[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
		assert.deepEqual({ opened, removed }, { opened: 1, removed: 2 });
		using readonly = services.createInstance(
			FileAttachmentWidget,
			{ ...attachment, kind: 'file' },
			{ supportsDeletion: false, shouldFocusClearButton: false },
			container,
		);
		assert.equal(readonly.element.querySelectorAll('button').length, 1);
	});

	for (const [type, kind] of [
		[FileAttachmentWidget, 'directory'],
		[ImageAttachmentWidget, 'image'],
		[PromptFileAttachmentWidget, 'instruction'],
		[DefaultChatAttachmentWidget, 'symbol'],
	] as const) {
		test(`${kind} source drag and context menu share the resource owner without opening or deleting the attachment`, async () => {
			using resources = new DisposableStore();
			const { services, container, menus } = specializedFixture(resources);
			services.registerInstance(IOpenerService, {
				open: async () => {
					assert.fail('Resource gestures must not activate the source');
				},
			} as unknown as IOpenerService);
			const resource = URI.parse(
				kind === 'directory' ? 'file:///workspace/folder' : 'file:///workspace/source.ts#3,2-4,5',
			);
			using widget = services.createInstance<IChatAttachmentWidgetInstance>(
				type,
				{
					...attachment,
					kind,
					resource,
					resolve: async () => {
						assert.equal(kind, 'image', 'Only image preview initialization acquires captured content');
						return { name: 'image', content: 'data:image/png;base64,Y2FwdHVyZWQ=' };
					},
				},
				{ supportsDeletion: true, shouldFocusClearButton: false },
				container,
			);
			await Promise.resolve();
			let removed = 0;
			resources.add(
				widget.onDidDelete(() => {
					removed++;
				}),
			);
			const source = widget.element.querySelector<HTMLButtonElement>('button')!;
			const values = new Map<string, string>();
			const drag = new MouseEvent('dragstart', { bubbles: true });
			Object.defineProperty(drag, 'dataTransfer', {
				value: { setData: (type: string, value: string) => values.set(type, value), setDragImage() {} },
			});
			source.dispatchEvent(drag);
			assert.equal(values.get('text/uri-list'), resource.toString());
			if (kind === 'directory') {
				assert.equal(values.has('CodeFiles'), false);
				assert.equal(values.has('DownloadURL'), false);
			}
			source.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
			assert.equal(menus.length, 1);
			assert.equal(
				menus[0]!.menuId,
				kind === 'symbol' ? MenuId.ChatInputSymbolAttachmentContext : MenuId.ChatInputResourceAttachmentContext,
			);
			const actions = services
				.createInstance(MenuService)
				.getMenuActions(menus[0]!.menuId!, menus[0]!.menuActionOptions, menus[0]!.contextKeyService)
				.flatMap(([, actions]) => actions);
			assert.equal(
				actions.some(action => action.id === 'explorer.openToSide'),
				kind !== 'directory',
			);
			assert.equal(removed, 0);
		});
	}

	test('internal snapshots and clipboard images do not expose source-file drags or menus', async () => {
		using resources = new DisposableStore();
		const { services, container, menus } = specializedFixture(resources);
		using file = services.createInstance(
			FileAttachmentWidget,
			{ ...attachment, kind: 'file', resource: URI.parse('inmemory:/saved-content') },
			{ supportsDeletion: false, shouldFocusClearButton: false },
			container,
		);
		using image = services.createInstance(
			ImageAttachmentWidget,
			{
				...attachment,
				kind: 'image',
				resource: undefined,
				resolve: async () => ({ name: 'image', content: 'data:image/png;base64,Y2FwdHVyZWQ=' }),
			},
			{ supportsDeletion: false, shouldFocusClearButton: false },
			container,
		);
		await Promise.resolve();
		for (const widget of [file, image]) {
			assert.equal(widget.element.querySelector('button')!.draggable, false);
			widget.element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		}
		assert.equal(image.element.querySelector('img')!.draggable, false);
		assert.deepEqual(menus, []);
	});

	test('a pending image stays removable and cannot update a disposed thumbnail', async () => {
		using resources = new DisposableStore();
		const { services, container } = specializedFixture(resources);
		const pending = new DeferredPromise<{ name: string; content: string }>();
		using widget = services.createInstance(
			ImageAttachmentWidget,
			{ ...attachment, kind: 'image', resolve: () => pending.p },
			{ supportsDeletion: true, shouldFocusClearButton: false },
			container,
		);
		const buttons = widget.element.querySelectorAll<HTMLButtonElement>('button');
		const thumbnail = widget.element.querySelector('img')!;
		assert.equal(buttons[0]!.disabled, true);
		assert.equal(buttons[1]!.disabled, false);
		resources.add(widget.onDidDelete(() => widget.dispose()));
		buttons[1]!.click();
		await pending.complete({ name: 'saved.png', content: 'data:image/png;base64,Y2FwdHVyZWQ=' });
		await Promise.resolve();
		assert.equal(thumbnail.getAttribute('src'), null);
		assert.equal(container.childElementCount, 0);
		assert.equal(document.querySelector('.ash-chat-image-reference-preview'), null);
	});

	test('image preview borrows captured bytes and disposal cannot close a later context view', async () => {
		using resources = new DisposableStore();
		const { services, container, views } = specializedFixture(resources);
		let reads = 0;
		const url = 'data:image/png;base64,Y2FwdHVyZWQ=';
		using widget = services.createInstance(
			ImageAttachmentWidget,
			{
				...attachment,
				kind: 'image',
				resolve: async () => {
					reads++;
					return { name: 'saved.png', content: url };
				},
			},
			{ supportsDeletion: false, shouldFocusClearButton: false },
			container,
		);
		await Promise.resolve();
		const thumbnail = widget.element.querySelector('img')!;
		const source = widget.element.querySelector<HTMLButtonElement>('button')!;
		assert.equal(source.disabled, true, 'Resolving a data URL does not finish native image loading');
		assert.equal(widget.element.getAttribute('aria-busy'), 'true');
		assert.equal(source.getAttribute('title'), 'Loading preview: Earlier design');
		assert.equal(thumbnail.hidden, true);
		Object.defineProperty(thumbnail, 'naturalWidth', { value: 1 });
		thumbnail.dispatchEvent(new window.Event('load'));
		assert.equal(source.disabled, false);
		assert.equal(thumbnail.hidden, false);
		assert.equal(widget.element.getAttribute('aria-busy'), 'false');
		thumbnail.dispatchEvent(new window.Event('error'));
		assert.equal(source.disabled, false, 'The completed load no longer observes retired loading events');
		// JSDOM has no layout; focus restoration requires a rendered anchor.
		Object.defineProperty(source, 'getClientRects', { value: () => [{}] });
		for (let ancestor = source.parentElement; ancestor; ancestor = ancestor.parentElement) {
			const element = ancestor;
			const scrollTo = element.scrollTo;
			element.scrollTo = () => {};
			resources.add(
				toDisposable(() => {
					element.scrollTo = scrollTo;
				}),
			);
		}
		const other = document.createElement('button');
		container.append(other);
		other.focus();
		source.click();
		assert.equal(document.querySelector<HTMLImageElement>('.ash-chat-image-reference-preview > img')?.src, url);
		views.hide();
		assert.equal(document.activeElement, source);
		source.click();
		const replacement = document.createElement('div');
		replacement.textContent = 'Another context view';
		assert.equal(views.show({ anchor: source, content: replacement }), true);
		widget.dispose();
		assert.equal(replacement.isConnected, true);
		assert.equal(thumbnail.getAttribute('src'), null);
		assert.equal(reads, 1);
		views.hide();
	});

	for (const failure of ['resolve', 'format', 'native'] as const)
		test(`an image ${failure} failure ends loading without enabling an empty preview or losing removal`, async () => {
			using resources = new DisposableStore();
			const { services, container } = specializedFixture(resources);
			using widget = services.createInstance(
				ImageAttachmentWidget,
				{
					...attachment,
					kind: 'image',
					name: 'saved.png',
					resolve: async () => {
						if (failure === 'resolve') throw new Error('Snapshot unavailable');
						return {
							name: 'saved.png',
							content:
								failure === 'format'
									? 'https://example.invalid/image.png'
									: 'data:image/png;base64,Y2FwdHVyZWQ=',
						};
					},
				},
				{ supportsDeletion: true, shouldFocusClearButton: false },
				container,
			);
			await Promise.resolve();
			const thumbnail = widget.element.querySelector('img')!;
			const buttons = widget.element.querySelectorAll<HTMLButtonElement>('button');
			if (failure === 'native') thumbnail.dispatchEvent(new window.Event('error'));
			assert.equal(widget.element.getAttribute('aria-busy'), 'false');
			assert.equal(widget.element.getAttribute('aria-label'), 'Preview unavailable: saved.png');
			assert.equal(buttons[0]!.disabled, true);
			assert.equal(buttons[0]!.getAttribute('title'), 'Preview unavailable: saved.png');
			assert.equal(thumbnail.hidden, true);
			assert.equal(thumbnail.getAttribute('src'), null);
			// Retired load events cannot turn a failed capture back into a clickable preview.
			Object.defineProperty(thumbnail, 'naturalWidth', { value: 1 });
			thumbnail.dispatchEvent(new window.Event('load'));
			buttons[0]!.click();
			widget.element.click();
			assert.equal(buttons[0]!.disabled, true);
			assert.equal(document.querySelector('.ash-chat-image-reference-preview'), null);
			let removed = 0;
			resources.add(
				widget.onDidDelete(() => {
					removed++;
				}),
			);
			buttons[1]!.click();
			assert.equal(removed, 1);
		});

	test('terminal source actions use the original terminal command and suppress retired failures', async () => {
		using resources = new DisposableStore();
		const pending = new DeferredPromise<void>();
		const calls: unknown[][] = [];
		const { services, container, errors } = specializedFixture(resources, {
			executeCommand: (...args: unknown[]) => {
				calls.push(args);
				return pending.p;
			},
		} as unknown as ICommandService);
		using widget = services.createInstance(
			TerminalCommandAttachmentWidget,
			{
				...attachment,
				kind: 'terminalCommand',
				resource: URI.from({ scheme: Schemas.internal, authority: 'terminal', query: 'id=original-terminal' }),
			},
			{ supportsDeletion: true, shouldFocusClearButton: false },
			container,
		);
		widget.element.querySelector('button')!.click();
		widget.element.querySelector('button')!.click();
		assert.deepEqual(calls, [[TerminalCommandId.Focus, 'original-terminal']]);
		widget.dispose();
		await pending.error(new Error('Terminal closed'));
		await Promise.resolve();
		assert.deepEqual(errors, []);
	});

	for (const type of [
		FileAttachmentWidget,
		DefaultChatAttachmentWidget,
		ElementChatAttachmentWidget,
		SCMHistoryItemAttachmentWidget,
		SCMHistoryItemChangeAttachmentWidget,
	])
		test(`${type.name} owns safe captured hover replacement and disposal`, () => {
			using resources = new DisposableStore();
			const { services, container } = specializedFixture(resources);
			services.registerInstance(IOpenerService, { open: async () => true } as unknown as IOpenerService);
			using widget = services.createInstance<
				IChatAttachmentWidgetInstance & Pick<FileAttachmentWidget, 'setHoverMessage' | 'hideHover'>
			>(type, attachment, { supportsDeletion: true, shouldFocusClearButton: false }, container);
			const source = widget.element.querySelector<HTMLButtonElement>('button')!;
			widget.setHoverMessage(
				new MarkdownString().appendCodeblock(
					'plaintext',
					'<button onclick="captured()">First captured preview</button>',
				),
			);
			assert.match(source.title, /First captured preview/u);
			assert.equal(container.querySelector('[onclick]'), null);
			widget.setHoverMessage(new MarkdownString().appendText('Replacement captured preview'));
			assert.equal(source.title.replace(/\u00a0/gu, ' ').trim(), 'Replacement captured preview');
			widget.setHoverMessage(new MarkdownString().appendText('Replacement captured preview'));
			assert.equal(source.title.replace(/\u00a0/gu, ' ').trim(), 'Replacement captured preview');
			widget.hideHover();
			widget.dispose();
			widget.setHoverMessage(new MarkdownString().appendText('Retired preview'));
			assert.equal(source.getAttribute('title'), null);
			assert.equal(source.isConnected, false);
		});

	test('element controls separate captured text from its original safe page URL', async () => {
		using resources = new DisposableStore();
		const calls: unknown[] = [];
		const { services, container } = specializedFixture(resources);
		services.registerInstance(IOpenerService, {
			open: async (...args: unknown[]) => {
				calls.push(args);
				return true;
			},
		} as unknown as IOpenerService);
		const resource = URI.parse('https://example.test/captured?q=before#element');
		using widget = services.createInstance(
			ElementChatAttachmentWidget,
			{ ...attachment, kind: 'browserElement', resource },
			{ supportsDeletion: true, shouldFocusClearButton: true },
			container,
		);
		const buttons = widget.element.querySelectorAll<HTMLButtonElement>('button');
		assert.equal(buttons.length, 3);
		assert.equal(document.activeElement, buttons[2]);
		let opened = 0;
		let removed = 0;
		resources.add(
			widget.onDidOpen(() => {
				opened++;
			}),
		);
		resources.add(
			widget.onDidDelete(() => {
				removed++;
			}),
		);
		buttons[0]!.click();
		assert.equal(opened, 1);
		assert.deepEqual(calls, []);
		buttons[1]!.click();
		await new Promise<void>(resolve => setTimeout(resolve, 0));
		assert.deepEqual(calls, [[resource, { fromUserGesture: true, openExternal: true }]]);
		assert.equal(opened, 1);
		buttons[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
		assert.equal(removed, 1);
		using unsafe = services.createInstance(
			ElementChatAttachmentWidget,
			{ ...attachment, kind: 'browserElement', resource: URI.parse('command:untrusted') },
			{ supportsDeletion: false, shouldFocusClearButton: false },
			container,
		);
		assert.equal(unsafe.element.querySelectorAll('button').length, 1);
	});

	for (const change of [false, true])
		test(`SCM ${change ? 'file' : 'commit'} controls retain exact source identity and cancel retired navigation`, async () => {
			using resources = new DisposableStore();
			const pending = new DeferredPromise<void>();
			const calls: unknown[][] = [];
			const { services, container, errors } = specializedFixture(resources, {
				executeCommand: (...args: unknown[]) => {
					calls.push(args);
					return pending.p;
				},
			} as unknown as ICommandService);
			const resource = SCMHistoryItemUri.toUri({
				repositoryId: 'repo:original',
				revision: 'captured:commit',
				baseRevision: 'captured:parent',
				...(change ? { path: 'src/file.ts' } : {}),
			});
			const type = change ? SCMHistoryItemChangeAttachmentWidget : SCMHistoryItemAttachmentWidget;
			using widget = services.createInstance<IChatAttachmentWidgetInstance>(
				type,
				{ ...attachment, kind: change ? 'scmHistoryItemChange' : 'scmHistoryItem', resource },
				{ supportsDeletion: true, shouldFocusClearButton: true },
				container,
			);
			let opened = 0;
			resources.add(
				widget.onDidOpen(() => {
					opened++;
				}),
			);
			const buttons = widget.element.querySelectorAll<HTMLButtonElement>('button');
			assert.equal(document.activeElement, buttons[2]);
			buttons[0]!.click();
			buttons[1]!.click();
			buttons[1]!.click();
			await Promise.resolve();
			assert.equal(opened, 1);
			assert.equal(calls.length, 1);
			assert.deepEqual(calls[0]!.slice(0, 3), [
				change ? 'workbench.scm.action.graph.openFile' : 'workbench.scm.action.graph.viewChanges',
				resource,
				attachment.name,
			]);
			const token = calls[0]![3] as CancellationToken;
			assert.equal(token.isCancellationRequested, false);
			widget.dispose();
			assert.equal(token.isCancellationRequested, true);
			await pending.error(new Error('Removed source'));
			await new Promise<void>(resolve => setTimeout(resolve, 0));
			assert.deepEqual(errors, []);
			using legacy = services.createInstance<IChatAttachmentWidgetInstance>(
				type,
				{ ...attachment, resource: undefined },
				{ supportsDeletion: false, shouldFocusClearButton: false },
				container,
			);
			assert.equal(legacy.element.querySelectorAll('button').length, 1);
		});

	for (const kind of ['issue', 'symbol', 'searchResults'])
		test(`default ${kind} opens the captured source identity without rereading its snapshot`, async () => {
			using resources = new DisposableStore();
			const calls: unknown[] = [];
			const { services, container } = specializedFixture(resources, {
				executeCommand: async (...args: unknown[]) => {
					calls.push(args);
				},
			} as unknown as ICommandService);
			services.registerInstance(IOpenerService, {
				open: async (...args: unknown[]) => {
					calls.push(args);
					return true;
				},
			} as unknown as IOpenerService);
			const resource = URI.parse(
				kind === 'searchResults'
					? 'private://search-results'
					: kind === 'symbol'
						? 'file:///source.ts#2,1-4,1'
						: 'https://example.test/captured',
			);
			using widget = services.createInstance(
				DefaultChatAttachmentWidget,
				{ ...attachment, kind, resource },
				{ supportsDeletion: true, shouldFocusClearButton: false },
				container,
			);
			widget.element.querySelector('button')!.click();
			await new Promise<void>(resolve => setTimeout(resolve, 0));
			assert.deepEqual(calls, [
				kind === 'searchResults'
					? ['workbench.action.findInFiles']
					: [resource, { fromUserGesture: true, openExternal: kind !== 'symbol' }],
			]);
		});

	for (const type of [DefaultChatAttachmentWidget, PromptFileAttachmentWidget, ToolSetOrToolItemAttachmentWidget])
		test(`${type.name} owns removal, readonly options and retired navigation`, async () => {
			using resources = new DisposableStore();
			const pending = new DeferredPromise<boolean>();
			let requests = 0;
			const { services, container, errors } = specializedFixture(resources, {
				executeCommand: () => {
					requests++;
					return pending.p;
				},
			} as unknown as ICommandService);
			services.registerInstance(IOpenerService, {
				open: () => {
					requests++;
					return pending.p;
				},
			} as unknown as IOpenerService);
			using widget = services.createInstance<IChatAttachmentWidgetInstance>(
				type,
				attachment,
				{ supportsDeletion: true, shouldFocusClearButton: true },
				container,
			);
			const buttons = widget.element.querySelectorAll<HTMLButtonElement>('button');
			assert.equal(document.activeElement, buttons[1]);
			let removed = 0;
			resources.add(
				widget.onDidDelete(() => {
					removed++;
				}),
			);
			buttons[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
			buttons[1]!.click();
			buttons[0]!.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }));
			assert.equal(removed, 3);
			buttons[0]!.click();
			buttons[0]!.click();
			await Promise.resolve();
			assert.equal(requests, 1);
			widget.dispose();
			buttons[0]!.click();
			buttons[1]!.click();
			await pending.error(new Error('Retired source'));
			await new Promise<void>(resolve => setTimeout(resolve, 0));
			assert.equal(requests, 1);
			assert.equal(removed, 3);
			assert.deepEqual(errors, []);
			using readonly = services.createInstance<IChatAttachmentWidgetInstance>(
				type,
				attachment,
				{ supportsDeletion: false, shouldFocusClearButton: false },
				container,
			);
			assert.equal(readonly.element.querySelectorAll('button').length, 1);
		});

	test('directory, instruction and tool controls retain distinct source policies', async () => {
		using resources = new DisposableStore();
		const calls: unknown[] = [];
		const { services, container } = specializedFixture(resources, {
			executeCommand: async (...args: unknown[]) => {
				calls.push(args);
			},
		} as unknown as ICommandService);
		services.registerInstance(IOpenerService, {
			open: async (...args: unknown[]) => {
				calls.push(args);
				return true;
			},
		} as unknown as IOpenerService);
		const directory = URI.file('/workspace/src');
		const instruction = URI.parse('ash-remote://server/authorized/review.md');
		using folder = services.createInstance(
			FileAttachmentWidget,
			{ ...attachment, kind: 'directory', resource: directory },
			{ supportsDeletion: true, shouldFocusClearButton: false },
			container,
		);
		using prompt = services.createInstance(
			PromptFileAttachmentWidget,
			{ ...attachment, kind: 'instruction', resource: instruction },
			{ supportsDeletion: true, shouldFocusClearButton: false },
			container,
		);
		using tools = services.createInstance(
			ToolSetOrToolItemAttachmentWidget,
			{ ...attachment, kind: 'toolSelection', resource: undefined },
			{ supportsDeletion: true, shouldFocusClearButton: false },
			container,
		);
		for (const widget of [folder, prompt, tools]) widget.element.querySelector('button')!.click();
		await new Promise<void>(resolve => setTimeout(resolve, 0));
		assert.deepEqual(calls, [
			['revealInExplorer', directory],
			[instruction, { fromUserGesture: true, openExternal: false }],
			['workbench.action.openSettings', { section: 'tools' }],
		]);
	});

	test('source-less default controls emit an open intent and missing instruction sources remain removable', async () => {
		using resources = new DisposableStore();
		const { services, container } = specializedFixture(resources);
		services.registerInstance(IOpenerService, {
			open: async () => {
				assert.fail('No source URI is available');
			},
		} as unknown as IOpenerService);
		using widget = services.createInstance(
			DefaultChatAttachmentWidget,
			{ ...attachment, kind: 'debug', resource: undefined },
			{ supportsDeletion: true, shouldFocusClearButton: false },
			container,
		);
		let opened = 0;
		resources.add(
			widget.onDidOpen(() => {
				opened++;
			}),
		);
		widget.element.querySelector('button')!.click();
		await new Promise<void>(resolve => setTimeout(resolve, 0));
		assert.equal(opened, 1);
		using prompt = services.createInstance(
			PromptFileAttachmentWidget,
			{ ...attachment, kind: 'instruction', resource: undefined },
			{ supportsDeletion: true, shouldFocusClearButton: false },
			container,
		);
		assert.equal(prompt.element.querySelector('button')!.disabled, true);
		assert.equal(prompt.element.querySelectorAll('button')[1]!.disabled, false);
	});

	test('other attachment widgets fail creation when their required source service is absent', () => {
		using services = new InstantiationService();
		for (const type of [
			DefaultChatAttachmentWidget,
			PromptFileAttachmentWidget,
			ToolSetOrToolItemAttachmentWidget,
		]) {
			assert.throws(
				() =>
					services.createInstance<IChatAttachmentWidgetInstance>(
						type,
						attachment,
						{ supportsDeletion: true, shouldFocusClearButton: false },
						document.createElement('div'),
					),
				/Unknown service: (?:openerService|commandService)/u,
			);
		}
	});

	test('replacement registration has its own lifetime and created widgets belong to their caller', () => {
		using resources = new DisposableStore();
		const { container } = fixture(resources);
		using registry = new ChatAttachmentWidgetRegistry();
		let releases = 0;
		const factory: ChatAttachmentWidgetFactory = () => ({
			...toDisposable(() => {
				releases++;
			}),
			element: container,
			onDidDelete: Event.None,
			onDidOpen: Event.None,
		});
		using old = registry.registerFactory('sessionReference', factory);
		using current = registry.registerFactory('sessionReference', factory);
		old.dispose();
		const options = { supportsDeletion: false, shouldFocusClearButton: false };
		const widget = registry.createWidget(attachment, options, container)!;
		assert.ok(widget);
		assert.equal(registry.createWidget({ ...attachment, kind: 'file' }, options, container), undefined);
		current.dispose();
		assert.equal(registry.createWidget(attachment, options, container), undefined);
		assert.equal(releases, 0);
		widget.dispose();
		assert.equal(releases, 1);
	});

	test('the real contribution opens the referenced source once without resolving or deleting its snapshot', async () => {
		using resources = new DisposableStore();
		const opened: string[][] = [];
		const { services, container } = fixture(resources, async (session, thread) => {
			opened.push([session, thread]);
		});
		using contribution = services.createInstance(ChatReferenceAttachmentWidgetContribution);
		using widget = services
			.get(IChatAttachmentWidgetRegistry)
			.createWidget(attachment, { supportsDeletion: true, shouldFocusClearButton: false }, container)!;
		let events = 0;
		resources.add(
			widget.onDidOpen(() => {
				events++;
			}),
		);
		widget.element.querySelector<HTMLButtonElement>('button')!.click();
		await Promise.resolve();
		assert.deepEqual(opened, [['source-session', 'source-thread']]);
		assert.equal(events, 1);
		assert.equal(widget.element.querySelectorAll('button').length, 2);
	});

	test('deletion options control native removal, keyboard deletion, middle click and initial focus', () => {
		using resources = new DisposableStore();
		const { services, container } = fixture(resources);
		using widget = services.createInstance(
			ChatReferenceAttachmentWidget,
			attachment,
			{ supportsDeletion: true, shouldFocusClearButton: true },
			container,
		);
		const buttons = widget.element.querySelectorAll<HTMLButtonElement>('button');
		assert.equal(document.activeElement, buttons[1]);
		let deletions = 0;
		resources.add(
			widget.onDidDelete(() => {
				deletions++;
			}),
		);
		buttons[1]!.click();
		buttons[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
		buttons[0]!.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }));
		assert.equal(deletions, 3);
		using readonly = services.createInstance(
			ChatReferenceAttachmentWidget,
			attachment,
			{ supportsDeletion: false, shouldFocusClearButton: true },
			container,
		);
		resources.add(
			readonly.onDidDelete(() => {
				deletions++;
			}),
		);
		readonly.element.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }),
		);
		readonly.element.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }));
		assert.equal(readonly.element.querySelectorAll('button').length, 1);
		assert.equal(deletions, 3);
	});

	test('retired controls cannot open, delete or report a late navigation failure', async () => {
		using resources = new DisposableStore();
		const pending = new DeferredPromise<void>();
		let requests = 0;
		const { services, container, errors } = fixture(resources, () => {
			requests++;
			return pending.p;
		});
		using widget = services.createInstance(
			ChatReferenceAttachmentWidget,
			attachment,
			{ supportsDeletion: true, shouldFocusClearButton: false },
			container,
		);
		const buttons = [...widget.element.querySelectorAll<HTMLButtonElement>('button')];
		let opened = 0;
		let deleted = 0;
		resources.add(
			widget.onDidOpen(() => {
				opened++;
			}),
		);
		resources.add(
			widget.onDidDelete(() => {
				deleted++;
			}),
		);
		buttons[0]!.click();
		buttons[0]!.click();
		assert.equal(requests, 1);
		widget.dispose();
		buttons[0]!.click();
		buttons[1]!.click();
		await pending.error(new Error('Retired source'));
		await Promise.resolve();
		assert.deepEqual(
			{ requests, opened, deleted, errors, children: container.childElementCount },
			{ requests: 1, opened: 0, deleted: 0, errors: [], children: 0 },
		);
	});

	test('missing source identities never reach the generic opener or submit', () => {
		using resources = new DisposableStore();
		const { services, container } = fixture(resources, async () => {
			assert.fail('Invalid source opened');
		});
		using widget = services.createInstance(
			ChatReferenceAttachmentWidget,
			{ ...attachment, resource: URI.parse('https://example.test/foreign') },
			{ supportsDeletion: false, shouldFocusClearButton: false },
			container,
		);
		assert.equal(widget.element.querySelector('button')!.disabled, true);
		let keys = 0;
		resources.add(
			addDisposableListener(container, 'keydown', () => {
				keys++;
			}),
		);
		widget.element
			.querySelector('button')!
			.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		widget.element.click();
		assert.equal(keys, 0);
	});

	test('the production factory requires the host navigation service when creating a widget', () => {
		using services = new InstantiationService();
		services.registerSingleton(IChatAttachmentWidgetRegistry, () => new ChatAttachmentWidgetRegistry());
		using contribution = services.createInstance(ChatReferenceAttachmentWidgetContribution);
		assert.throws(
			() =>
				services
					.get(IChatAttachmentWidgetRegistry)
					.createWidget(
						attachment,
						{ supportsDeletion: false, shouldFocusClearButton: false },
						document.createElement('div'),
					),
			/Unknown service: chatSessionNavigationService/u,
		);
	});
});
