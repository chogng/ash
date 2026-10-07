import { Disposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { CompositeBar } from '../../../browser/parts/compositeBar.js';
import { NumberBadge, type IActivityService } from '../common/activity.js';

/** Projects View Container activity onto the Workbench's sidebar selectors. */
export class ActivityService extends Disposable implements IActivityService {
	private readonly badges = new Map<string, Map<symbol, NumberBadge>>();

	constructor(private readonly compositeBar: CompositeBar) {
		super();
	}

	public showViewContainerActivity(containerId: string, badge: NumberBadge): IDisposable {
		this.assertNotDisposed();
		const token = Symbol(containerId);
		let activities = this.badges.get(containerId);
		if (!activities) {
			activities = new Map();
			this.badges.set(containerId, activities);
		}
		activities.set(token, badge);
		this.update(containerId);
		return toDisposable(() => {
			if (!activities.delete(token) || this.isDisposed) return;
			if (!activities.size) this.badges.delete(containerId);
			this.update(containerId);
		});
	}

	private update(containerId: string): void {
		const activities = [...(this.badges.get(containerId)?.values() ?? [])];
		const count = activities.reduce((total, badge) => total + badge.number, 0);
		this.compositeBar.setBadge(containerId, count || undefined, [...new Set(activities.map(badge => badge.description))].join(', '));
	}

	protected override disposeCore(): void {
		for (const [containerId, activities] of this.badges) {
			activities.clear();
			this.compositeBar.setBadge(containerId, undefined);
		}
		this.badges.clear();
		super.disposeCore();
	}
}
