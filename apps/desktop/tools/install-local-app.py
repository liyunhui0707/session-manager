#!/usr/bin/env python3
"""Install this project's packaged reader and maintain its one fixed Dock entry.

Run explicitly after packaged QA. Existing app and Dock settings are backed up;
no transcripts, credentials, unrelated Dock entries or old Git history are read.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import plistlib
import pwd
import subprocess
import uuid

APP_NAME = 'AI Session Manager.app'
BUNDLE_ID = 'com.aisessionmanager.desktop'


def info(app):
    return plistlib.loads((app / 'Contents/Info.plist').read_bytes())


def manifest(app):
    result = {}
    for parent, directories, files in os.walk(app, followlinks=False):
        for name in directories + files:
            p = Path(parent) / name
            relative = str(p.relative_to(app))
            if p.is_symlink():
                result[relative] = ['link', os.readlink(p)]
            elif p.is_file():
                result[relative] = ['file', hashlib.sha256(p.read_bytes()).hexdigest(), p.stat().st_mode & 0o777]
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--expected-version', required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    source = root / 'dist/mac-arm64' / APP_NAME
    package = json.loads((root / 'package.json').read_text())
    if package['version'] != args.expected_version or info(source).get('CFBundleIdentifier') != BUNDLE_ID or info(source).get('CFBundleShortVersionString') != args.expected_version:
        raise RuntimeError('Packaged identity/version does not match the requested install')
    applications = Path.home() / 'Applications'
    applications.mkdir(exist_ok=True)
    if applications.is_symlink():
        raise RuntimeError('Refusing a redirected Applications directory')
    target = applications / APP_NAME
    if target.is_symlink() or (target.exists() and info(target).get('CFBundleIdentifier') != BUNDLE_ID):
        raise RuntimeError('Existing target is not this application')
    # Do not replace a running installed copy. The temporary QA profiles exit first.
    commands = subprocess.check_output(['/bin/ps', '-axo', 'command='], text=True)
    if any(line.startswith(str(target / 'Contents/MacOS/AI Session Manager')) for line in commands.splitlines()):
        raise RuntimeError('Quit the installed Session Manager before replacing it')
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:6]
    backup = Path.home() / 'Library/Application Support/AI Session Manager/DeliveryBackups' / stamp
    backup.mkdir(parents=True, mode=0o700)
    old_dock = subprocess.check_output(['/usr/bin/defaults', 'export', 'com.apple.dock', '-'])
    (backup / 'dock.plist').write_bytes(old_dock)
    os.chmod(backup / 'dock.plist', 0o600)
    staged = applications / ('.asm-install-' + stamp + '.app')
    subprocess.run(['/usr/bin/ditto', str(source), str(staged)], check=True)
    expected = manifest(source)
    if manifest(staged) != expected:
        raise RuntimeError('Staged app verification failed; existing app retained')
    previous = backup / APP_NAME
    if target.exists(): target.rename(previous)
    try:
        staged.rename(target)
    except Exception:
        if previous.exists(): previous.rename(target)
        raise
    dock = plistlib.loads(old_dock)
    entries = dock.get('persistent-apps', [])
    urls = {target.as_uri(), target.as_uri() + '/', source.as_uri(), source.as_uri() + '/'}
    def ours(entry):
        data = entry.get('tile-data', {})
        return data.get('bundle-identifier') == BUNDLE_ID or data.get('file-data', {}).get('_CFURLString') in urls
    new_entry = {'tile-type': 'file-tile', 'tile-data': {
        'bundle-identifier': BUNDLE_ID, 'file-label': 'AI Session Manager',
        'file-data': {'_CFURLString': target.as_uri() + '/', '_CFURLStringType': 15},
        'file-type': 41,
    }}
    first = next((i for i, entry in enumerate(entries) if ours(entry)), len(entries))
    kept = [entry for entry in entries if not ours(entry)]
    kept.insert(min(first, len(kept)), new_entry)
    subprocess.run(['/usr/bin/defaults', 'write', 'com.apple.dock', 'persistent-apps', '-array',
                    *[plistlib.dumps(entry).decode() for entry in kept]], check=True)
    verified = plistlib.loads(subprocess.check_output(['/usr/bin/defaults', 'export', 'com.apple.dock', '-']))
    actual = verified.get('persistent-apps', [])
    if sum(ours(entry) for entry in actual) != 1 or [e for e in actual if not ours(e)] != [e for e in entries if not ours(e)]:
        raise RuntimeError('Dock verification failed; original preference backup retained')
    registrar = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
    subprocess.run([registrar, '-f', str(target)], check=True)
    subprocess.run(['/usr/bin/killall', '-u', pwd.getpwuid(os.getuid()).pw_name, 'Dock'], check=False, capture_output=True)
    report = {'installed': str(target), 'version': args.expected_version, 'files_verified': len(expected),
              'asar_sha256': expected['Contents/Resources/app.asar'][1], 'dock_entries': 1, 'backup': str(backup)}
    (backup / 'install-report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
