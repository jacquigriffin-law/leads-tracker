#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import urllib.parse
from pathlib import Path

ROOT = Path('/opt/openclaw/clients/jacqui-griffin')
SYNC_PATH = ROOT / 'scripts' / 'sync_leads_tracker.py'

spec = importlib.util.spec_from_file_location('sync_leads_tracker', SYNC_PATH)
sync = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(sync)


def assert_true(label: str, condition: bool, detail: str = '') -> None:
    if not condition:
        raise AssertionError(f'{label}: {detail}')
    print(f'  PASS  {label}')


def main() -> int:
    local = json.loads((ROOT / 'leads-tracker' / 'data.json').read_text())['leads']

    print('\nnormalise_received')
    assert_true(
        'normalises Z and +00:00 as same instant',
        sync.normalise_received('2026-06-15T01:19:19Z') == sync.normalise_received('2026-06-15T01:19:19+00:00'),
    )

    print('\nmake_existing_key')
    generic_a = {
        'sender_name': 'LawAccessNSW',
        'subject': 'Offer of work from Legal Aid NSW - Care and Protection',
        'date_received': '2026-05-08T01:03:53Z',
    }
    generic_b = {
        'sender_name': 'LawAccessNSW',
        'subject': 'Offer of work from Legal Aid NSW - Care and Protection',
        'date_received': '2026-05-12T01:55:10+00:00',
    }
    assert_true('generic Legal Aid offers keep received date in key', sync.make_existing_key(generic_a) != sync.make_existing_key(generic_b))

    print('\nsync_supabase')
    calls = []

    def fake_request(path: str, _service_role_key: str, *, method: str = 'GET', body=None):
        calls.append((method, path, body))
        if method == 'GET':
            query = urllib.parse.parse_qs(urllib.parse.urlsplit('?' + path.split('?', 1)[1]).query)
            assert_true('GET asks for lead columns', 'select' in query)
            return [{key: lead.get(key) for key in sync.SUPABASE_COLUMNS if key in lead} for lead in local]
        raise AssertionError(f'unexpected write in dry-run: {method} {path}')

    original = sync.supabase_request
    sync.supabase_request = fake_request
    try:
        result = sync.sync_supabase(local, 'test-service-role', dry_run=True)
    finally:
        sync.supabase_request = original

    assert_true('all imported local leads are recognised as already remote', result['missing'] == 0, str(result))
    assert_true('dry-run does not insert', result['inserted'] == 0, str(result))

    print('\n5 tests passed\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
