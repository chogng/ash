import { AccessibilityVerbositySettingId } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { h } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { getKeybindingLabel } from '../../../../../base/common/keybindingLabels.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { extUri } from '../../../../../base/common/resources.js';
import type { Event } from '../../../../../base/common/event.js';
import type { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IAppWindowScreenshotService } from '../../../screenshotTool/electron-browser/appWindowScreenshot.js';
import { IChatUserImageAttachmentService } from '../../browser/attachments/chatUserImageAttachments.js';
import { ChatInputNoticeHost, ChatInputNoticeLane } from '../../browser/widget/input/chatInputNoticeHost.js';
import { ChatInputNoticeWidget, ChatInputNoticeVariant } from '../../browser/widget/input/chatInputNoticeWidget.js';
import { ChatInputStackSlot, setChatInputStackSlot } from '../../browser/widget/input/chatInputStack.js';
import { ChatConfiguration } from '../../common/constants.js';
import '../media/chatAppWindowScreenshotHint.css';

export interface IAppWindowScreenshotHintTarget {
	readonly inputUri: URI;
	readonly noticeHost: ChatInputNoticeHost;
	readonly container: HTMLElement;
	getAttachmentIds(): readonly string[];
	readonly onDidChangeAttachments: Event<unknown>;
	readonly onDidChangeDraft: Event<unknown>;
	canAttachScreenshots(): boolean;
	focusInput?(): void;
}
export interface IAppWindowScreenshotHintCommand {
	readonly id: string;
	readonly title: string;
	run(): void;
}

const hintKey = 'chat.appWindowScreenshots.hintShown';

/** A gesture borrows the tip lane; the shared storage writer grants its one visible showing. */
export class AppWindowScreenshotHint extends Disposable {
	private readonly claim = this._register(new MutableDisposable());
	private readonly content = this._register(new DisposableStore());
	private readonly token = generateUuid();
	private images: readonly string[] = [];
	private leading = false;
	private shown = false;
	private acquiring = false;
	private generation = 0;
	private notice: ChatInputNoticeWidget | undefined;

	constructor(
		private readonly target: IAppWindowScreenshotHintTarget,
		private readonly command: IAppWindowScreenshotHintCommand,
		@IChatUserImageAttachmentService images: IChatUserImageAttachmentService,
		@IAppWindowScreenshotService private readonly screenshots: IAppWindowScreenshotService,
		@IStorageService private readonly storage: IStorageService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IKeybindingService private readonly keybindings: IKeybindingService,
		@ILogService private readonly log: ILogService,
	) {
		super();
		this._register(images.onDidAttachImages(event => {
			if (!extUri.isEqual(event.inputUri, target.inputUri) || !this.eligible() || this.storage.get(hintKey, StorageScope.APPLICATION)) { return; }
			this.images = event.attachmentIds;
			if (!this.hasImages()) { return; }
			this.claim.value = target.noticeHost.occupy(ChatInputNoticeLane.Tip, {
				focusTarget: { hasFocus: () => this.notice?.hasFocus() ?? false, focus: () => this.notice?.focus() },
				onDidChangeLeading: leading => {
					this.leading = leading;
					this.updateVisibility();
					if (leading) { void this.showOnce(); }
				},
			});
		}));
		this._register(target.onDidChangeAttachments(() => { if (!this.hasImages() || !target.canAttachScreenshots()) { this.clear(); } }));
		this._register(target.onDidChangeDraft(() => this.clear()));
		this._register(screenshots.onDidChangeHasCaptured(() => { if (screenshots.hasCaptured) { this.clear(); } }));
		this._register(configuration.onDidChangeConfiguration(() => { if (!this.eligible()) { this.clear(); } }));
		this._register(storage.onDidChangeValue(event => {
			if (event.scope === StorageScope.APPLICATION && event.key === hintKey) {
				const owner = storage.get(hintKey, StorageScope.APPLICATION);
				if (owner && owner !== this.token) { this.clear(); }
			}
		}));
	}

	private eligible(): boolean {
		return !this.isDisposed && this.configuration.getValue<boolean>(ChatConfiguration.AppWindowScreenshotsEnabled) === true
			&& this.configuration.getValue<boolean>(ChatConfiguration.TipsEnabled) !== false
			&& this.target.canAttachScreenshots() && !this.screenshots.hasCaptured;
	}
	private hasImages(): boolean {
		const current = new Set(this.target.getAttachmentIds());
		return this.images.some(id => current.has(id));
	}
	private async showOnce(): Promise<void> {
		const compare = this.storage.compareAndSwapApplicationSharedValue;
		if (!compare || this.acquiring || this.shown || !this.leading || !this.eligible() || !this.hasImages()) { return; }
		const generation = this.generation;
		this.acquiring = true;
		try {
			if (!await compare.call(this.storage, hintKey, undefined, this.token)) { this.clear(); return; }
			if (generation !== this.generation || !this.leading || !this.eligible() || !this.hasImages()) {
				await compare.call(this.storage, hintKey, this.token, undefined);
				return;
			}
			this.shown = true;
			this.notice = this.content.add(new ChatInputNoticeWidget({
				container: this.target.container, focusInput: this.target.focusInput, variant: ChatInputNoticeVariant.Tip,
				className: 'ash-app-window-screenshot-hint',
				accessibility: {
					priority: 110, verbositySettingKey: AccessibilityVerbositySettingId.Chat,
					getHelp: () => localize('appWindowScreenshotHint.help', 'Use Tab to reach Capture app window or Dismiss. Enter activates the focused action. Escape dismisses this tip and returns to the message.'),
				},
				onEscape: () => this.clear(),
			}));
			const document = this.notice.domNode.ownerDocument;
			const label = h(document, 'span');
			const binding = this.keybindings.lookupKeybinding(this.command.id);
			label.textContent = binding
				? localize('appWindowScreenshotHint.shortcut', 'Capture an app window with {0}.', getKeybindingLabel(binding))
				: localize('appWindowScreenshotHint.palette', 'App windows can be captured from the Command Palette.');
			this.notice.domNode.append(label);
			const capture = this.content.add(new Button(this.notice.domNode, { ...defaultButtonStyles, label: this.command.title, presentation: 'secondary', size: 'small' }));
			this.content.add(capture.onDidClick(() => { this.clear(); this.command.run(); }));
			const dismiss = this.content.add(new Button(this.notice.domNode, { ...defaultButtonStyles, label: localize('appWindowScreenshotHint.dismiss', 'Dismiss'), presentation: 'secondary', size: 'small' }));
			this.content.add(dismiss.onDidClick(() => this.clear()));
			this.notice.setAriaLabel(label.textContent);
			this.updateVisibility();
			this.notice.announce();
		} catch (error) {
			this.log.error('appWindowScreenshotHint', 'Could not claim the screenshot hint', error);
			this.clear();
		} finally {
			this.acquiring = false;
			if (!this.shown && this.leading && this.eligible() && this.hasImages() && !this.storage.get(hintKey, StorageScope.APPLICATION)) {
				void this.showOnce();
			}
		}
	}
	private updateVisibility(): void {
		const visible = this.leading && !!this.notice;
		this.notice?.setVisible(visible);
		setChatInputStackSlot(this.target.container, visible ? ChatInputStackSlot.Standalone : ChatInputStackSlot.Empty);
	}
	private clear(): void {
		this.generation++;
		this.images = [];
		this.claim.clear();
		this.content.clear();
		this.notice = undefined;
		this.updateVisibility();
	}
	protected override disposeCore(): void {
		this.clear();
		super.disposeCore();
	}
}
