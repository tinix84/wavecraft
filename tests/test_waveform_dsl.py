"""Tests for waveform_dsl.py — run with: conda run -n social_env python tests/test_waveform_dsl.py"""
import sys
import traceback
import warnings
from pathlib import Path

from wavecraft import WaveformStep, WaveformSpec

passed = 0
failed = 0

def run_test(name, fn):
    global passed, failed
    try:
        fn()
        print(f"  OK  {name}")
        passed += 1
    except AssertionError as e:
        print(f"  FAIL {name}: {e}")
        failed += 1
    except Exception as e:
        print(f"  ERR  {name}: {type(e).__name__}: {e}")
        traceback.print_exc()
        failed += 1

# ── Task 1: Data model ────────────────────────────────────────────────────────

def test_waveformstep_hold_defaults():
    s = WaveformStep(kind='hold', value=420.0, hold_duration=500e-6)
    assert s.kind == 'hold'
    assert s.value == 420.0
    assert s.hold_duration == 500e-6
    assert s.t is None
    assert s.slew_rate is None

def test_waveformstep_absolute_defaults():
    s = WaveformStep(kind='absolute', t=1.0, value=0.0)
    assert s.kind == 'absolute'
    assert s.t == 1.0
    assert s.hold_duration is None
    assert s.slew_rate is None

def test_waveformspec_defaults():
    spec = WaveformSpec(
        name='test', nominal_current=240.0,
        slew_rate=6e6, resolution=1e-6, steps=[]
    )
    assert spec.name == 'test'
    assert spec.nominal_current == 240.0
    assert spec.slew_rate == 6e6
    assert spec.resolution == 1e-6
    assert spec.steps == []

# ── Task 2: Unit parser ───────────────────────────────────────────────────────

def test_parse_240A():
    q = parse_quantity("240A")
    assert abs(q.to('ampere').magnitude - 240.0) < 1e-9, q

def test_parse_6A_per_us():
    q = parse_quantity("6A/us")
    assert abs(q.to('ampere/second').magnitude - 6e6) < 1.0, q

def test_parse_500us():
    q = parse_quantity("500us")
    assert abs(q.to('second').magnitude - 500e-6) < 1e-15, q

def test_parse_5ms():
    q = parse_quantity("5ms")
    assert abs(q.to('second').magnitude - 5e-3) < 1e-15, q

def test_parse_1s():
    q = parse_quantity("1s")
    assert abs(q.to('second').magnitude - 1.0) < 1e-15, q

def test_parse_1000ms():
    q = parse_quantity("1000ms")
    assert abs(q.to('second').magnitude - 1.0) < 1e-9, q

def test_parse_24mA():
    q = parse_quantity("24mA")
    assert abs(q.to('ampere').magnitude - 0.024) < 1e-9, q

def test_resolve_percent():
    from wavecraft.parser import _resolve_value
    val = _resolve_value("175%", 240.0)
    assert abs(val - 420.0) < 1e-9, val

def test_resolve_absolute_amps():
    from wavecraft.parser import _resolve_value
    val = _resolve_value("360A", None)
    assert abs(val - 360.0) < 1e-9, val

def test_resolve_percent_no_nominal_raises():
    from wavecraft.parser import _resolve_value
    try:
        _resolve_value("175%", None)
        assert False, "Should have raised ValueError"
    except ValueError:
        pass

# ── Task 3: YAML parser ───────────────────────────────────────────────────────

def test_parse_yaml_globals():
    from wavecraft import parse_yaml
    fixture = Path(__file__).parent / 'fixture_basic.yaml'
    spec = parse_yaml(fixture)
    assert spec.name == 'basic_test'
    assert abs(spec.nominal_current - 240.0) < 1e-9
    assert abs(spec.slew_rate - 6e6) < 1.0        # 6 A/us = 6e6 A/s
    assert abs(spec.resolution - 1e-6) < 1e-15    # 1us = 1e-6 s

def test_parse_yaml_step_count():
    from wavecraft import parse_yaml
    fixture = Path(__file__).parent / 'fixture_basic.yaml'
    spec = parse_yaml(fixture)
    assert len(spec.steps) == 5

def test_parse_yaml_absolute_step():
    from wavecraft import parse_yaml
    fixture = Path(__file__).parent / 'fixture_basic.yaml'
    spec = parse_yaml(fixture)
    s = spec.steps[0]   # {t: 0us, value: 0A}
    assert s.kind == 'absolute'
    assert abs(s.t - 0.0) < 1e-15
    assert abs(s.value - 0.0) < 1e-9

