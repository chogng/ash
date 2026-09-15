import { h, addDisposableListener } from '../../../../base/browser/dom.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ServiceConstructionDescriptor, type IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ContentWidgetPositionPreference, type ICodeEditor, type IContentWidget, type IContentWidgetPosition } from '../../../browser/editorBrowser.js';
import type { IPosition } from '../../../common/core/position.js';
import './inlineProgressWidget.css';

interface InlineProgressDelegate {
	cancel(): void;
}

class InlineProgressWidget extends Disposable implements IContentWidget {
	private readonly domNode: HTMLButtonElement;

	constructor(
		private readonly typeId: string,
		private readonly editor: ICodeEditor,
		private readonly position: IPosition,
		title: string,
		delegate: InlineProgressDelegate,
	) {
		super();
		const document = editor.getContainerDomNode().ownerDocument;
		this.domNode = h(document, 'button');
		this.domNode.className = 'inline-progress-widget';
		this.domNode.type = 'button';
		this.domNode.title = title;
		this.domNode.setAttribute('aria-label', title);
		const icon = h(document, 'span');
		icon.className = 'icon';
		this.domNode.append(icon);
		this._register(addDisposableListener(this.domNode, 'click', () => delegate.cancel()));
		editor.addContentWidget(this);
		this._register(toDisposable(() => editor.removeContentWidget(this)));
		editor.layoutContentWidget(this);
	}

	public getId(): string {
		return `editor.widget.inlineProgressWidget.${this.typeId}`;
	}

	public getDomNode(): HTMLElement {
		return this.domNode;
	}

	public getPosition(): IContentWidgetPosition {
		return { position: this.position, preference: [ContentWidgetPositionPreference.EXACT] };
	}
}

const inlineProgressWidget = new ServiceConstructionDescriptor(InlineProgressWidget);

/** Owns one delayed, cancellable progress indicator attached to an editor position. */
export class InlineProgressManager extends Disposable {
	private readonly pending = this._register(new MutableDisposable());
	private readonly widget = this._register(new MutableDisposable<InlineProgressWidget>());
	private operation = 0;

	constructor(
		private readonly id: string,
		private readonly editor: ICodeEditor,
		private readonly instantiationService: IInstantiationService,
	) {
		super();
	}

	public async showWhile<R>(position: IPosition, title: string, promise: Promise<R>, delegate: InlineProgressDelegate, delayOverride = 500): Promise<R> {
		const operation = ++this.operation;
		this.clear();
		this.pending.value = disposableTimeout(() => {
			this.widget.value = this.instantiationService.createInstance(inlineProgressWidget, this.id, this.editor, position, title, delegate);
		}, Math.max(0, delayOverride));
		try {
			return await promise;
		} finally {
			if (this.operation === operation) this.clear();
		}
	}

	private clear(): void {
		this.pending.clear();
		this.widget.clear();
	}
}
