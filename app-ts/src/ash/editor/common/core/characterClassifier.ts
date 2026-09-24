import { toUint8 } from '../../../base/common/uint.js';

/** A fast character classifier with a compact ASCII path and sparse Unicode map. */
export class CharacterClassifier<T extends number> {
	protected readonly _asciiMap: Uint8Array;
	protected readonly _map: Map<number, number>;
	protected readonly _defaultValue: number;

	constructor(_defaultValue: T) {
		const defaultValue = toUint8(_defaultValue);
		this._defaultValue = defaultValue;
		this._asciiMap = CharacterClassifier._createAsciiMap(defaultValue);
		this._map = new Map<number, number>();
	}

	private static _createAsciiMap(defaultValue: number): Uint8Array {
		const asciiMap = new Uint8Array(256);
		asciiMap.fill(defaultValue);
		return asciiMap;
	}

	set(charCode: number, _value: T): void {
		const value = toUint8(_value);
		if (charCode >= 0 && charCode < 256) this._asciiMap[charCode] = value;
		else this._map.set(charCode, value);
	}

	get(charCode: number): T {
		return (charCode >= 0 && charCode < 256 ? this._asciiMap[charCode] : this._map.get(charCode) || this._defaultValue) as T;
	}

	clear() {
		this._asciiMap.fill(this._defaultValue);
		this._map.clear();
	}
}

const enum Boolean { False = 0, True = 1 }

export class CharacterSet {
	private readonly _actual: CharacterClassifier<Boolean>;

	constructor() {
		this._actual = new CharacterClassifier<Boolean>(Boolean.False);
	}

	add(charCode: number): void { this._actual.set(charCode, Boolean.True); }
	has(charCode: number): boolean { return this._actual.get(charCode) === Boolean.True; }
	clear(): void { return this._actual.clear(); }
}
