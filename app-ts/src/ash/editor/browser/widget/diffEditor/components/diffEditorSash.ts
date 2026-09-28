import '../../../../../base/browser/ui/sash/sash.css';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Sash, SashState } from '../../../../../base/browser/ui/sash/sash.js';
import { localize, onDidChangeNls } from '../../../../../nls.js';
import { type DiffEditorOptions } from '../diffEditorOptions.js';

const MINIMUM_EDITOR_WIDTH = 100;

/** Owns the side-by-side split ratio and its keyboard and pointer separator. */
export class DiffEditorSash extends Disposable {
	public readonly element: HTMLDivElement;
	private readonly sash: Sash;
	private ratio: number | undefined;
	private width = 0;
	private startLeft = 0;

	constructor(
		container: HTMLElement,
		private readonly options: DiffEditorOptions,
		originalId: string,
		modifiedId: string,
		private readonly onDidResize: () => void,
	) {
		super();
		this.sash = this._register(new Sash(container, 'vertical'));
		this.element = this.sash.element;
		this.element.classList.add('stanza-diff-sash');
		this.element.setAttribute('aria-controls', `${originalId} ${modifiedId}`);
		this.updateLabel();
		this._register(onDidChangeNls(() => {
			this.updateLabel();
			this.updateValue(this.left);
		}));
		this._register(this.sash.onDidStart(() => { this.startLeft = this.left; }));
		this._register(this.sash.onDidChange(event => {
			if (this.width <= MINIMUM_EDITOR_WIDTH * 2) return;
			const left = Math.max(MINIMUM_EDITOR_WIDTH, Math.min(this.width - MINIMUM_EDITOR_WIDTH, this.startLeft + event.delta));
			this.ratio = left / this.width;
			this.onDidResize();
		}));
		this._register(this.sash.onDidReset(() => {
			this.ratio = undefined;
			this.onDidResize();
		}));
	}

	public get left(): number {
		const ratio = this.options.enableSplitViewResizing
			? this.ratio ?? this.options.splitViewDefaultRatio
			: this.options.splitViewDefaultRatio;
		const desired = Math.round(ratio * this.width);
		if (this.width <= MINIMUM_EDITOR_WIDTH * 2) return desired;
		return Math.max(MINIMUM_EDITOR_WIDTH, Math.min(this.width - MINIMUM_EDITOR_WIDTH, desired));
	}

	public layout(width: number, height: number, inlineView: boolean): number {
		this.width = width;
		const left = this.left;
		const visible = !inlineView && this.options.enableSplitViewResizing && width > MINIMUM_EDITOR_WIDTH * 2;
		this.element.hidden = !visible;
		this.element.style.left = `${left}px`;
		this.element.style.top = '0';
		this.element.style.height = `${height}px`;
		this.sash.state = !visible ? SashState.Disabled
			: left <= MINIMUM_EDITOR_WIDTH ? SashState.AtMinimum
				: left >= width - MINIMUM_EDITOR_WIDTH ? SashState.AtMaximum : SashState.Enabled;
		this.updateValue(left);
		return left;
	}

	private updateLabel(): void {
		this.element.setAttribute('aria-label', localize('diffEditor.resizeColumns', 'Resize diff editor columns'));
		this.element.setAttribute('aria-description', localize('diffEditor.resizeColumnsDescription', 'Use Left and Right Arrow keys to resize, Alt for one-pixel steps, or double-click to reset.'));
	}

	private updateValue(left: number): void {
		const percent = this.width > 0 ? Math.round(left / this.width * 100) : Math.round(this.options.splitViewDefaultRatio * 100);
		const minimumPercent = this.width > MINIMUM_EDITOR_WIDTH * 2
			? Math.round(MINIMUM_EDITOR_WIDTH / this.width * 100) : 0;
		this.element.setAttribute('aria-valuemin', String(minimumPercent));
		this.element.setAttribute('aria-valuemax', String(100 - minimumPercent));
		this.element.setAttribute('aria-valuenow', String(percent));
		this.element.setAttribute('aria-valuetext', localize('diffEditor.columnWidths', 'Original {0}%, modified {1}%', percent, 100 - percent));
	}
}
