import type { ChatContextAttachment } from '../../../../services/chat/common/chatContextService.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { IChatContextPickService, picksWithPromiseFn } from '../../../chat/browser/attachments/chatContextPickService.js';
import { Disposable, DisposableStore, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../../base/common/event.js';
import { encodeBase64 } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';

import type { IBrowserViewModel } from '../../common/browserView.js';
import { BrowserEditor, BrowserEditorContribution } from '../browserEditor.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import type { IElementData } from '../../../../../platform/browserView/common/browserView.js';

const selections = new WeakMap<IBrowserViewModel, BrowserPageSelections>();

/** Split editors borrow one attachment source for the lifetime of their shared page model. */
export class BrowserEditorChatIntegration extends BrowserEditorContribution {
	private current: BrowserPageSelections | undefined;

	constructor(
		editor: BrowserEditor,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super(editor);
	}

	protected override onModelAttached(model: IBrowserViewModel, store: DisposableStore): void {
		let source = selections.get(model);
		if (!source) {
			source = this.instantiation.createInstance(BrowserPageSelections, model);
			selections.set(model, source);
		}
		this.current = source;
		store.add(
			source.attach(message => {
				if (this.editor.model === model && !this.isDisposed) {
					this.editor.setStatus(message);
				}
			}),
		);
	}
	override onModelDetached(): void {
		this.current = undefined;
	}
	override onContainerCreated(): void {
		this._register(
			AccessibleViewRegistry.register({
				type: AccessibleViewType.View,
				priority: 100,
				name: 'browserSelections:' + crypto.randomUUID(),
				when: ActiveEditorContext.isEqualTo(BrowserViewEditorId),
				getProvider: () => {
					const content = this.getAccessibleContent();
					if (!this.editor.isVisible() || !this.editor.model || !content) {
						return undefined;
					}
					return new AccessibleContentProvider(
						AccessibleViewProviderId.Browser,
						{ type: AccessibleViewType.View },
						() => content,
						() => this.editor.ensureBrowserFocus(),
						AccessibilityVerbositySettingId.Browser,
					);
				},
			}),
		);
	}

	public addConsoleLogsToChat(): Promise<void> {
		return this.current?.captureConsole() ?? Promise.resolve();
	}
	public addScreenshotToChat(fullPage: boolean): Promise<void> {
		return this.current?.capturePage(fullPage) ?? Promise.resolve();
	}
	public getAccessibleContent(): string {
		return this.current?.getAccessibleContent() ?? '';
	}
}

/** Main owns the page; this model-scoped source owns immutable user-selected context snapshots. */
interface CapturedBrowserContext {
	readonly label: string;
	readonly description?: string;
	readonly attachment: ChatContextAttachment;
}

class BrowserPageSelections extends Disposable {
	private readonly snapshots = new Map<string, CapturedBrowserContext>();
	private readonly comments = new Map<string, string>();
	private readonly status = this._register(new Emitter<string>());
	private epoch = 0;
	private areaSequence = 0;
	private leases = 0;

	constructor(
		public readonly model: IBrowserViewModel,
		@IChatContextPickService contexts: IChatContextPickService,
	) {
		super();
		const label = localize({ bundle: 'ash.workbench', key: 'browser.selectionContext' }, 'Browser selections');
		this._register(
			contexts.registerChatContextItem({
				type: 'pickerPick',
				label,
				icon: Lxicon.code,
				isEnabled: () => this.snapshots.size > 0,
				asPicker: () => ({
					placeholder: localize('chat.context.select', 'Select {0}', label),
					picks: picksWithPromiseFn(async query =>
						[...this.snapshots.values()]
							.filter(item => (item.label + ' ' + item.description).toLowerCase().includes(query.toLowerCase()))
							.map(item => ({
								label: item.label,
								description: item.description,
								asAttachment: () => item.attachment,
							})),
					),
				}),
			}),
		);
		this._register(model.onWillDispose(() => this.dispose()));
		this._register(model.onDidClose(() => this.dispose()));
		this._register(
			model.onDidEvent(event => {
				if (event.type === 'elementPicked') {
					this.acceptElement(event.data);
					this.status.fire(
						localize({ bundle: 'ash.workbench', key: 'browser.selectionCaptured' }, 'Selection captured. Choose Browser selections from Chat’s Add Context menu to attach it.'),
					);
				} else if (event.type === 'elementCommentRemoved') {
					this.comments.delete(event.elementId);
					this.snapshots.delete(event.elementId);
					void this.publishComments().catch(error => this.status.fire(String(error)));
				} else if (event.type === 'areaPicked') {
					const epoch = this.epoch;
					void model
						.captureScreenshot({ format: 'png', screenRect: event.rect, awaitNextPaint: true })
						.then(image => {
							if (epoch !== this.epoch || this.isDisposed) {
								return;
							}
							const id = 'area:' + ++this.areaSequence;
							const name = localize({ bundle: 'ash.workbench', key: 'browser.areaScreenshot' }, 'Browser area {0}', this.areaSequence);
							const content = 'data:image/png;base64,' + encodeBase64(image);
							this.addSnapshot(id, {
								label: name,
								description: model.state.url,
								attachment: {
									id: model.id + ':' + id,
									name,
									kind: 'image',
									resource: URI.parse(model.state.url),
									resolve: async () => ({ name, kind: 'image', content }),
								},
							});
							this.status.fire(
								localize({ bundle: 'ash.workbench', key: 'browser.areaCaptured' }, 'Area captured. Choose Other context sources in Chat’s Add context menu to attach the screenshot.'),
							);
						})
						.catch(error => {
							if (epoch === this.epoch && !this.isDisposed) {
								this.status.fire(String(error));
							}
						});
				} else if (event.type === 'stateChanged' && event.state.loading) {
					this.epoch++;
					this.snapshots.clear();
					this.comments.clear();
				}
			}),
		);
	}

	public attach(changed: (message: string) => void): IDisposable {
		this.leases++;
		const listener = this.status.event(changed);
		return toDisposable(() => {
			listener.dispose();
			if (--this.leases === 0 && !this.isDisposed) {
				this.stopSelection();
			}
		});
	}

	private stopSelection(): void {
		void this.model.toggleElementSelection(false).catch(() => {});
		void this.model.toggleAreaSelection(false).catch(() => {});
	}

	private acceptElement(element: IElementData): void {
		if (!element.elementId) {
			return;
		}
		const name = element.comment || element.innerText?.slice(0, 80) || localize({ bundle: 'ash.workbench', key: 'browser.selectedElement' }, 'Selected browser element');
		const url = element.url ?? this.model.state.url;
		const content = [url, element.comment ?? '', element.outerHTML, element.computedStyle].filter(Boolean).join('\n\n');
		this.addSnapshot(element.elementId, {
			label: name,
			description: url,
			attachment: {
				id: this.model.id + ':' + element.elementId,
				name,
				kind: 'browserElement',
				resource: URI.parse(url),
				resolve: async () => ({ name, content }),
			},
		});
		if (element.comment) {
			this.comments.set(element.elementId, element.comment);
			void this.publishComments().catch(error => this.status.fire(String(error)));
		}
	}

	public async captureConsole(): Promise<void> {
		const epoch = this.epoch;
		const url = this.model.state.url;
		const content = await this.model.getConsoleLogs();
		if (epoch !== this.epoch || this.isDisposed || !content) {
			return;
		}
		const name = localize({ bundle: 'ash.workbench', key: 'browser.consoleContext' }, 'Browser console logs');
		this.addSnapshot('console', {
			label: name,
			description: url,
			attachment: {
				id: this.model.id + ':console',
				name,
				kind: 'text',
				resource: URI.parse(url),
				resolve: async () => ({ name, content }),
			},
		});
		this.status.fire(localize({ bundle: 'ash.workbench', key: 'browser.consoleCaptured' }, 'Console logs captured. Choose Browser selections in Chat to attach them.'));
	}
	public async capturePage(fullPage: boolean): Promise<void> {
		const epoch = this.epoch;
		const url = this.model.state.url;
		const image = await this.model.captureScreenshot({ format: 'png', fullPage, awaitNextPaint: true });
		if (epoch !== this.epoch || this.isDisposed) {
			return;
		}
		const name = fullPage
			? localize({ bundle: 'ash.workbench', key: 'browser.fullPageContext' }, 'Full browser page screenshot')
			: localize({ bundle: 'ash.workbench', key: 'browser.pageContext' }, 'Browser page screenshot');
		const content = 'data:image/png;base64,' + encodeBase64(image);
		this.addSnapshot(fullPage ? 'full-page' : 'page', {
			label: name,
			description: url,
			attachment: {
				id: this.model.id + (fullPage ? ':full-page' : ':page'),
				name,
				kind: 'image',
				resource: URI.parse(url),
				resolve: async () => ({ name, kind: 'image', content }),
			},
		});
		this.status.fire(localize({ bundle: 'ash.workbench', key: 'browser.pageCaptured' }, 'Screenshot captured. Choose Browser selections in Chat to attach it.'));
	}
	private addSnapshot(id: string, pick: CapturedBrowserContext): void {
		if (!this.snapshots.has(id) && this.snapshots.size >= 50) {
			const retired = this.snapshots.keys().next().value!;
			this.snapshots.delete(retired);
			this.comments.delete(retired);
		}
		this.snapshots.set(id, pick);
	}

	private publishComments(): Promise<void> {
		return this.model.setElementComments({
			comments: [...this.comments].map(([elementId, body]) => ({ elementId, body })),
		});
	}
	public getAccessibleContent(): string {
		return [...this.snapshots.values()].map(item => item.label + '\n' + item.description).join('\n\n');
	}
	protected override disposeCore(): void {
		this.epoch++;
		this.stopSelection();
		void this.model.setElementComments({ comments: [] }).catch(() => {});
		this.snapshots.clear();
		this.comments.clear();
		selections.delete(this.model);
		super.disposeCore();
	}
}

import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { BrowserViewCommandId } from '../../../../../platform/browserView/common/browserView.js';
import { IEditorPart } from '../../../../browser/parts/editor/editorPart.js';
import { BrowserViewEditorId } from '../../common/browserView.js';
import { ActiveEditorContext } from '../../../../common/contextkeys.js';
import { localize2 } from '../../../../../nls.js';
for (const command of [
	{
		id: BrowserViewCommandId.AddConsoleLogsToChat,
		title: localize2({ bundle: 'ash.workbench', key: 'browser.consoleCommand' }, 'Browser: Capture Console Logs for Chat'),
		run: (pane: BrowserEditor) => pane.getContribution(BrowserEditorChatIntegration)?.addConsoleLogsToChat(),
	},
	{
		id: BrowserViewCommandId.AddScreenshotToChat,
		title: localize2({ bundle: 'ash.workbench', key: 'browser.pageCommand' }, 'Browser: Capture Screenshot for Chat'),
		run: (pane: BrowserEditor) => pane.getContribution(BrowserEditorChatIntegration)?.addScreenshotToChat(false),
	},
	{
		id: BrowserViewCommandId.AddFullPageScreenshotToChat,
		title: localize2({ bundle: 'ash.workbench', key: 'browser.fullPageCommand' }, 'Browser: Capture Full Page Screenshot for Chat'),
		run: (pane: BrowserEditor) => pane.getContribution(BrowserEditorChatIntegration)?.addScreenshotToChat(true),
	},
]) {
	registerAction2(
		class BrowserCaptureAction extends Action2 {
			constructor() {
				super({
					id: command.id,
					title: command.title,
					f1: true,
					precondition: ActiveEditorContext.isEqualTo(BrowserViewEditorId),
				});
			}
			override async run(accessor: import('../../../../../platform/instantiation/common/instantiation.js').ServicesAccessor): Promise<void> {
				const pane = accessor.get(IEditorPart).activePane;
				if (pane?.id === BrowserViewEditorId) {
					await command.run(pane as BrowserEditor);
				}
			}
		},
	);
}
