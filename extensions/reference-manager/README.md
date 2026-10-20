# Reference Manager

Reference Manager (`ash.reference-manager`) is an optional, independently installed Rust editor extension with a verified client. It owns RIS import, a local reference library, metadata, stable entry identities and PDF attachment links. Academy owns writing and document transactions; PDF Viewer owns reading and annotations; literature search belongs to Plugins containing tools and Skills. None is statically imported into Code or the Agents window by this package.

## Use

Install the separately distributed `editor` package through Extensions, enable it and authorize that exact package. Open a `.ris` file using the registered Reference Library editor, then choose **Save library as** and a new `.ash-library` destination. The original RIS is never overwritten. To begin without RIS, open an empty `.ash-library` file; **New library** in the editor creates another library. These actions are editor toolbar controls, not global commands.

**Import RIS** merges additional records. DOI identity is case-insensitive and accepts DOI URLs or `doi:` prefixes; records without a DOI are compared by normalized type, title, year and authors. Existing metadata and IDs survive duplicate imports. **Add reference**, **Edit reference**, **Delete reference** and search manage keys, bibliographic fields, abstracts and keywords. Arrow keys, Home and End navigate entries. Metadata changes save automatically once the library has a destination; Save and Save as also work explicitly. Reference keys must be unique within a library.

Open an Academy document beside the library, place its caret and select it as the target. **Insert citation** adds or reuses a linked bibliography entry and inserts the citation in one undo step. **Update citations** refreshes linked bibliography text and citation keys together, also in one undo step. Library and entry UUIDs, rather than filenames or editable keys, identify links. Key swaps are supported; conflicting unrelated document keys and ambiguous legacy definitions reject the whole operation. Explicit citation labels survive updates. Save the library before either operation. Deleting a library entry retains existing document content; Update reports links whose library entry is missing. Saving the document persists its links in the native Academy format. External format round trips do not guarantee these private links.

**Attach PDF** selects file resources and stores their links. **Open PDF** opens the first attachment through the separately installed, enabled and authorized `ash.pdf-viewer` resource editor. It does not fetch RIS `L1` links, download PDFs or contain a PDF parser. Additional attachments remain listed in the entry details.

## Ownership and recovery

A window shares one retained working copy for a library resource. The `.ash-library` version-1 JSON file is authoritative for normalized metadata; preserved RIS fields are inert import provenance, not a second editable metadata model. Save as preserves library and entry identities. Copying a library file therefore creates another location for the same logical library; divergent copies should not be used as independent libraries in the same document.

Writes use the file service's revision comparison. Another window's write produces a conflict and retains the dirty draft and backup; Save as preserves it separately, or Reload explicitly discards it after confirmation. Save as creates a new file and refuses overwrite. Workspace file authorization still applies. Disabling, revoking or replacing the provider removes new routing, cancels writes and freezes existing views with their drafts. Re-enable and reopen while the frozen view remains open to transfer its dirty working copy to the new provider. Closing participates in the normal Workbench dirty/backup lifecycle; a frozen provider cannot save. Retired handles never resume.

Academy exposes `academy.citations.v1` through its open editor's bounded `getExtensionApi` handle. Its source contract and validation live in [libraryCitationApi.ts](../academic/browser/contrib/citation/common/libraryCitationApi.ts). The handle binds the current document version and pane/provider lifetime; stale, canceled, composing and read-only edits are rejected before one Academy transaction is dispatched. Reference Manager sends IDs, keys and formatted plain text; it never acquires or mutates Academy's model. The host transports opaque calls and owns no citation or RIS semantics. This is a trusted installed client contract, not a general third-party Host RPC document API.

The first release uses a deterministic plain bibliography formatter. CSL style selection, BibTeX/EndNote import/export, online lookup, cloud synchronization, full-text search and PDF metadata extraction are outside this release. RIS is UTF-8, with optional BOM, standard line endings, `TY`/`ER` record boundaries, repeated authors/keywords and indented continuations. Unknown fields and types are retained. Input limits are 8 MiB, 10,000 records, 300 fields per record and 131,072 characters per field; library persistence has matching total/record limits. Invalid input rejects the import before changing the library. Field mapping follows the [RIS format reference](https://www.ehu.eus/documents/1738121/1798113/ACCESS%2BA%2BRIS.pdf); the parser is original implementation code.

Accessible View reads library metadata and abstracts. Accessibility Help explains actions and keyboard controls; `accessibility.verbosity.resourceEditor` controls its hint. Provider labels, controls, status and help support English and Simplified Chinese.

## Build and validation

```sh
just verify ash-reference-manager
pnpm package:editor extensions/reference-manager .build/reference-manager-submission darwin-arm64=.build/cargo/ci-test/ash-reference-manager
pnpm test:unit --run src/ash/workbench/services/extensions/test/browser/referenceLibrary.test.ts
pnpm test:editor:browser referenceManager.integration.spec.ts --project=chromium
```

Supply another `target=executable` argument for each supported target. Product packages omit the optional executable, manifest and client. The submission uses the existing signed catalog, Manager, exact execution consent, SDK launcher and closed client integrity chain. Creating a local submission does not publish it. The native source digest binds the client implementation to its provider.

Chromium integration uses actual Rust Reference Manager, Academy and PDF Viewer processes and separately compiled clients, with test-owned files and dialog selections. It checks English/Chinese import, deduplication, metadata editing, persistence, citation insertion/update/undo, missing-entry handling, optional PDF rendering, conflicts, retirement recovery and read-only controls. Signed-package installation is covered separately by the opt-in App Server test using `ASH_REFERENCE_MANAGER_DISTRIBUTION` and `ASH_REFERENCE_MANAGER_TRUSTED_ROOT`. Electron multi-window/remote, physical assistive technology and other OS targets remain part of the existing editor-platform acceptance scope in the root TODO.
