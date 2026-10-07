export function activate({ register, clientRequest }) {
	let revision = 1;
	let value = 0;
	const entry = () => ({ id: 'fixture', text: `Extension status ${value}`, tooltip: 'Extension status command', ariaLabel: `Run extension status ${value}`, alignment: 'right', priority: 1.5, command: { command: 'ash.statusbar.fixture.clicked', arguments: [{ value }] } });
	const replace = entries => clientRequest({ operation: 'setStatusBarEntries', registrationId: 'status', revision: ++revision, entries });
	register({ kind: 'statusBar', registrationId: 'status', revision, entries: [] }, () => null);
	register({ kind: 'command', registrationId: 'clicked', command: 'ash.statusbar.fixture.clicked', title: 'Click Extension Status Fixture' }, async (_operation, payload) => {
		const clicked = payload.arguments[0].value;
		value = clicked + 1;
		await replace([entry()]);
		return clicked;
	});
	register({ kind: 'command', registrationId: 'show', command: 'ash.statusbar.fixture.show', title: 'Show Extension Status Fixture' }, async () => { value = 0; await replace([entry()]); return null; });
	register({ kind: 'command', registrationId: 'hide', command: 'ash.statusbar.fixture.hide', title: 'Hide Extension Status Fixture' }, async () => { await replace([]); return null; });
	register({ kind: 'command', registrationId: 'replace', command: 'ash.statusbar.fixture.replace', title: 'Replace Extension Status Fixture' }, async () => {
		for (value = 2; value <= 37; value++) await replace([entry()]);
		return null;
	});
}
