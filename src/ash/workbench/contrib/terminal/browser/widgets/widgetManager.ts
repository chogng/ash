import { Disposable, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import type { ITerminalWidget } from './widgets.js';
import '../media/widgets.css';

/** Retained alongside one screen, including when that screen moves between hosts. */
export class TerminalWidgetManager extends Disposable {
	private container: HTMLElement | undefined;
	private readonly widgets = new Map<string, ITerminalWidget>();

	attachToElement(terminalWrapper: HTMLElement): void {
		this.assertNotDisposed();
		if (this.container) {
			terminalWrapper.append(this.container);
			return;
		}
		this.container = terminalWrapper.ownerDocument.createElement('div');
		this.container.className = 'ash-terminal-widget-overlay';
		terminalWrapper.append(this.container);
	}

	attachWidget(widget: ITerminalWidget): IDisposable | undefined {
		if (this.isDisposed || !this.container) {
			widget.dispose();
			return undefined;
		}
		const previous = this.widgets.get(widget.id);
		if (previous === widget) return undefined;
		this.widgets.delete(widget.id);
		previous?.dispose();
		this.widgets.set(widget.id, widget);
		try {
			widget.attach(this.container);
		} catch (error) {
			this.widgets.delete(widget.id);
			widget.dispose();
			throw error;
		}
		return toDisposable(() => {
			if (this.widgets.get(widget.id) !== widget) return;
			this.widgets.delete(widget.id);
			widget.dispose();
		});
	}

	protected override disposeCore(): void {
		const widgets = [...this.widgets.values()];
		this.widgets.clear();
		for (const widget of widgets) widget.dispose();
		this.container?.remove();
		this.container = undefined;
		super.disposeCore();
	}
}