def test_parse_yaml_hold_percent_step():
    from wavecraft import parse_yaml
    fixture = Path(__file__).parent / 'fixture_basic.yaml'
    spec = parse_yaml(fixture)
    s = spec.steps[1]   # {hold: "175%", for: "500us"}
    assert s.kind == 'hold'
    assert abs(s.value - 420.0) < 1e-9         # 175% of 240A
    assert abs(s.hold_duration - 500e-6) < 1e-15
    assert s.slew_rate is None                  # no per-step override

def test_parse_yaml_hold_absolute_step():
    from wavecraft import parse_yaml
    fixture = Path(__file__).parent / 'fixture_basic.yaml'
    spec = parse_yaml(fixture)
    s = spec.steps[2]   # {hold: "360A", for: "5ms"}
    assert abs(s.value - 360.0) < 1e-9
    assert abs(s.hold_duration - 5e-3) < 1e-15

def test_parse_yaml_per_step_slew():
    from wavecraft import parse_yaml
    fixture = Path(__file__).parent / 'fixture_basic.yaml'
    spec = parse_yaml(fixture)
    s = spec.steps[3]   # {hold: "125%", for: "50ms", slew_rate: "3A/us"}
    assert s.slew_rate is not None
    assert abs(s.slew_rate - 3e6) < 1.0        # 3 A/us = 3e6 A/s

def test_parse_yaml_absolute_timestamp():
    from wavecraft import parse_yaml
    fixture = Path(__file__).parent / 'fixture_basic.yaml'
    spec = parse_yaml(fixture)
    s = spec.steps[4]   # {t: "1s", value: "0A"}
    assert s.kind == 'absolute'
    assert abs(s.t - 1.0) < 1e-15
    assert abs(s.value - 0.0) < 1e-9

# ── Relative time-delta syntax ────────────────────────────────────────────────

def test_parse_yaml_t_plus_prefix(tmp_path):
    from wavecraft import parse_yaml
    yaml_text = """
name: rel_t_test
steps:
  - {t: "0us", value: "0A"}
  - {t: "+1ms", value: "1A"}
  - {t: "+1ms", value: "0A"}
"""
    p = tmp_path / "rel_t.yaml"
    p.write_text(yaml_text)
    spec = parse_yaml(p)
    assert len(spec.steps) == 3
    assert spec.steps[0].kind == 'absolute' and abs(spec.steps[0].t - 0.0) < 1e-15
    assert spec.steps[1].kind == 'absolute' and abs(spec.steps[1].t - 1e-3) < 1e-15
    assert spec.steps[2].kind == 'absolute' and abs(spec.steps[2].t - 2e-3) < 1e-15
    assert abs(spec.steps[1].value - 1.0) < 1e-12


def test_parse_yaml_t_plus_first_step(tmp_path):
    """A leading +DUR step anchors against prev_t=0."""
    from wavecraft import parse_yaml
    yaml_text = """
name: rel_first
steps:
  - {t: "+500us", value: "1A"}
  - {t: "+500us", value: "0A"}
"""
    p = tmp_path / "rel_first.yaml"
    p.write_text(yaml_text)
    spec = parse_yaml(p)
    assert abs(spec.steps[0].t - 500e-6) < 1e-15
    assert abs(spec.steps[1].t - 1000e-6) < 1e-15


def test_parse_yaml_t_plus_after_hold(tmp_path):
    """A hold step must not advance prev_t; the next +DUR anchors at the prior absolute t."""
    from wavecraft import parse_yaml
    yaml_text = """
name: hold_then_rel
steps:
  - {t: "0us", value: "0A"}
  - {hold: "10A", for: "500us"}
  - {t: "+1ms", value: "0A"}
"""
    p = tmp_path / "hold_then_rel.yaml"
    p.write_text(yaml_text)
    spec = parse_yaml(p)
    # prev_t after step 0 = 0; hold leaves prev_t at 0; so step 2's resolved t = 0 + 1ms.
    assert abs(spec.steps[2].t - 1e-3) < 1e-15


