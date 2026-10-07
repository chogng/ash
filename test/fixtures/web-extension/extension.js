export function activate({ register }) {
	globalThis.ashWebExtensionFixture = { count: 0, operation: null, payload: null, worker: typeof document === 'undefined' };
	register({ kind: 'command', registrationId: 'run', command: 'ash.web.fixture.run', title: 'Run Web Extension Fixture' }, (operation, payload) => {
		const state = globalThis.ashWebExtensionFixture;
		state.count++;
		state.operation = operation;
		state.payload = payload;
		return state;
	});
}
