#!/usr/bin/env python3
"""Build a local extension package without third-party modules."""
from pathlib import Path
import json
import re
import zipfile

root = Path(__file__).resolve().parent.parent
extension = root / 'extension'
manifest = json.loads((extension / 'manifest.json').read_text(encoding='utf-8'))
version = manifest['version']
package = json.loads((root / 'package.json').read_text(encoding='utf-8'))
core = (extension / 'core.js').read_text(encoding='utf-8')
core_version = re.search(r"export const VERSION = '([^']+)'", core).group(1)
if version != package['version'] or version != core_version:
    raise SystemExit('Version mismatch in manifest.json, package.json or core.js')

# Explicit sources exclude browser data, tests, credentials and generated artifacts.
files = {}
for path in sorted(extension.iterdir()):
    if path.is_file() and (path.suffix in {'.js', '.css', '.html'} or path.name == 'manifest.json'):
        files[path.name] = path.read_bytes()
for name in ['README.md', 'CHANGELOG.md']:
    files[name] = (root / name).read_bytes()
for path in sorted((root / 'docs').iterdir()):
    if path.is_file() and path.suffix in {'.md', '.txt'}:
        files[f'docs/{path.name}'] = path.read_bytes()
files['УСТАНОВКА.txt'] = (root / 'docs' / 'УСТАНОВКА.txt').read_bytes()

output = root / 'dist' / f'delta-backup-extension-{version}.zip'
output.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name, data in files.items():
        archive.writestr(f'delta-backup-extension/{name}', data)
with zipfile.ZipFile(output) as archive:
    if archive.testzip() is not None:
        raise SystemExit('Archive CRC check failed')
    expected = {f'delta-backup-extension/{name}' for name in files}
    if set(archive.namelist()) != expected or len(archive.namelist()) != len(expected):
        raise SystemExit('Archive file list mismatch')
    for name, data in files.items():
        if archive.read(f'delta-backup-extension/{name}') != data:
            raise SystemExit(f'Archive bytes mismatch: {name}')
print(f'Built {output.name}: {len(files)} files; CRC and source bytes verified')
