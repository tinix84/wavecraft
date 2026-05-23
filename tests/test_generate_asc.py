import subprocess
import sys
from pathlib import Path

ROOT   = Path(__file__).parent.parent
SCRIPT = ROOT / 'scripts' / 'generate_asc.py'
OUT    = ROOT / 'examples' / 'all_profiles.asc'


def test_generate_asc_creates_file():
    result = subprocess.run(
        [sys.executable, str(SCRIPT)], capture_output=True, text=True,
        cwd=str(ROOT),
    )
    assert result.returncode == 0, result.stderr
    assert OUT.exists(), "all_profiles.asc was not created"


def test_asc_has_correct_structure():
    lines = OUT.read_text(encoding='utf-8').splitlines()
    assert lines[0] == 'Version 4'
    assert lines[1].startswith('SHEET 1')


def test_asc_has_one_current_source_per_yaml():
    n_yamls = len(list((ROOT / 'examples').glob('*.yaml')))
    text = OUT.read_text(encoding='utf-8')
    n_sources = text.count('SYMBOL current')
    assert n_sources == n_yamls, f"Expected {n_yamls} current sources, got {n_sources}"


def test_asc_no_duplicate_instnames():
    text = OUT.read_text(encoding='utf-8')
    names = [
        line.split(maxsplit=2)[2].strip()
        for line in text.splitlines()
        if line.startswith('SYMATTR InstName')
    ]
    dupes = [n for n in names if names.count(n) > 1]
    assert dupes == [], f"Duplicate InstNames: {dupes}"


def test_asc_contains_tran_directive():
    text = OUT.read_text(encoding='utf-8')
    assert '!.tran' in text


def test_validate_asc_exits_zero():
    validate = ROOT / 'scripts' / 'validate_asc.py'
    result = subprocess.run(
        [sys.executable, str(validate)], capture_output=True, text=True,
        cwd=str(ROOT),
    )
    assert result.returncode == 0, result.stdout + result.stderr