def test_parse_yaml_dt_key(tmp_path):
    from wavecraft import parse_yaml
    yaml_text = """
name: dt_test
steps:
  - {t: "0us", value: "0A"}
  - {dt: "1ms", value: "1A"}
  - {dt: "1ms", value: "0A"}
"""
    p = tmp_path / "dt.yaml"
    p.write_text(yaml_text)
    spec = parse_yaml(p)
    assert len(spec.steps) == 3
    assert spec.steps[1].kind == 'absolute' and abs(spec.steps[1].t - 1e-3) < 1e-15
    assert spec.steps[2].kind == 'absolute' and abs(spec.steps[2].t - 2e-3) < 1e-15


def test_parse_yaml_dt_equivalent_to_t_plus(tmp_path):
    from wavecraft import parse_yaml
    yaml_a = "name: a\nsteps:\n  - {t: '0us', value: '0A'}\n  - {t: '+1ms', value: '1A'}\n"
    yaml_b = "name: b\nsteps:\n  - {t: '0us', value: '0A'}\n  - {dt: '1ms', value: '1A'}\n"
    pa = tmp_path / "a.yaml"; pa.write_text(yaml_a)
    pb = tmp_path / "b.yaml"; pb.write_text(yaml_b)
    sa = parse_yaml(pa); sb = parse_yaml(pb)
    assert sa.steps[1].t == sb.steps[1].t
    assert sa.steps[1].value == sb.steps[1].value
    assert sa.steps[1].kind == sb.steps[1].kind


def test_parse_yaml_dt_first_step(tmp_path):
    from wavecraft import parse_yaml
    yaml_text = """
name: dt_first
steps:
  - {dt: "1ms", value: "1A"}
"""
    p = tmp_path / "dtf.yaml"
    p.write_text(yaml_text)
    spec = parse_yaml(p)
    assert spec.steps[0].kind == 'absolute'
    assert abs(spec.steps[0].t - 1e-3) < 1e-15


def test_parse_yaml_negative_dt_raises(tmp_path):
    from wavecraft import parse_yaml
    yaml_text = """
name: neg
steps:
  - {t: "1ms", value: "0A"}
  - {dt: "-1ms", value: "1A"}
"""
    p = tmp_path / "neg.yaml"
    p.write_text(yaml_text)
    try:
        parse_yaml(p)
    except ValueError as e:
        assert "Step 1" in str(e)
        return
    assert False, "Expected ValueError for negative dt"


def test_parse_yaml_negative_t_plus_raises(tmp_path):
    from wavecraft import parse_yaml
    yaml_text = """
name: neg2
steps:
  - {t: "1ms", value: "0A"}
  - {t: "+-1ms", value: "1A"}
"""
    p = tmp_path / "neg2.yaml"
    p.write_text(yaml_text)
    try:
        parse_yaml(p)
    except ValueError as e:
        assert "Step 1" in str(e)
        return
    assert False, "Expected ValueError for negative t+ delta"


def test_parse_yaml_t_and_dt_conflict_raises(tmp_path):
    from wavecraft import parse_yaml
    yaml_text = """
name: conflict
steps:
  - {t: "1ms", dt: "1ms", value: "0A"}
"""
    p = tmp_path / "conflict.yaml"
    p.write_text(yaml_text)
    try:
        parse_yaml(p)
    except ValueError as e:
        assert "Step 0" in str(e)
        return
    assert False, "Expected ValueError for t+dt on same step"


def test_parse_yaml_dt_without_value_raises(tmp_path):
    from wavecraft import parse_yaml
    yaml_text = """
name: noval
steps:
  - {dt: "1ms"}
"""
    p = tmp_path / "noval.yaml"
    p.write_text(yaml_text)
    try:
        parse_yaml(p)
    except ValueError as e:
        assert "Step 0" in str(e)
        return
    assert False, "Expected ValueError for dt without value"


# ── Task 4: Engine — hold steps ───────────────────────────────────────────────

def test_hold_basic_ramp_and_hold():
    """0A → ramp to 420A in 70us → hold 500us."""
    spec = WaveformSpec(
        name='t', nominal_current=240.0, slew_rate=6e6, resolution=1e-6,
        steps=[
            WaveformStep(kind='hold', value=420.0, hold_duration=500e-6),
        ]
    )
    bps = build_breakpoints(spec)
    t_vals = [p[0] for p in bps]
    a_vals = [p[1] for p in bps]
    assert abs(t_vals[0] - 0.0) < 1e-12,    f"Expected ramp start at t=0, got {t_vals[0]}"
    assert abs(a_vals[0] - 0.0) < 1e-9,     f"Expected 0A at t=0, got {a_vals[0]}"
    assert any(abs(t - 70e-6) < 1e-9 for t in t_vals), f"Expected ramp end at 70us, got {t_vals}"
    assert any(abs(a - 420.0) < 1e-9 for a in a_vals), f"Expected 420A in bps"
    assert abs(t_vals[-1] - 570e-6) < 1e-9, f"Expected hold end at 570us, got {t_vals[-1]}"

