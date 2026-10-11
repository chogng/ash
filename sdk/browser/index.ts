/** Host-neutral editor extension contracts. UI and backend connections remain host-owned. */
export { Emitter, type Event } from '../../src/ash/base/common/event.js';
export { Disposable, DisposableStore, DisposableMap, toDisposable, type IDisposable } from '../../src/ash/base/common/lifecycle.js';
export { URI } from '../../src/ash/base/common/uri.js';
export { extUriBiasedIgnorePathCase } from '../../src/ash/base/common/resources.js';
export { CancellationToken, CancellationTokenSource, type CancellationToken as ICancellationToken } from '../../src/ash/base/common/cancellation.js';
export { observableFromEvent } from '../../src/ash/base/common/observable.js';
export { Lxicon } from '../../src/ash/base/common/lxicons.js';
export { SCMHistoryUnavailableError } from '../../src/ash/workbench/contrib/scm/common/history.js';
export type { IAction } from '../../src/ash/base/common/actions.js';
export type { Icon } from '../../src/ash/base/common/icon.js';
export type { IResourceEditorInput } from '../../src/ash/workbench/common/editor.js';
export type { IEditorOptions } from '../../src/ash/platform/editor/common/editor.js';
export type { ISCMConflictProvider, ISCMInput, ISCMProvider, ISCMResource, ISCMResourceGroup, ISCMStatusBarCommand } from '../../src/ash/workbench/contrib/scm/common/scm.js';
export type { ISCMHistoryItemDetails, ISCMHistoryItem, ISCMHistoryItemChange, ISCMHistoryItemChangeContents, ISCMHistoryItemRef, ISCMHistoryOptions, ISCMHistoryProvider } from '../../src/ash/workbench/contrib/scm/common/history.js';
export type { QuickDiffOriginalResource, QuickDiffProvider } from '../../src/ash/workbench/contrib/scm/common/quickDiff.js';
export type { IDecorationData, IDecorationsProvider } from '../../src/ash/workbench/services/decorations/common/decorations.js';
