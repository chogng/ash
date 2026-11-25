/** Product application serving the Session catalog, independent of its execution authority. */
export interface ISessionApplication {
	readonly id: string;
	readonly label: string;
}

/** Preserve unknown application identities and supplied labels instead of assigning another product. */
export function getSessionApplication(name: string, title?: string): ISessionApplication {
	const labels: Readonly<Record<string, string>> = { ash: 'Ash', codex: 'Codex', claude: 'Claude', vscode: 'VS Code' };
	return Object.freeze({ id: name, label: title?.trim() || (Object.hasOwn(labels, name) ? labels[name]! : name) });
}
