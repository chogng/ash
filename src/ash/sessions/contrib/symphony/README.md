# Symphony monitor

This Sessions page monitors the built-in Rust scheduler in
[`crates/symphony`](../../../../../crates/symphony/README.md). The Activity Bar
entry opens a stable `ash-symphony:/monitor` editor alongside its task sidebar.

The sidebar imports `WORKFLOW.md` files, selects workflows, creates manual tasks,
pauses future dispatch and selects conversations. The editor shows the selected
conversation's status, cumulative token usage, execution duration and user/agent
messages. Pause, resume and complete operate on the persisted scheduling intent.
No deployment manifest, external Dashboard or extra App Server is involved.

`platform/symphony` adapts the existing renderer protocol client. `SymphonyService`
keeps window-local selection and a disposable observable cache; it owns no
execution state. Subscription is installed before reads. Visible consumers share
one refresh loop. Late message reads cannot replace a newer selection. Switching
pages releases view watches; backend scheduling continues independently.

Keyboard navigation, accessibility help/view and verbosity use the Sessions
accessibility contracts. Chinese strings use the startup localization catalog.
Playwright scenarios exercise the actual shared App Server and Core on Electron
and Web with only provider HTTP responses controlled by a local test fixture.
