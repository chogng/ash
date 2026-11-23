import './media/chatHostPart.css';
import type { IDimension } from '../../../../base/browser/dom.js';
import { LayoutPriority } from '../../../../base/browser/ui/splitview/splitview.js';
import { MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { Part } from '../../part.js';

/** Owns the Chat grid cell. The caller retains ownership of the mounted content. */
export class ChatHostPart extends Part {
	static readonly MINIMUM_WIDTH = 280;

	private readonly mount = this._register(new MutableDisposable<IDisposable>());
	private content: Part | undefined;
	private focus: (() => void) | undefined;
	private dimension: IDimension | undefined;
	fillsEditorArea = false;

	constructor(
		container: HTMLElement,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super(container, 'chat', themeService, storageService);
		this.domNode.setAttribute('role', 'none');
		this.setVisible(false);
	}

	get priority(): LayoutPriority {
		return this.fillsEditorArea ? LayoutPriority.High : LayoutPriority.Low;
	}

	override get minimumWidth(): number {
		return Math.max(ChatHostPart.MINIMUM_WIDTH, this.content?.minimumWidth ?? 0);
	}

	override get preferredWidth(): number | undefined {
		return this.content?.preferredWidth;
	}

	/** Borrows content until it is replaced or this host is disposed. */
	setContent(content: Part, focus: () => void): void {
		this.assertNotDisposed();
		this.mount.clear();
		this.content = content;
		this.focus = focus;
		this.contentDomNode.append(content.domNode);
		const listener = content.onDidChangeConstraints(() => this.notifyConstraintsChanged());
		this.mount.value = toDisposable(() => {
			listener.dispose();
			this.content = undefined;
			this.focus = undefined;
			content.setVisible(false);
			content.domNode.remove();
			this.notifyConstraintsChanged();
		});
		content.setVisible(!this.domNode.hidden);
		if (this.dimension) content.layout(this.dimension);
		this.notifyConstraintsChanged();
	}

	focusContent(): void {
		if (!this.domNode.hidden) this.focus?.();
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.content?.setVisible(visible);
	}

	override layout(dimension: IDimension): void {
		this.dimension = dimension;
		this.content?.layout(dimension);
	}
}
