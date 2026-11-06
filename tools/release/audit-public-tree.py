#!/usr/bin/env python3
"""Audit an explicitly bounded product tree; never traverse history or chat stores.

Reports paths/categories only, never matching credential values. This is a
publication aid, not a complete secret detector or a substitute for review.
"""
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOP_FILES = {'README.md', 'AGENTS.md', 'LICENSE', 'CONTRIBUTING.md', 'SECURITY.md', 'DEVELOPMENT.md',
             'CHANGELOG.md', '.gitignore', 'mise.toml'}
PREFIXES = ('apps/desktop/', 'docs/', 'design/session-reader/', '.github/',
            'tools/release/', 'website/')
FORBIDDEN = {'node_modules', 'dist', 'secrets', '.codex', '.claude', '.local-maintenance',
             'DeliveryBackups', 'sessions', 'archived_sessions', 'Inbox', 'AI Chats'}
PATTERNS = {
    'private-key': r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
    'credential-like': r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-[A-Za-z0-9]{30,})',
    'personal-home': r'/Users/(?!example\b|test\b|tester\b|demo\b|user\b|alice\b|bob\b|synthetic\b)[A-Za-z0-9_-]+',
    'private-address': r'\b(?:100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])|192\.168)\.\d+\.\d+\b',
}


def audit():
    raw = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=ROOT)
    paths = sorted(set(p for p in raw.decode().split('\0') if p))
    findings = []
    checked = 0
    for name in paths:
        p = Path(name)
        # Reject before reading. Deleted tracked files are not in the snapshot.
        if not (ROOT / p).exists() and not (ROOT / p).is_symlink():
            continue
        if (name not in TOP_FILES and not name.startswith(PREFIXES)) or any(
            part in FORBIDDEN or part.startswith('.env') for part in p.parts
        ) or (name.endswith(('.jsonl', '.jsonl.zst')) and not name.startswith('apps/desktop/test/session-import/fixtures/')):
            findings.append({'path': name, 'category': 'outside-public-allowlist'})
            continue
        if (ROOT / p).is_symlink():
            findings.append({'path': name, 'category': 'symlink'})
            continue
        if 'build' in p.parts and name != 'apps/desktop/build/entitlements.mac.plist':
            findings.append({'path': name, 'category': 'build-output'})
            continue
        data = (ROOT / p).read_bytes()
        checked += 1
        if p.suffix in {'.png', '.jpg', '.jpeg', '.ico', '.icns'}:
            continue  # Images require synthetic provenance and visual review.
        try:
            text = data.decode('utf-8')
        except UnicodeDecodeError:
            findings.append({'path': name, 'category': 'unexpected-binary'})
            continue
        for category, pattern in PATTERNS.items():
            if re.search(pattern, text):
                findings.append({'path': name, 'category': category})
    return {'files_checked': checked, 'findings': findings,
            'scope': 'current product tree only; no history, ignored data, or user chat stores read'}


if __name__ == '__main__':
    report = audit()
    print(json.dumps(report, indent=2))
    raise SystemExit(1 if report['findings'] else 0)
