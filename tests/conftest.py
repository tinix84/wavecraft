"""conftest.py — inject waveform_dsl public API into the test module's global namespace.

The test file uses bare names (parse_quantity, build_breakpoints, resample, …) that
are only imported in the __main__ block.  Under pytest the module is imported directly
so those names are never bound.  This conftest patches them in at collection time.
"""
import waveform_dsl as _wdsl


def pytest_collection_finish(session):
    """Called after collection is finished — patch test module globals."""
    import sys
    mod = sys.modules.get('tests.test_waveform_dsl') or sys.modules.get('test_waveform_dsl')
    if mod is not None:
        mod.parse_quantity    = _wdsl.parse_quantity
        mod.build_breakpoints = _wdsl.build_breakpoints
        mod.resample          = _wdsl.resample
        mod.export_csv        = _wdsl.export_csv
        mod.export_pwl        = _wdsl.export_pwl
        mod.export_plecs      = _wdsl.export_plecs
        mod.export_ltspice_pwl = _wdsl.export_ltspice_pwl
