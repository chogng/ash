export interface IChatFindHighlightWindow {
	readonly Highlight?: { new(): { add(range: Range): void; priority?: number; }; };
	readonly CSS?: { readonly highlights?: { set(name: string, highlight: unknown): void; delete(name: string): boolean; }; };
}

export interface IChatFindHighlightRegistry {
	setRanges(owner: object, name: string, ranges: readonly Range[], priority?: number): void;
	clear(owner: object): void;
}

const windows = new WeakMap<object, IChatFindHighlightRegistry>();

export function supportsCssHighlightApi(targetWindow: IChatFindHighlightWindow): boolean {
	return !!targetWindow.Highlight && !!targetWindow.CSS?.highlights;
}

/** Each visible conversation contributes ranges without erasing another presentation's search. */
export function getChatFindHighlightRegistry(targetWindow: IChatFindHighlightWindow): IChatFindHighlightRegistry {
	let registry = windows.get(targetWindow);
	if (!registry) {
		registry = createChatFindHighlightRegistry(targetWindow);
		windows.set(targetWindow, registry);
	}
	return registry;
}

export function createChatFindHighlightRegistry(targetWindow: IChatFindHighlightWindow): IChatFindHighlightRegistry {
	const groups = new Map<string, Map<object, { readonly ranges: readonly Range[]; readonly priority: number; }>>();
	const paint = (name: string): void => {
		const entries = groups.get(name);
		if (!entries?.size) {
			groups.delete(name);
			targetWindow.CSS?.highlights?.delete(name);
			return;
		}
		if (!targetWindow.Highlight || !targetWindow.CSS?.highlights) { return; }
		const highlight = new targetWindow.Highlight();
		let priority = 0;
		for (const entry of entries.values()) {
			priority = Math.max(priority, entry.priority);
			for (const range of entry.ranges) { highlight.add(range); }
		}
		highlight.priority = priority;
		targetWindow.CSS.highlights.set(name, highlight);
	};
	return {
		setRanges(owner, name, ranges, priority = 0) {
			let entries = groups.get(name);
			if (!entries) { entries = new Map(); groups.set(name, entries); }
			if (ranges.length) { entries.set(owner, { ranges, priority }); }
			else { entries.delete(owner); }
			paint(name);
		},
		clear(owner) {
			for (const [name, entries] of groups) {
				if (entries.delete(owner)) { paint(name); }
			}
		},
	};
}
