import { NKeyMap } from '../../../../base/common/map.js';

export interface IDecorationStyleSet {
	color: number | undefined;
	bold: boolean | undefined;
	opacity: number | undefined;
	strikethrough: boolean | undefined;
	strikethroughThickness: number | undefined;
	strikethroughColor: number | undefined;
}

export interface IDecorationStyleCacheEntry extends IDecorationStyleSet {
	id: number;
}

type DecorationStyleKey = [number | '', boolean | '', string, boolean | '', string, number | ''];

export class DecorationStyleCache {
	private _nextId = 1;
	private readonly _cacheById = new Map<number, IDecorationStyleCacheEntry>();
	private readonly _cacheByStyle = new NKeyMap<IDecorationStyleCacheEntry, DecorationStyleKey>();

	getOrCreateEntry(
		color: number | undefined,
		bold: boolean | undefined,
		opacity: number | undefined,
		strikethrough: boolean | undefined,
		strikethroughThickness: number | undefined,
		strikethroughColor: number | undefined,
	): number {
		if (color === undefined && bold === undefined && opacity === undefined && strikethrough === undefined && strikethroughThickness === undefined && strikethroughColor === undefined) {
			return 0;
		}
		// Inheritance must not reuse an entry that explicitly clears a style or makes it transparent.
		const key: DecorationStyleKey = [color ?? '', bold ?? '', opacity?.toFixed(2) ?? '', strikethrough ?? '', strikethroughThickness?.toFixed(2) ?? '', strikethroughColor ?? ''];
		const result = this._cacheByStyle.get(...key);
		if (result) return result.id;
		const id = this._nextId++;
		const entry: IDecorationStyleCacheEntry = {
			id,
			color,
			bold,
			opacity,
			strikethrough,
			strikethroughThickness,
			strikethroughColor,
		};
		this._cacheById.set(id, entry);
		this._cacheByStyle.set(entry, ...key);
		return id;
	}

	getStyleSet(id: number): IDecorationStyleSet | undefined {
		if (id === 0) return undefined;
		return this._cacheById.get(id);
	}
}
