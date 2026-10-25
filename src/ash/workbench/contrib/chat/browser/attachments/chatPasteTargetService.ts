import { AbstractDisposable, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { extUri } from '../../../../../base/common/resources.js';
import type { URI } from '../../../../../base/common/uri.js';
import type { IChatPasteTarget, IChatPasteTargetService } from '../chat.js';

/** Window-local routing only; targets and their draft models belong to their composers. */
export class ChatPasteTargetService extends AbstractDisposable implements IChatPasteTargetService {
	private readonly targets = new Map<string, IChatPasteTarget>();

	public registerTarget(inputUri: URI, target: IChatPasteTarget): IDisposable {
		this.assertNotDisposed();
		const key = extUri.getComparisonKey(inputUri);
		this.targets.set(key, target);
		return toDisposable(() => {
			if (this.targets.get(key) === target) {
				this.targets.delete(key);
			}
		});
	}

	public getTarget(inputUri: URI): IChatPasteTarget | undefined {
		return this.targets.get(extUri.getComparisonKey(inputUri));
	}

	protected override disposeCore(): void {
		this.targets.clear();
	}
}
