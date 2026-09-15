"""Freeze real repository text without modifying the source checkouts."""
import os
import collections
import hashlib
import json
import pathlib
import random
import re
import subprocess
import sys
import tarfile
import unicodedata

BASE = pathlib.Path(os.environ['EVAL_ROOT']).resolve()
LOCAL = ['ash', 'vscode', 'zed', 'codex']
REMOTE = {'linux': 'linux-v6.16', 'rust': 'rust-1.89.0', 'kubernetes': 'kubernetes-v1.34.0'}
MAX_BYTES = 16 * 1024**2

def prepare(name):
    dest = BASE / 'corpora' / name
    if (BASE / 'manifests' / f'{name}.json').exists():
        return
    dest.mkdir(parents=True, exist_ok=True)
    (dest / '.git').mkdir(exist_ok=True)
    if name in LOCAL:
        source = pathlib.Path(os.environ['CHECKOUT_ROOT']) / name
        commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True).strip()
        proc = subprocess.Popen(['git', 'archive', commit], cwd=source, stdout=subprocess.PIPE)
        archive = tarfile.open(fileobj=proc.stdout, mode='r|')
        origin = {'path': str(source), 'commit': commit}
    else:
        path = BASE / 'downloads' / (REMOTE[name] + '.tar.gz')
        archive = tarfile.open(path, mode='r|gz')
        origin = {'archive': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'tag': REMOTE[name]}
        proc = None
    files = []
    path_keys = set()
    renamed = {}
    excluded = collections.Counter()
    rng = random.Random(9713)
    tokens = []
    seen = 0
    for member in archive:
        if not member.isfile():
            excluded['non_regular'] += 1
            continue
        parts = pathlib.PurePosixPath(member.name).parts
        if name not in LOCAL:
            parts = parts[1:]
        if not parts or any(p.startswith('.') or p in ['..', ''] for p in parts):
            excluded['hidden'] += 1
            continue
        if member.size > MAX_BYTES:
            excluded['over_16MiB'] += 1
            continue
        content = archive.extractfile(member).read()
        if b'\0' in content:
            excluded['binary_nul'] += 1
            continue
        try:
            text = content.decode('utf-8')
        except UnicodeDecodeError:
            excluded['non_utf8'] += 1
            continue
        relative = pathlib.Path(*parts)
        key = unicodedata.normalize('NFD', str(relative)).casefold()
        if key in path_keys:
            original = str(relative)
            relative = pathlib.Path('case-sensitive-paths') / hashlib.sha256(original.encode()).hexdigest()[:16] / relative
            renamed[str(relative)] = original
        path_keys.add(key)
        out = dest / relative
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(content)
        files.append([str(relative), len(content), hashlib.sha256(content).hexdigest()])
        # One identifier per file makes the sample span files instead of favoring huge files.
        candidates = sorted(set(re.findall(r'\b[A-Za-z_][A-Za-z_0-9]{9,47}\b', text[:65536])))
        if candidates:
            token = candidates[rng.randrange(len(candidates))]
            seen += 1
            if len(tokens) < 32:
                tokens.append(token)
            else:
                k = rng.randrange(seen)
                if k < len(tokens): tokens[k] = token
        if len(files) % 10000 == 0:
            print(name, len(files), 'files', flush=True)
    archive.close()
    if proc:
        assert proc.wait() == 0
    files.sort()
    record = {'name': name, 'origin': origin, 'policy': 'All tracked/exported non-hidden regular UTF-8 files <=16 MiB, no NUL; vendor/test files retained. Ignore control files excluded. Case-colliding paths relocated with unchanged contents. Same frozen universe for all tools.', 'files': len(files), 'bytes': sum(f[1] for f in files), 'excluded': excluded, 'renamed': renamed, 'entries': files}
    (BASE / 'manifests').mkdir(exist_ok=True)
    (BASE / 'manifests' / f'{name}.json').write_text(json.dumps(record, indent=2))
    queries = []
    for i, token in enumerate(dict.fromkeys(tokens)):
        queries.append({'name': f'identifier-{i:02}', 'pattern': token, 'kind': 'literal'})
    for i, token in enumerate(tokens[:6]):
        queries += [
            {'name': f'internal-{i}', 'pattern': '.*' + token + '.*', 'kind': 'regex'},
            {'name': f'branch-{i}', 'pattern': '(?:' + token + '|search_eval_absent_427ae)', 'kind': 'regex'},
        ]
    for label, pattern in [('no-match', 'search_eval_absent_427ae_97f'), ('short', 'if'), ('common', 'return'), ('todo', 'TODO|FIXME'), ('class', '[A-Za-z_]+_[0-9]+'), ('anchor', '^\s*(?:pub |static |export )?(?:fn|func|class|struct)\s+\w+'), ('no-literal', '\\b[A-Z]{3,6}\\b'), ('optional', '(?:error)?(?:code|message)'), ('unicode', '(?i:kelvin|signal|école)')]:
        queries.append({'name': label, 'pattern': pattern, 'kind': 'regex'})
    (BASE / 'queries').mkdir(exist_ok=True)
    (BASE / 'queries' / f'{name}.json').write_text(json.dumps(queries, indent=2))
    print(name, json.dumps({k:v for k,v in record.items() if k!='entries'}), flush=True)

for name in sys.argv[1:] or LOCAL:
    prepare(name)
