# @ash/sdk

Ash's public TypeScript extension API. This package contains self-contained types and
a host-only module entry; no Ash checkout, Rust toolchain or `@types/ash` is needed to
compile a TypeScript extension. The admitted Ash host supplies the runtime implementation
for this exact extension. Importing the package in an ordinary Node process does not grant
access to Ash services.

```ts
import * as ash from '@ash/sdk';

export function activate(context: ash.ExtensionContext): void {
  context.subscriptions.push(ash.commands.register('example.read', async path => {
    if (typeof path !== 'string') throw new TypeError('Expected a workspace path');
    return ash.files.readTextFile(path);
  }));
}
```

Declare the command in `package.json` and select `api: ash` in the current executable
extension declaration. Compile TypeScript to JavaScript and leave `@ash/sdk` external
when bundling. The product host resolves both ESM imports and CommonJS requires to its
bound implementation. See the [inspect example](../../../examples/extensions/inspect/README.md).

The API includes `commands.register` and `commands.execute`, authorized UTF-8 file reads,
client-owned documents and configuration in `workspace`, UI and comparison operations in
`window`, language providers, tasks, debugging, terminal providers, speech and SCM providers.
Each group exposes implemented domain operations with self-contained TypeScript types.
Registration, execution and events retain their existing admission and disposal owners.

`files.readTextFile` runs in the existing Rust filesystem service, inherits the callback's authority,
cancellation and deadline, and fails after cancellation or extension retirement. The Rust
service enforces package permission, directory containment and a 256 KiB read budget.
The current read path requires a local Plugin with explicit package and directory-read
grants; signed registry JavaScript deployments currently deny workspace filesystem reads.
Unsaved editor text belongs to the client-owned document APIs in `workspace`; filesystem
reads return persisted bytes. `window.openComparison` accepts text, binary and multiple
comparison inputs without granting access to arbitrary editor transport operations.

This is API version 1 of the Ash author contract. It does not provide arbitrary backend
RPC, a service container, compatibility modules, secrets or
arbitrary third-party Renderer execution. The existing package and authorization managers
remain authoritative. `.ashx` packaging is separate migration work;
the current package declaration is still used by the local installer.

The declared completion API supports simple replacement ranges, text/snippet insertion and
additional text edits. Resolve callbacks, command-bearing items, insert/replace ranges and
unsupported completion kinds are excluded. Configuration is read-only; workspace file
operations provide read/stat/directory listing, with `ctime` currently reported as zero.

`WorkspaceEdit.renameFile` is supported in language-provider edit results.
`workspace.applyEdit` applies text edits through the client model owner and rejects file
operations. Registry Remote resolvers currently use workspace scope; profile-scoped local
Plugin resolvers remain a separate admitted deployment path.
