import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Finds the desktop package root from source and compiled architecture tests. */
export function findDesktopRoot(start: string): string {
	let candidate = resolve(start);
	while (true) {
		if (existsSync(resolve(candidate, "package.json")) && existsSync(resolve(candidate, "src/ash"))) return candidate;
		const nestedDesktop = resolve(candidate, "app-ts");
		if (existsSync(resolve(nestedDesktop, "package.json")) && existsSync(resolve(nestedDesktop, "src/ash"))) {
			return nestedDesktop;
		}
		const parent = dirname(candidate);
		if (parent === candidate) throw new Error(`Could not locate the desktop package from ${start}`);
		candidate = parent;
	}
}
