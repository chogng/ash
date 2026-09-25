import { Disposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { CompositeBar } from '../../../browser/parts/compositebar/compositeBar.js';
import { NumberBadge, type IActivityService } from '../common/activity.js';

/** Projects View Container activity onto the Workbench's sidebar selectors. */
export class ActivityService extends Disposable implements IActivityService {
	private readonly badges = new Map<string, { readonly badge: NumberBadge; readonly token: symbol }>();

	constructor(private readonly compositeBar: CompositeBar) {
		super();
	}

	public showViewContainerActivity(containerId: string, badge: NumberBadge): IDisposable {
		this.assertNotDisposed();
		const token = Symbol(containerId);
		this.badges.set(containerId, { badge, token });
		this.compositeBar.setBadge(containerId, badge.number, badge.description);
		return toDisposable(() => {
			if (this.badges.get(containerId)?.token !== token) return;
			this.badges.delete(containerId);
			this.compositeBar.setBadge(containerId, undefined);
		});
	}

	override dispose(): void {
		for (const containerId of this.badges.keys()) this.compositeBar.setBadge(containerId, undefined);
		this.badges.clear();
		super.dispose();
	}
}