def test_hold_no_delta_no_ramp():
    """Hold at same value as initial state — no ramp points added."""
    spec = WaveformSpec(
        name='t', nominal_current=None, slew_rate=6e6, resolution=1e-6,
        steps=[
            WaveformStep(kind='hold', value=0.0, hold_duration=100e-6),
        ]
    )
    bps = build_breakpoints(spec)
    assert len(bps) == 1
    assert abs(bps[0][0] - 100e-6) < 1e-15

def test_hold_resolution_fallback_ramp():
    """No slew_rate → use resolution as ramp slot."""
    spec = WaveformSpec(
        name='t', nominal_current=None, slew_rate=None, resolution=10e-6,
        steps=[
            WaveformStep(kind='hold', value=100.0, hold_duration=100e-6),
        ]
    )
    bps = build_breakpoints(spec)
    t_vals = [p[0] for p in bps]
    assert any(abs(t - 10e-6) < 1e-9 for t in t_vals), f"Expected ramp end at 10us, got {t_vals}"
    assert abs(t_vals[-1] - 110e-6) < 1e-9

def test_hold_per_step_slew_override():
    """Per-step slew_rate = 3A/us overrides global 6A/us."""
    spec = WaveformSpec(
        name='t', nominal_current=None, slew_rate=6e6, resolution=None,
        steps=[
            WaveformStep(kind='hold', value=300.0, hold_duration=100e-6, slew_rate=3e6),
        ]
    )
    bps = build_breakpoints(spec)
    t_vals = [p[0] for p in bps]
    # ramp_time = 300/3e6 = 100us (not 300/6e6 = 50us)
    assert any(abs(t - 100e-6) < 1e-9 for t in t_vals), f"Expected ramp end at 100us, got {t_vals}"

def test_hold_sequence_two_steps():
    """Two consecutive hold steps — breakpoints chain correctly."""
    spec = WaveformSpec(
        name='t', nominal_current=None, slew_rate=6e6, resolution=None,
        steps=[
            WaveformStep(kind='hold', value=420.0, hold_duration=100e-6),
            WaveformStep(kind='hold', value=360.0, hold_duration=100e-6),
        ]
    )
    bps = build_breakpoints(spec)
    t_vals = [p[0] for p in bps]
    a_vals = [p[1] for p in bps]
    assert len(t_vals) == len(set(round(t, 15) for t in t_vals)), "Duplicate t found"
    assert any(abs(a - 420.0) < 1e-9 for a in a_vals)
    assert any(abs(a - 360.0) < 1e-9 for a in a_vals)

# ── Task 5: Engine — absolute steps ──────────────────────────────────────────

def test_absolute_step_anchor_only():
    """Single absolute step at t=0, value=0 — produces one breakpoint."""
    spec = WaveformSpec(
        name='t', nominal_current=None, slew_rate=6e6, resolution=None,
        steps=[WaveformStep(kind='absolute', t=0.0, value=0.0)]
    )
    bps = build_breakpoints(spec)
    assert len(bps) == 1
    assert abs(bps[0][0] - 0.0) < 1e-15
    assert abs(bps[0][1] - 0.0) < 1e-9

def test_absolute_step_ramp_ends_at_t():
    """0A → 420A with slew=6A/us: ramp must end exactly at declared t=1s."""
    spec = WaveformSpec(
        name='t', nominal_current=None, slew_rate=6e6, resolution=None,
        steps=[
            WaveformStep(kind='absolute', t=0.0, value=0.0),
            WaveformStep(kind='absolute', t=1.0, value=420.0),
        ]
    )
    bps = build_breakpoints(spec)
    t_vals = [p[0] for p in bps]
    assert abs(t_vals[-1] - 1.0) < 1e-9, f"Expected 1s, got {t_vals[-1]}"
    ramp_start = 1.0 - 420.0 / 6e6   # 1s - 70us
    assert any(abs(t - ramp_start) < 1e-9 for t in t_vals), \
        f"Expected ramp_start at {ramp_start:.9f}, got {t_vals}"

