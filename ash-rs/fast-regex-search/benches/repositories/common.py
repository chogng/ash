"""Create a fresh common-eligibility corpus and a combined APFS test clone."""
import json
import os
import pathlib
import re
import subprocess

base = pathlib.Path(os.environ['EVAL_ROOT']).resolve()
tgrep = pathlib.Path(os.environ['TG_CHECKOUT']).resolve()
source = (tgrep / 'tgrep-core/src/walker.rs').read_text()
table = source.split('const BINARY_EXTENSIONS:', 1)[1].split('];', 1)[0]
extensions = set(re.findall(r'"([^"]+)"', table))
assert extensions, 'upstream extension table was not found'
common = base / 'common-corpora'
manifests = base / 'common-manifests'
combined = base / 'corpora/combined'
common.mkdir()
manifests.mkdir()
combined.mkdir()
(combined / '.git').mkdir()
entries = []
exclusions = {}
for name in ['ash', 'vscode', 'zed', 'codex', 'linux', 'rust', 'kubernetes']:
    manifest = json.loads((base / 'manifests' / f'{name}.json').read_text())
    destination = common / name
    subprocess.run(['cp', '-cR', str(base / 'corpora' / name), str(destination)], check=True)
    removed = [e for e in manifest['entries'] if pathlib.Path(e[0]).suffix[1:].lower() in extensions]
    exclusions[name] = removed
    for entry in removed:
        (destination / entry[0]).unlink()
    retained = [e for e in manifest['entries'] if e not in removed]
    manifest.update(entries=retained, files=len(retained), bytes=sum(e[1] for e in retained), tgrep_extension_exclusions=removed)
    (manifests / f'{name}.json').write_text(json.dumps(manifest, ensure_ascii=False))
    subprocess.run(['cp', '-cR', str(destination), str(combined / name)], check=True)
    (combined / name / '.git').rmdir()
    entries.extend([[name + '/' + e[0], *e[1:]] for e in retained])
(base / 'manifests/combined.json').write_text(json.dumps({
    'files': len(entries), 'bytes': sum(e[1] for e in entries), 'entries': entries,
    'common_extension_exclusions': exclusions,
}))
(base / 'corpus-eligibility.json').write_text(json.dumps({
    'upstream_binary_extensions': sorted(extensions), 'removed': exclusions,
    'common_files': len(entries), 'common_bytes': sum(e[1] for e in entries),
}, indent=2))
