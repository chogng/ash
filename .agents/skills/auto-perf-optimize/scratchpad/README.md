# Performance investigation scratchpad

Put one-off Ash scenarios and analysis scripts in dated subfolders such as `2026-10-11-editor-tabs`. Keep raw measurements, parameters, failures, and before/after findings beside the script. Follow the parent [performance skill](../SKILL.md) for the supported Ash runner and scoped verification.

The old Chat scripts are unavailable for Ash. `workbench-css-performance.mts` is a VS Code comparison tool requiring an explicit `--code-root`. Do not copy its VS Code startup arguments or selectors into Ash scenarios. `userDataProfile.mts` can help prepare profiles; preserve user-provided profiles and copy seeds only while their applications are closed.

Stop the actual owning runner and await exit. Never use executable-name matching or a port alone to kill applications: either can identify an unrelated user process.
