"""Compare current legacy code with separately frozen compatibility results."""
import importlib.util
import json
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
CORPUS_PATH = ROOT / 'tests/fixtures/legacy/corpus.json'
MODULE_SPEC = importlib.util.spec_from_file_location(
    'legacy_baseline', ROOT / 'scripts/verification/legacy_baseline.py'
)
baseline = importlib.util.module_from_spec(MODULE_SPEC)
MODULE_SPEC.loader.exec_module(baseline)
CORPUS = json.loads(CORPUS_PATH.read_text(encoding='utf-8'))


@pytest.mark.parametrize('expected', CORPUS['cases'], ids=lambda case: Path(case['input']).stem)
def test_legacy_frozen_case(expected):
    actual = baseline.characterize(ROOT, expected['input'], expected['sampling']['dt'])
    assert actual == expected


def test_original_yaml_bytes_match_frozen_hashes():
    for original in CORPUS['original_inputs']:
        assert baseline.digest(ROOT / original['source']) == original['sha256']


def test_checker_detects_changed_results_without_writing_expectations(monkeypatch):
    import wavecraft

    original = wavecraft.build_breakpoints
    frozen_bytes = CORPUS_PATH.read_bytes()

    def changed_breakpoints(spec):
        return [(time, amplitude + 1.0) for time, amplitude in original(spec)]

    monkeypatch.setattr(wavecraft, 'build_breakpoints', changed_breakpoints)
    failures = baseline.check(ROOT, CORPUS_PATH)
    assert any('breakpoints differs' in failure for failure in failures)
    assert CORPUS_PATH.read_bytes() == frozen_bytes


def test_frozen_quirks_have_reviewed_outcomes():
    cases = {Path(case['input']).stem: case for case in CORPUS['cases']}
    assert cases['percent']['spec']['steps'][1]['value'] == 420.0
    assert cases['dt_after_hold']['spec']['steps'][2]['t'] == 35e-6
    assert cases['slew_conflict_no_cascade']['breakpoints'][-1][0] == pytest.approx(200e-6, rel=0, abs=1e-18)
    assert len(cases['no_ramp_conflict_resolution']['breakpoints']) == 3
    assert len(cases['no_ramp_conflict_none']['breakpoints']) == 2
    assert cases['duplicate_backward_drop']['breakpoints'] == [[0.0, 0.0], [2e-6, 3.0]]
    assert cases['implicit_initial_zero']['breakpoints'][0] == [0.0, 0.0]
    sampled = cases['final_sample_exclusion']
    assert sampled['sampling']['time_s'][-1] < sampled['breakpoints'][-1][0]
    assert cases['schematic_repeat_reset']['schematic_repeat_pwl'] == (
        'PWL REPEAT FOREVER (0 1 2e-06 1 1e-05 3 1.1e-05 1) ENDREPEAT'
    )
