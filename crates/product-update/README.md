# `ash-product-update`

- Owns the signed cross-product release description, policy, target and package validation.
- Verifies release identity before product hosts download or install an artifact.
- Exposes signing only to release tooling; it does not own UI, scheduling or installation.

The update helper is implemented in [`ash_update_host.rs`](src/bin/ash_update_host.rs).
Cargo declares the executable name `ash-update-host` explicitly for product packaging.

`AnnouncementDocument` owns parsing, bounded HTTP fetching and client selection for
the remote [announcement list](../../announcement_tip.toml). This is a plain-text
notice feed; it cannot download or install a product update. Client hosts own
startup requests and presentation.

Each `[[announcements]]` requires `target_app` (an `UpdateProduct` value such as
`ashCode`) and a `content` table keyed by UI locale. Optional
`version_requirement` uses semantic version ranges, for example `<0.2.0` or
`>=0.1.0, <0.3.0`; prerelease versions must be explicitly included in the range.
Optional `from_date` and `to_date` are UTC `YYYY-MM-DD`, start-inclusive and
end-exclusive. Optional `target_oses` accepts `macos`, `linux` and `windows`.
The last matching entry wins. A missing locale hides that announcement in the
corresponding language; publishers should provide `en`, `ja`, `zh-CN` and `fr`.

The document must be valid UTF-8 TOML and fit within 64 KiB. Unknown fields, invalid
version/date/OS rules, empty content, text over 1024 characters per locale and
terminal control characters other than newline reject the document. Fetches have
a two-second timeout, use HTTPS (or loopback HTTP) and do not follow redirects.