def test_absolute_step_no_slew_pure_linear():
    """No slew_rate, no resolution: just add the endpoint (linear implied)."""
    spec = WaveformSpec(
        name='t', nominal_current=None, slew_rate=None, resolution=None,
        steps=[
            WaveformStep(kind='absolute', t=0.0, value=0.0),
            WaveformStep(kind='absolute', t=1.0, value=420.0),
        ]
    )
    bps = build_breakpoints(spec)
    assert len(bps) == 2
    assert abs(bps[0][0] - 0.0) < 1e-15
    assert abs(bps[1][0] - 1.0) < 1e-15

def test_absolute_step_conflict_pushed_forward():
    """t=10us but ramp needs 70us: step pushed to t=70us, warning emitted."""
    spec = WaveformSpec(
        name='t', nominal_current=None, slew_rate=6e6, resolution=None,
        steps=[
            WaveformStep(kind='absolute', t=0.0, value=0.0),
            WaveformStep(kind='absolute', t=10e-6, value=420.0),  # too soon
        ]
    )
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter('always')
        bps = build_breakpoints(spec)
    assert len(w) == 1, f"Expected 1 warning, got {len(w)}"
    assert 'pushed' in str(w[0].message).lower(), str(w[0].message)
    assert abs(bps[-1][0] - 70e-6) < 1e-9, f"Expected 70us, got {bps[-1][0]}"

def test_absolute_step_conflict_no_cascade():
    """Subsequent absolute steps keep their declared t after a conflict."""
    spec = WaveformSpec(
        name='t', nominal_current=None, slew_rate=6e6, resolution=None,
        steps=[
            WaveformStep(kind='absolute', t=0.0, value=0.0),
            WaveformStep(kind='absolute', t=10e-6, value=420.0),  # conflict → pushed to 70us
            WaveformStep(kind='absolute', t=200e-6, value=360.0), # declared 200us, no conflict
        ]
    )
    with warnings.catch_warnings(record=True):
        warnings.simplefilter('always')
        bps = build_breakpoints(spec)
    t_vals = [p[0] for p in bps]
    assert any(abs(t - 200e-6) < 1e-9 for t in t_vals), \
        f"Expected 200us in {t_vals}"

def test_absolute_flat_before_ramp():
    """When ramp_start > current_t, a flat-hold point is inserted before the ramp."""
    spec = WaveformSpec(
        name='t', nominal_current=None, slew_rate=6e6, resolution=None,
        steps=[
            WaveformStep(kind='absolute', t=0.0, value=0.0),
            WaveformStep(kind='absolute', t=1.0, value=420.0),  # ramp_start = 1s-70us
        ]
    )
    bps = build_breakpoints(spec)
    t_vals = [p[0] for p in bps]
    a_vals = [p[1] for p in bps]
    ramp_start = 1.0 - 420.0 / 6e6
    idx = next(i for i, t in enumerate(t_vals) if abs(t - ramp_start) < 1e-9)
    assert abs(a_vals[idx] - 0.0) < 1e-9, f"Expected 0A at ramp_start, got {a_vals[idx]}"

def test_hold_after_absolute():
    """Mixed: absolute anchor at t=0, then hold step."""
    spec = WaveformSpec(
        name='t', nominal_current=None, slew_rate=6e6, resolution=None,
        steps=[
            WaveformStep(kind='absolute', t=0.0, value=0.0),
            WaveformStep(kind='hold', value=420.0, hold_duration=500e-6),
        ]
    )
    bps = build_breakpoints(spec)
    t_vals = [p[0] for p in bps]
    assert any(abs(t - 70e-6) < 1e-9 for t in t_vals)
    assert abs(t_vals[-1] - 570e-6) < 1e-9

# ── Task 6: Resampler + CSV ───────────────────────────────────────────────────

def test_resample_linear_ramp():
    """Simple 0→60A ramp over 10us, sampled at 1us."""
    bps = [(0.0, 0.0), (10e-6, 60.0)]
    t, a = resample(bps, 1e-6)
    assert len(t) == 10
    assert abs(a[0] - 0.0) < 1e-9
    assert abs(a[4] - 24.0) < 1.0    # midpoint of 0→60 at sample 4 = 24A
    assert abs(a[-1] - 54.0) < 1.0   # last sample before end (arange stops before end)

def test_resample_hold():
    """Ramp then flat hold: samples in hold region must equal target."""
    bps = [(0.0, 0.0), (10e-6, 60.0), (110e-6, 60.0)]
    t, a = resample(bps, 1e-6)
    for i, ti in enumerate(t):
        if ti > 12e-6:
            assert abs(a[i] - 60.0) < 1e-9, f"Expected 60A at t={ti:.3g}s, got {a[i]}"

