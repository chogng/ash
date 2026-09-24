import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function loadKeybindingConformanceFixtures<T>(): T {
	const fixturePath = findFixturePath(import.meta.dirname);
	return JSON.parse(readFileSync(fixturePath, "utf8")) as T;
}

function findFixturePath(startDirectory: string): string {
	let directory = startDirectory;
	while (true) {
		const candidate = join(
			directory,
			"resources/keybindings/conformance.json",
		);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(directory);
		if (parent === directory) {
			throw new Error("Cannot locate shared keybinding conformance fixtures");
		}
		directory = parent;
	}
}
