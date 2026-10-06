import { isHotReloadEnabled } from "./hotReload.js";
import { registerHotReloadHandler } from "./hotReload.js";
import { constObservable } from "./observable.js";
import type { IObservable } from "./observable.js";
import type { IReader } from "./observable.js";
import type { ISettableObservable } from "./observable.js";
import { observableSignalFromEvent } from "./observable.js";
import { observableValue } from "./observable.js";

// All versions share one slot; retaining the original import must not retain every replaced class.
const replacements = new WeakMap<object, { current: unknown; }>();

/** Reads an export and invalidates the reader when its defining module reloads. */
export function readHotReloadableExport<T>(value: T, reader: IReader | undefined): T {
	observeHotReloadableExports([value], reader);
	return currentExport(value);
}

/** Observes reloads of any module that currently exports one of the supplied values. */
export function observeHotReloadableExports(values: readonly unknown[], reader: IReader | undefined): void {
	if (!isHotReloadEnabled()) return;
	const reload = observableSignalFromEvent("reload", event => registerHotReloadHandler(({ oldExports }) => {
		const tracked = Object.entries(oldExports).filter(([, value]) => values.some(watched => currentExport(watched) === value));
		if (tracked.length === 0) return undefined;
		return newExports => {
			if (tracked.some(([name]) => !(name in newExports))) return false;
			for (const [name, previous] of tracked) {
				if (previous !== newExports[name] && isExportReference(previous)) {
					const replacement = newExports[name];
					const slot = replacements.get(previous) ?? { current: previous };
					slot.current = replacement;
					replacements.set(previous, slot);
					if (isExportReference(replacement)) {
						replacements.set(replacement, slot);
					}
				}
			}
			event(undefined);
			return true;
		};
	}));
	reload.read(reader);
}

function currentExport<T>(value: T): T {
	const slot = isExportReference(value) ? replacements.get(value) : undefined;
	return slot ? slot.current as T : value;
}

function isExportReference(value: unknown): value is object {
	return typeof value === 'function' || (typeof value === 'object' && value !== null);
}

interface HotClassEntry {
	readonly observable: ISettableObservable<unknown>;
	current: unknown;
}

const classes = new Map<string, HotClassEntry>();

/** Returns a stable observable class slot that updates after a replacement module evaluates. */
export function createHotClass<T>(clazz: T): IObservable<T> {
	if (!isHotReloadEnabled()) return constObservable(clazz);
	const id = className(clazz);
	let existing = classes.get(id);
	if (!existing) {
		existing = { observable: observableValue(id, clazz), current: clazz };
		classes.set(id, existing);
		registerHotReloadHandler(({ oldExports }) => {
			if (!Object.values(oldExports).includes(existing?.current)) return undefined;
			return newExports => Object.values(newExports).some(value => isNamedClass(value, id));
		});
	} else {
		setTimeout(() => {
			if (!existing) return;
			existing.current = clazz;
			existing.observable.set(clazz, undefined);
		}, 0);
	}
	return existing.observable as IObservable<T>;
}

function className(value: unknown): string {
	const name = typeof value === "function" ? value.name : undefined;
	if (!name) throw new TypeError("Hot classes must have a stable name");
	return name;
}

function isNamedClass(value: unknown, name: string): boolean {
	return typeof value === "function" && value.name === name;
}