def test_resample_grid_start_end():
    """Grid starts at first breakpoint and covers full duration."""
    bps = [(0.0, 0.0), (100e-6, 100.0)]
    t, a = resample(bps, 10e-6)
    assert abs(t[0] - 0.0) < 1e-15
    assert t[-1] <= 100e-6 + 1e-15

def test_export_csv_columns(tmp_path):
    """CSV output must have columns: time_s, time_ms, time_us, amplitude_A."""
    import pandas as pd
    bps = [(0.0, 0.0), (10e-6, 60.0), (110e-6, 60.0)]
    out = tmp_path / 'test.csv'
    export_csv(bps, dt=1e-6, output_path=out)
    df = pd.read_csv(out)
    assert list(df.columns) == ['time_s', 'time_ms', 'time_us', 'amplitude_A']
    assert len(df) == 110
    assert abs(df['amplitude_A'].max() - 60.0) < 1e-9

# ── Task 7: PWL + PLECS exporters ────────────────────────────────────────────

def test_export_pwl_format(tmp_path):
    """PWL file must contain SPICE + continuation syntax."""
    bps = [(0.0, 0.0), (70e-6, 420.0), (570e-6, 420.0)]
    out = tmp_path / 'test.pwl'
    export_pwl(bps, out, source_name='I_LOAD')
    text = out.read_text()
    assert 'I_LOAD 0 1 PWL(' in text
    assert text.count('+') >= 3          # at least one + per breakpoint
    assert '70.000000u' in text          # 70us formatted
    assert '420.000000' in text

def test_export_pwl_breakpoint_count(tmp_path):
    """PWL file must contain exactly as many data lines as breakpoints."""
    bps = [(0.0, 0.0), (70e-6, 420.0), (570e-6, 420.0), (580e-6, 360.0)]
    out = tmp_path / 'test.pwl'
    export_pwl(bps, out, source_name='I_LOAD')
    lines = [l for l in out.read_text().splitlines() if l.startswith('+') and 'u' in l]
    assert len(lines) == 4

def test_export_plecs_format(tmp_path):
    """PLECS file must contain x and f_x vectors."""
    bps = [(0.0, 0.0), (70e-6, 420.0), (570e-6, 420.0)]
    out = tmp_path / 'test_plecs.py'
    export_plecs(bps, out, name='fig3')
    text = out.read_text()
    assert 'x   = [' in text
    assert 'f_x = [' in text
    assert '7e-05' in text or '7.0e-05' in text or '0.00007' in text

def test_export_plecs_monotonic(tmp_path):
    """PLECS x vector must be monotonically increasing (no duplicates)."""
    bps = [(0.0, 0.0), (70e-6, 420.0), (570e-6, 420.0), (580e-6, 360.0)]
    out = tmp_path / 'test_plecs.py'
    export_plecs(bps, out, name='test')
    text = out.read_text()
    import ast
    x_line = next(l for l in text.splitlines() if l.startswith('x   = ['))
    x_vals = ast.literal_eval(x_line.split('=', 1)[1].strip())
    assert x_vals == sorted(x_vals)
    assert len(x_vals) == len(set(x_vals))  # no duplicate timestamps

def test_export_ltspice_pwl_format(tmp_path):
    """LTspice file must have two-column data lines and ; comments — no SPICE syntax."""
    bps = [(0.0, 0.0), (72e-6, 432.0), (500e-6, 432.0)]
    out = tmp_path / 'test_ltspice.pwl'
    export_ltspice_pwl(bps, out)
    text = out.read_text()
    assert 'I_LOAD' not in text          # no SPICE element line
    assert 'PWL(' not in text            # no inline PWL syntax
    assert '+ )' not in text             # no SPICE PWL continuation close
    assert ';' in text                   # comment header present
    # each breakpoint appears as a data line (non-comment, non-empty)
    data_lines = [l for l in text.splitlines() if l.strip() and not l.strip().startswith(';')]
    assert len(data_lines) == 3
    # first row is absolute; remaining rows are '+'-prefixed relative deltas
    assert not data_lines[0].lstrip().startswith('+'), "first row must be absolute"
    for ln in data_lines[1:]:
        assert ln.lstrip().startswith('+'), f"non-first row must start with '+': {ln!r}"

