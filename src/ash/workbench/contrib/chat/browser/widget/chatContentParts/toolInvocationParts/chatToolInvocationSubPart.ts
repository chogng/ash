import { Emitter } from '../../../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../../../base/common/lifecycle.js';

/** Shared mount and height lifetime for the subparts owned by one tool invocation. */
export abstract class BaseChatToolInvocationSubPart<T extends HTMLElement = HTMLElement> extends Disposable {
	protected readonly changedHeight = this._register(new Emitter<void>());
	public readonly onDidChangeHeight = this.changedHeight.event;

	/** Hosts may mount this stable root; disposing the part removes its owned DOM. */
	constructor(public readonly domNode: T) {
		super();
		this._register(toDisposable(() => domNode.remove()));
	}
}
