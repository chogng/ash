<!--
Use this structure for PR descriptions and commit bodies. Keep commit subjects
short and imperative (target <= 72 characters); use type(scope): summary when
appropriate. Keep the subject on one line, leave a blank line before the body,
and omit these comments.

Both commit bodies and PR descriptions must use the separate headings
"## Why", "## What changed", and "## Testing", in that order. Leave a blank line
after each heading and between sections. Do not combine these sections or put
body text in the commit subject. Add only relevant detail; omit optional sections
rather than filling them with N/A.
-->

## Why

<!--
Explain the problem or goal and its impact. For multiple issues, explain their
shared root cause or why they belong to one logical change.
-->

## What changed

<!--
Describe the resulting behavior and meaningful changes, not a file inventory.
Include relevant compatibility risks, configuration timing, or migration steps
here; add a separate section only when it makes the explanation clearer.
-->

## Testing

<!--
Record checks actually run and their results, with commands when useful.
Distinguish tests added or updated from tests executed. State relevant checks not
run, failures, or platform/coverage limits and why. For documentation-only changes,
report documentation checks; do not imply runtime behavior was tested.
-->

<!--
Add Closes #123 only for an issue fully resolved, or Refs #123 for related work.
Omit issue references when none apply.
-->