def test_export_ltspice_pwl_time_in_seconds(tmp_path):
    """LTspice file times must be plain seconds (no 'u' suffix on data lines)."""
    bps = [(72e-6, 432.0), (500e-6, 432.0)]
    out = tmp_path / 'test_ltspice.pwl'
    export_ltspice_pwl(bps, out)
    text = out.read_text()
    data_lines = [l for l in text.splitlines() if l.strip() and not l.strip().startswith(';')]
    for line in data_lines:
        t_str = line.split()[0]
        assert not t_str.endswith('u'), f"timestamp uses µs suffix, expected seconds: {t_str}"
    # 72µs = 7.2e-05 s — value must round-trip to the correct float
    first_t = float(data_lines[0].split()[0])
    assert abs(first_t - 72e-6) < 1e-12

# ── Relative-time exporters ──────────────────────────────────────────────────

def test_export_ltspice_pwl_emits_relative_deltas(tmp_path):
    from wavecraft import export_ltspice_pwl
    bps = [(0.0, 0.0), (0.0005, 420.0), (0.0055, 360.0)]
    out = tmp_path / "rel.pwl"
    export_ltspice_pwl(bps, out)
    text = out.read_text()
    # Drop comment lines and the header
    data_lines = [
        ln for ln in text.splitlines()
        if ln.strip() and not ln.lstrip().startswith(';')
    ]
    assert len(data_lines) == 3, data_lines
    # First row: absolute
    first_cols = data_lines[0].split()
    assert first_cols[0] == "0"
    assert first_cols[1] == "0"
    # Subsequent rows: '+'-prefixed
    second_cols = data_lines[1].split()
    assert second_cols[0].startswith("+"), second_cols
    assert abs(float(second_cols[0][1:]) - 0.0005) < 1e-15
    assert abs(float(second_cols[1]) - 420.0) < 1e-9
    third_cols = data_lines[2].split()
    assert third_cols[0].startswith("+"), third_cols
    assert abs(float(third_cols[0][1:]) - 0.005) < 1e-15


def test_export_pwl_default_is_absolute(tmp_path):
    from wavecraft import export_pwl
    bps = [(0.0, 0.0), (0.0005, 420.0), (0.0055, 360.0)]
    out = tmp_path / "abs.pwl"
    export_pwl(bps, out)
    text = out.read_text()
    # SPICE PWL continuation lines start with '+' in column 0.
    # Strip that and look at the time tokens that follow.
    body = [ln[1:].lstrip() for ln in text.splitlines() if ln.startswith('+')]
    data = [ln for ln in body if ln and ln[0].isdigit()]
    assert len(data) == 3
    for ln in data:
        first = ln.split()[0]
        assert not first.startswith('+'), f"unexpected '+' prefix: {first}"


def test_export_pwl_relative_time_true(tmp_path):
    from wavecraft import export_pwl
    bps = [(0.0, 0.0), (0.0005, 420.0), (0.0055, 360.0)]
    out = tmp_path / "rel.pwl"
    export_pwl(bps, out, relative_time=True)
    text = out.read_text()
    body = [ln[1:].lstrip() for ln in text.splitlines() if ln.startswith('+')]
    data = [ln for ln in body if ln and (ln[0].isdigit() or ln[0] == '+')]
    assert len(data) == 3
    # First row absolute (no '+' on time)
    assert not data[0].split()[0].startswith('+')
    # Subsequent rows have '+' prefix
    assert data[1].split()[0].startswith('+')
    assert data[2].split()[0].startswith('+')
    # Delta from (0.0005 - 0) = 500us; from (0.0055 - 0.0005) = 5000us
    d1 = float(data[1].split()[0].rstrip('u').lstrip('+'))
    d2 = float(data[2].split()[0].rstrip('u').lstrip('+'))
    assert abs(d1 - 500.0) < 1e-6
    assert abs(d2 - 5000.0) < 1e-6


def test_export_pwl_relative_time_aligns_with_absolute(tmp_path):
    """When relative_time=True, the 'u' suffix lands at the same column in
    every row — first row (absolute anchor) and all subsequent relative rows."""
    from wavecraft import export_pwl
    bps = [(0.0, 0.0), (0.0005, 420.0), (0.0055, 360.0)]
    out = tmp_path / "align.pwl"
    export_pwl(bps, out, relative_time=True)
    text = out.read_text()
    # SPICE continuation lines start with '+' in column 0; the data lines we want
    # have a numeric (or '+'-prefixed numeric) token followed by 'u'.
    data_lines = [
        ln for ln in text.splitlines()
        if ln.startswith('+') and 'u' in ln and 'PWL' not in ln and ')' not in ln
    ]
    assert len(data_lines) == 3, data_lines
    u_cols = [ln.index('u') for ln in data_lines]
    assert len(set(u_cols)) == 1, f"'u' columns not aligned: {u_cols}"


if __name__ == '__main__':
    print('=== Task 1: Data model ===')
    run_test('WaveformStep hold defaults', test_waveformstep_hold_defaults)
    run_test('WaveformStep absolute defaults', test_waveformstep_absolute_defaults)
    run_test('WaveformSpec defaults', test_waveformspec_defaults)

    print('\n=== Task 2: Unit parser ===')
    from wavecraft import parse_quantity
    run_test('parse 240A', test_parse_240A)
    run_test('parse 6A/us', test_parse_6A_per_us)
    run_test('parse 500us', test_parse_500us)
    run_test('parse 5ms', test_parse_5ms)
    run_test('parse 1s', test_parse_1s)
    run_test('parse 1000ms', test_parse_1000ms)
    run_test('parse 24mA', test_parse_24mA)
    run_test('resolve 175%', test_resolve_percent)
    run_test('resolve 360A', test_resolve_absolute_amps)
    run_test('resolve % no nominal raises', test_resolve_percent_no_nominal_raises)

    print('\n=== Task 3: YAML parser ===')
    run_test('parse_yaml globals', test_parse_yaml_globals)
    run_test('parse_yaml step count', test_parse_yaml_step_count)
    run_test('parse_yaml absolute step', test_parse_yaml_absolute_step)
    run_test('parse_yaml hold % step', test_parse_yaml_hold_percent_step)
    run_test('parse_yaml hold abs step', test_parse_yaml_hold_absolute_step)
    run_test('parse_yaml per-step slew', test_parse_yaml_per_step_slew)
    run_test('parse_yaml absolute timestamp', test_parse_yaml_absolute_timestamp)

    print('\n=== Task 4: Engine — hold steps ===')
    from wavecraft import build_breakpoints
    run_test('hold basic ramp+hold', test_hold_basic_ramp_and_hold)
    run_test('hold no delta no ramp', test_hold_no_delta_no_ramp)
    run_test('hold resolution fallback', test_hold_resolution_fallback_ramp)
    run_test('hold per-step slew override', test_hold_per_step_slew_override)
    run_test('hold sequence two steps', test_hold_sequence_two_steps)

    print('\n=== Task 5: Engine — absolute steps ===')
    run_test('absolute anchor only', test_absolute_step_anchor_only)
    run_test('absolute ramp ends at t', test_absolute_step_ramp_ends_at_t)
    run_test('absolute no slew pure linear', test_absolute_step_no_slew_pure_linear)
    run_test('absolute conflict pushed', test_absolute_step_conflict_pushed_forward)
    run_test('absolute conflict no cascade', test_absolute_step_conflict_no_cascade)
    run_test('absolute flat before ramp', test_absolute_flat_before_ramp)
    run_test('hold after absolute', test_hold_after_absolute)

    print('\n=== Task 6: Resampler + CSV ===')
    import tempfile
    from wavecraft import resample, export_csv
    tmp = Path(tempfile.mkdtemp())
    run_test('resample linear ramp', test_resample_linear_ramp)
    run_test('resample hold', test_resample_hold)
    run_test('resample grid start/end', test_resample_grid_start_end)
    run_test('export_csv columns', lambda: test_export_csv_columns(tmp))

    print('\n=== Task 7: PWL + PLECS exporters ===')
    from wavecraft import export_pwl, export_plecs, export_ltspice_pwl
    run_test('export_pwl format', lambda: test_export_pwl_format(tmp))
    run_test('export_pwl breakpoint count', lambda: test_export_pwl_breakpoint_count(tmp))
    run_test('export_plecs format', lambda: test_export_plecs_format(tmp))
    run_test('export_plecs monotonic', lambda: test_export_plecs_monotonic(tmp))
    run_test('export_ltspice_pwl format', lambda: test_export_ltspice_pwl_format(tmp))
    run_test('export_ltspice_pwl time in seconds', lambda: test_export_ltspice_pwl_time_in_seconds(tmp))

    print(f'\n{passed} passed, {failed} failed')
    sys.exit(1 if failed else 0)
