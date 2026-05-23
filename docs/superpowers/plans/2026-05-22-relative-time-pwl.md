# Relative-time PWL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add LTspice-style relative time-delta syntax (`t: "+1ms"` and `dt: 1ms`) to the wavecraft YAML DSL, and propagate the shorthand to the LTspice exporters.

**Architecture:** Deltas resolve to absolute time at parse time inside `parser.py`; `WaveformStep`, `engine.py`, and the CSV/PLECS exporters are untouched. `export_ltspice_pwl` always emits `+tdelta` (LTspice-only target). `export_pwl` gains an opt-in `relative_time` kwarg so the default output stays ngspice-compatible; a `--relative-time` CLI flag plumbs it.

**Tech Stack:** Python 3.10+, pytest, PyYAML, pint.

**Reference:** `docs/superpowers/specs/2026-05-22-relative-time-pwl-design.md`

**Test runner:** All tests live in the single file `tests/test_waveform_dsl.py`. Run individual tests with:

```bash
pytest tests/test_waveform_dsl.py::test_<name> -v
```

Run the full suite with:

```bash
pytest tests/test_waveform_dsl.py -v
```

If the package is not yet installed editable, run `pip install -e .` from the repo root once before starting.

---

## File Structure

- **Modify** `src/wavecraft/parser.py` — accept `t: "+DUR"` and `dt:` step syntax; track running `prev_t`; validate.
- **Modify** `src/wavecraft/exporters.py` — `export_ltspice_pwl` always emits relative deltas; `export_pwl` gains `relative_time` kwarg.
- **Modify** `src/wavecraft/cli.py` — `--relative-time` flag, passed through to `export_pwl`.
- **Modify** `tests/test_waveform_dsl.py` — parser tests, exporter tests, integration test.
- **Modify** `README.md` — document `dt:`, `+` prefix on `t:`, and `--relative-time`.
- **Create** `examples/relative_pulse.yaml` — small example demonstrating `dt:` syntax.

---

### Task 1: Parser — accept `t: "+DUR"` prefix form

**Files:**
- Modify: `src/wavecraft/parser.py:78-106` (the `for i, step_raw in enumerate(...)` loop)
- Test: `tests/test_waveform_dsl.py`

Introduce a running `prev_t` variable in `parse_yaml`. When a step's `t:` value starts with `+`, strip the prefix, parse it as a duration, and add it to `prev_t`. Update `prev_t` to the resolved absolute time at the end of every step that has a known absolute t. For `hold` steps `prev_t` is left unchanged (engine resolves hold times later; the spec scopes delta semantics to PWL-style steps only).

- [ ] **Step 1: Write the failing test**

Add to `tests/test_waveform_dsl.py` (under the "Task 3: YAML parser" section, before the engine tests):

```python
# ── Relative time-delta syntax ────────────────────────────────────────────────

def test_parse_yaml_t_plus_prefix(tmp_path):
    from wavecraft import parse_yaml
    yaml_text = """
name: rel_t_test
steps:
  - {t: "0", value: "0A"}
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_waveform_dsl.py::test_parse_yaml_t_plus_prefix -v`
Expected: FAIL — `pint` will raise on the `+1ms` string, or the absolute path will produce wrong `t` values.

- [ ] **Step 3: Implement `+` prefix handling**

Edit `src/wavecraft/parser.py`. Replace the body of `parse_yaml` from the start of the steps loop through the end of the function (currently lines 78-114) with:

```python
    steps: list[WaveformStep] = []
    prev_t: float = 0.0
    for i, step_raw in enumerate(raw.get('steps', [])):
        step_slew: float | None = None
        if 'slew_rate' in step_raw:
            step_slew = parse_quantity(step_raw['slew_rate']).to('ampere/second').magnitude

        if 'hold' in step_raw:
            value = _resolve_value(str(step_raw['hold']), nominal_current)
            duration = parse_quantity(step_raw['for']).to('second').magnitude
            steps.append(WaveformStep(
                kind='hold',
                value=value,
                hold_duration=duration,
                slew_rate=step_slew,
            ))
            # prev_t intentionally not advanced — hold steps don't have an absolute t
            # at parse time; the engine resolves them later.
        elif 't' in step_raw:
            t_raw = str(step_raw['t']).strip()
            if t_raw.startswith('+'):
                delta = parse_quantity(t_raw[1:]).to('second').magnitude
                t = prev_t + delta
            else:
                t = parse_quantity(t_raw).to('second').magnitude
            value = _resolve_value(str(step_raw['value']), nominal_current)
            steps.append(WaveformStep(
                kind='absolute',
                t=t,
                value=value,
                slew_rate=step_slew,
            ))
            prev_t = t
        else:
            raise ValueError(
                f"Step {i}: must have 'hold'+'for' or 't'+'value' keys. "
                f"Got: {list(step_raw.keys())}"
            )

    return WaveformSpec(
        name=name,
        nominal_current=nominal_current,
        slew_rate=slew_rate,
        resolution=resolution,
        steps=steps,
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_waveform_dsl.py::test_parse_yaml_t_plus_prefix -v`
Expected: PASS.

- [ ] **Step 5: Run full suite to confirm no regressions**

Run: `pytest tests/test_waveform_dsl.py -v`
Expected: all existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/wavecraft/parser.py tests/test_waveform_dsl.py
git commit -m "feat(parser): accept '+DUR' prefix on t: for relative time deltas"
```

---

### Task 2: Parser — accept `dt:` key

**Files:**
- Modify: `src/wavecraft/parser.py` (steps loop)
- Test: `tests/test_waveform_dsl.py`

A `{dt: DUR, value: V}` step is parsed identically to `{t: "+DUR", value: V}` — resolves to `prev_t + dt` and produces an `absolute` `WaveformStep`. Equivalence is verified directly.

- [ ] **Step 1: Write the failing test**

Add to `tests/test_waveform_dsl.py` just below `test_parse_yaml_t_plus_prefix`:

```python
def test_parse_yaml_dt_key(tmp_path):
    from wavecraft import parse_yaml
    yaml_text = """
name: dt_test
steps:
  - {t: "0", value: "0A"}
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
    yaml_a = "name: a\nsteps:\n  - {t: '0', value: '0A'}\n  - {t: '+1ms', value: '1A'}\n"
    yaml_b = "name: b\nsteps:\n  - {t: '0', value: '0A'}\n  - {dt: '1ms', value: '1A'}\n"
    pa = tmp_path / "a.yaml"; pa.write_text(yaml_a)
    pb = tmp_path / "b.yaml"; pb.write_text(yaml_b)
    sa = parse_yaml(pa); sb = parse_yaml(pb)
    assert sa.steps[1].t == sb.steps[1].t
    assert sa.steps[1].value == sb.steps[1].value
    assert sa.steps[1].kind == sb.steps[1].kind
```

Also add a test for the first-step case (prev_t defaults to 0):

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_waveform_dsl.py::test_parse_yaml_dt_key tests/test_waveform_dsl.py::test_parse_yaml_dt_equivalent_to_t_plus tests/test_waveform_dsl.py::test_parse_yaml_dt_first_step -v`
Expected: FAIL — `dt` key not yet recognized; falls through to the `else` ValueError branch.

- [ ] **Step 3: Implement `dt:` branch**

In `src/wavecraft/parser.py`, inside the steps loop, add a new branch above the final `else`. Change:

```python
        elif 't' in step_raw:
            t_raw = str(step_raw['t']).strip()
            ...
            prev_t = t
        else:
            raise ValueError(...)
```

to:

```python
        elif 't' in step_raw:
            t_raw = str(step_raw['t']).strip()
            if t_raw.startswith('+'):
                delta = parse_quantity(t_raw[1:]).to('second').magnitude
                t = prev_t + delta
            else:
                t = parse_quantity(t_raw).to('second').magnitude
            value = _resolve_value(str(step_raw['value']), nominal_current)
            steps.append(WaveformStep(
                kind='absolute',
                t=t,
                value=value,
                slew_rate=step_slew,
            ))
            prev_t = t
        elif 'dt' in step_raw:
            delta = parse_quantity(str(step_raw['dt'])).to('second').magnitude
            t = prev_t + delta
            value = _resolve_value(str(step_raw['value']), nominal_current)
            steps.append(WaveformStep(
                kind='absolute',
                t=t,
                value=value,
                slew_rate=step_slew,
            ))
            prev_t = t
        else:
            raise ValueError(
                f"Step {i}: must have 'hold'+'for', 't'+'value', or 'dt'+'value' keys. "
                f"Got: {list(step_raw.keys())}"
            )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_waveform_dsl.py::test_parse_yaml_dt_key tests/test_waveform_dsl.py::test_parse_yaml_dt_equivalent_to_t_plus tests/test_waveform_dsl.py::test_parse_yaml_dt_first_step -v`
Expected: PASS.

- [ ] **Step 5: Run full suite**

Run: `pytest tests/test_waveform_dsl.py -v`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/wavecraft/parser.py tests/test_waveform_dsl.py
git commit -m "feat(parser): accept dt: key as explicit relative time delta"
```

---

### Task 3: Parser — validation errors

**Files:**
- Modify: `src/wavecraft/parser.py` (steps loop)
- Test: `tests/test_waveform_dsl.py`

Reject:

1. Negative delta (`dt: "-1ms"` or `t: "+-1ms"`) — time must be monotonic.
2. Both `t:` and `dt:` set on one step.
3. `dt:` without `value:`.

All errors raise `ValueError` and mention the step index.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_waveform_dsl.py`:

```python
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
        assert "1" in str(e)  # step index appears
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
        assert "1" in str(e)
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
        assert "0" in str(e)
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
    except (ValueError, KeyError) as e:
        assert "0" in str(e) or "value" in str(e).lower()
        return
    assert False, "Expected error for dt without value"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_waveform_dsl.py -k "negative_dt or negative_t_plus or t_and_dt_conflict or dt_without_value" -v`
Expected: FAIL — no validation in place yet (negative deltas silently produce backward time; conflict is silently accepted; missing value raises a `KeyError` deep inside `_resolve_value` rather than a clear `ValueError` mentioning the step index).

- [ ] **Step 3: Add validation to parser**

In `src/wavecraft/parser.py`, modify the steps loop. At the top of the loop body (before the `if 'hold' in step_raw:` line), add the conflict check. Inside the `t` and `dt` branches, add the negative-delta check. Inside the `dt` branch, add the missing-value check.

Replace the steps loop body (from `for i, step_raw in ...` down to its closing) with:

```python
    steps: list[WaveformStep] = []
    prev_t: float = 0.0
    for i, step_raw in enumerate(raw.get('steps', [])):
        if 't' in step_raw and 'dt' in step_raw:
            raise ValueError(
                f"Step {i}: cannot specify both 't' and 'dt'. Choose one."
            )

        step_slew: float | None = None
        if 'slew_rate' in step_raw:
            step_slew = parse_quantity(step_raw['slew_rate']).to('ampere/second').magnitude

        if 'hold' in step_raw:
            value = _resolve_value(str(step_raw['hold']), nominal_current)
            duration = parse_quantity(step_raw['for']).to('second').magnitude
            steps.append(WaveformStep(
                kind='hold',
                value=value,
                hold_duration=duration,
                slew_rate=step_slew,
            ))
        elif 't' in step_raw:
            t_raw = str(step_raw['t']).strip()
            if t_raw.startswith('+'):
                delta = parse_quantity(t_raw[1:]).to('second').magnitude
                if delta < 0:
                    raise ValueError(
                        f"Step {i}: relative time delta must be non-negative, got {t_raw!r}."
                    )
                t = prev_t + delta
            else:
                t = parse_quantity(t_raw).to('second').magnitude
            value = _resolve_value(str(step_raw['value']), nominal_current)
            steps.append(WaveformStep(
                kind='absolute',
                t=t,
                value=value,
                slew_rate=step_slew,
            ))
            prev_t = t
        elif 'dt' in step_raw:
            if 'value' not in step_raw:
                raise ValueError(
                    f"Step {i}: 'dt' step requires a 'value' key."
                )
            delta = parse_quantity(str(step_raw['dt'])).to('second').magnitude
            if delta < 0:
                raise ValueError(
                    f"Step {i}: 'dt' must be non-negative, got {step_raw['dt']!r}."
                )
            t = prev_t + delta
            value = _resolve_value(str(step_raw['value']), nominal_current)
            steps.append(WaveformStep(
                kind='absolute',
                t=t,
                value=value,
                slew_rate=step_slew,
            ))
            prev_t = t
        else:
            raise ValueError(
                f"Step {i}: must have 'hold'+'for', 't'+'value', or 'dt'+'value' keys. "
                f"Got: {list(step_raw.keys())}"
            )

    return WaveformSpec(
        name=name,
        nominal_current=nominal_current,
        slew_rate=slew_rate,
        resolution=resolution,
        steps=steps,
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_waveform_dsl.py -k "negative_dt or negative_t_plus or t_and_dt_conflict or dt_without_value" -v`
Expected: PASS.

- [ ] **Step 5: Run full suite**

Run: `pytest tests/test_waveform_dsl.py -v`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/wavecraft/parser.py tests/test_waveform_dsl.py
git commit -m "feat(parser): validate negative deltas and conflicting t/dt keys"
```

---

### Task 4: Exporter — `export_ltspice_pwl` always emits relative deltas

**Files:**
- Modify: `src/wavecraft/exporters.py:52-70` (the `export_ltspice_pwl` function)
- Test: `tests/test_waveform_dsl.py`

First row stays absolute (anchor). Each subsequent row's time column is prefixed with `+` and contains the delta from the previous row, formatted with the same `%.10g` precision.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_waveform_dsl.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_waveform_dsl.py::test_export_ltspice_pwl_emits_relative_deltas -v`
Expected: FAIL — current exporter emits absolute times without `+` prefix.

- [ ] **Step 3: Update `export_ltspice_pwl`**

In `src/wavecraft/exporters.py`, replace the body of the `for t_s, amp_a in bps:` loop and the header comment so the function becomes:

```python
def export_ltspice_pwl(
    bps: list[tuple[float, float]],
    output_path: str | Path,
    spec: WaveformSpec | None = None,
) -> None:
    """Write breakpoints as an LTspice PWL FILE= compatible data file.

    First row is the absolute anchor; subsequent rows use LTspice's '+tdelta'
    relative-time shorthand.
    """
    from datetime import date
    with open(output_path, 'w') as f:
        f.write(f"; Generated: {date.today()}\n")
        if spec is not None:
            parts = [f"name: {spec.name}"]
            if spec.nominal_current is not None:
                parts.append(f"nominal: {spec.nominal_current:.6g}A")
            if spec.slew_rate is not None:
                parts.append(f"slew: {spec.slew_rate/1e6:.6g}A/us")
            f.write(f"; {' | '.join(parts)}\n")
        f.write("; time(s)              current(A)\n")
        prev_t: float | None = None
        for t_s, amp_a in bps:
            if prev_t is None:
                f.write(f"  {t_s:<20.10g}  {amp_a:.10g}\n")
            else:
                delta = t_s - prev_t
                f.write(f"  +{delta:<19.10g}  {amp_a:.10g}\n")
            prev_t = t_s
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_waveform_dsl.py::test_export_ltspice_pwl_emits_relative_deltas -v`
Expected: PASS.

- [ ] **Step 5: Run full suite**

Run: `pytest tests/test_waveform_dsl.py -v`
Expected: all tests pass. (Existing exporter tests, if any, may need adjustment — verify and update them as needed in the same commit.)

- [ ] **Step 6: Commit**

```bash
git add src/wavecraft/exporters.py tests/test_waveform_dsl.py
git commit -m "feat(exporters): export_ltspice_pwl emits '+tdelta' for non-first rows"
```

---

### Task 5: Exporter — `export_pwl` gains `relative_time` kwarg

**Files:**
- Modify: `src/wavecraft/exporters.py:27-49` (the `export_pwl` function)
- Test: `tests/test_waveform_dsl.py`

Default behavior unchanged (absolute, ngspice-compatible). When `relative_time=True`, non-first rows render with a `+` prefix on the time column. Microsecond suffix `u` is preserved.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_waveform_dsl.py`:

```python
def test_export_pwl_default_is_absolute(tmp_path):
    from wavecraft import export_pwl
    bps = [(0.0, 0.0), (0.0005, 420.0), (0.0055, 360.0)]
    out = tmp_path / "abs.pwl"
    export_pwl(bps, out)
    text = out.read_text()
    # No '+' should appear in any time column (only as the SPICE line-continuation
    # marker at column 0); strip continuations and confirm.
    body = [ln[1:].lstrip() for ln in text.splitlines() if ln.startswith('+')]
    # Drop the closing ')' line
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_waveform_dsl.py::test_export_pwl_default_is_absolute tests/test_waveform_dsl.py::test_export_pwl_relative_time_true -v`
Expected: `test_export_pwl_default_is_absolute` should already PASS (existing behavior). `test_export_pwl_relative_time_true` should FAIL (kwarg not accepted yet — `TypeError`).

- [ ] **Step 3: Add `relative_time` kwarg**

In `src/wavecraft/exporters.py`, replace `export_pwl` with:

```python
def export_pwl(
    bps: list[tuple[float, float]],
    output_path: str | Path,
    source_name: str = 'I_LOAD',
    spec: WaveformSpec | None = None,
    relative_time: bool = False,
) -> None:
    """Write breakpoints as a SPICE PWL current source definition.

    When relative_time=True, non-first breakpoints are emitted with a '+' prefix
    on the time column (LTspice-only shorthand; ngspice does not accept it).
    """
    from datetime import date
    with open(output_path, 'w') as f:
        f.write(f"* Generated: {date.today()}\n")
        if spec is not None:
            parts = [f"name: {spec.name}"]
            if spec.nominal_current is not None:
                parts.append(f"nominal: {spec.nominal_current:.6g}A")
            if spec.slew_rate is not None:
                parts.append(f"slew: {spec.slew_rate/1e6:.6g}A/us")
            if spec.resolution is not None:
                parts.append(f"resolution: {spec.resolution*1e6:.6g}us")
            f.write(f"* {' | '.join(parts)}\n")
        f.write(f"{source_name} 0 1 PWL(\n")
        prev_t: float | None = None
        for t_s, amp_a in bps:
            if relative_time and prev_t is not None:
                delta_us = (t_s - prev_t) * 1e6
                time_token = f"+{delta_us:.6f}"
                f.write(f"+ {time_token:>14}u  {amp_a:14.6f}\n")
            else:
                f.write(f"+  {t_s * 1e6:14.6f}u  {amp_a:14.6f}\n")
            prev_t = t_s
        f.write("+ )\n")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_waveform_dsl.py::test_export_pwl_default_is_absolute tests/test_waveform_dsl.py::test_export_pwl_relative_time_true -v`
Expected: PASS.

- [ ] **Step 5: Run full suite**

Run: `pytest tests/test_waveform_dsl.py -v`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/wavecraft/exporters.py tests/test_waveform_dsl.py
git commit -m "feat(exporters): add relative_time kwarg to export_pwl"
```

---

### Task 6: CLI — `--relative-time` flag

**Files:**
- Modify: `src/wavecraft/cli.py` (argparse setup and `_run` signature)
- Test: `tests/test_waveform_dsl.py`

Add `--relative-time` boolean flag. Pass through to `export_pwl` via the `_run` function. Does not affect `export_ltspice_pwl`, `export_csv`, or `export_plecs`.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_waveform_dsl.py`:

```python
def test_cli_relative_time_flag(tmp_path):
    from wavecraft.cli import main
    yaml_text = """
name: cli_rel_test
steps:
  - {t: "0", value: "0A"}
  - {dt: "1ms", value: "1A"}
"""
    yp = tmp_path / "cli_rel.yaml"
    yp.write_text(yaml_text)
    main([str(yp), "--out-dir", str(tmp_path), "--formats", "pwl", "--relative-time"])
    out = tmp_path / "cli_rel_test.pwl"
    assert out.exists()
    text = out.read_text()
    # Second data row should carry a '+' prefix on the time column.
    body = [ln[1:].lstrip() for ln in text.splitlines() if ln.startswith('+')]
    data = [ln for ln in body if ln and (ln[0].isdigit() or ln[0] == '+')]
    assert len(data) == 2
    assert data[1].split()[0].startswith('+'), data[1]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_waveform_dsl.py::test_cli_relative_time_flag -v`
Expected: FAIL — argparse will reject `--relative-time` as an unrecognized argument.

- [ ] **Step 3: Add the flag**

In `src/wavecraft/cli.py`, update the signature and body. Change the `_run` signature from:

```python
def _run(spec: WaveformSpec, out_dir: Path, formats: list[str], dt_override: float | None) -> list[tuple[float, float]]:
```

to:

```python
def _run(
    spec: WaveformSpec,
    out_dir: Path,
    formats: list[str],
    dt_override: float | None,
    relative_time: bool = False,
) -> list[tuple[float, float]]:
```

Change the `export_pwl(...)` call inside `_run` from:

```python
        export_pwl(bps, path, source_name='I_LOAD', spec=spec)
```

to:

```python
        export_pwl(bps, path, source_name='I_LOAD', spec=spec, relative_time=relative_time)
```

In `main`, add the argparse argument just below the existing `--plot` argument:

```python
    parser.add_argument('--relative-time', action='store_true',
                        help='Emit relative +tdelta times in the inline PWL output '
                             '(LTspice-only; ngspice does not accept this form)')
```

And update the `_run(...)` call from:

```python
    bps = _run(spec, out_dir, formats, dt_override)
```

to:

```python
    bps = _run(spec, out_dir, formats, dt_override, relative_time=args.relative_time)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_waveform_dsl.py::test_cli_relative_time_flag -v`
Expected: PASS.

- [ ] **Step 5: Run full suite**

Run: `pytest tests/test_waveform_dsl.py -v`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/wavecraft/cli.py tests/test_waveform_dsl.py
git commit -m "feat(cli): add --relative-time flag for inline PWL output"
```

---

### Task 7: Integration — reproduce LTspice article example

**Files:**
- Test: `tests/test_waveform_dsl.py`

End-to-end check: a YAML using `dt:` produces the same breakpoints `(0,0), (1ms,1), (2ms,1), (3ms,0)` as the LTspice example `PWL(0 0 +1m 1 +1m 1 +1m 0)`, and the inline relative-time PWL output contains the expected `+1000.000000u` delta tokens.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_waveform_dsl.py`:

```python
def test_ltspice_article_example_roundtrip(tmp_path):
    """Reproduce PWL(0 0 +1m 1 +1m 1 +1m 0) from the Analog article."""
    from wavecraft import parse_yaml, build_breakpoints, export_pwl
    yaml_text = """
name: ltspice_article
steps:
  - {t: "0", value: "0A"}
  - {dt: "1ms", value: "1A"}
  - {dt: "1ms", value: "1A"}
  - {dt: "1ms", value: "0A"}
"""
    yp = tmp_path / "article.yaml"
    yp.write_text(yaml_text)
    spec = parse_yaml(yp)
    bps = build_breakpoints(spec)
    # Expect exactly four breakpoints at 0, 1ms, 2ms, 3ms with the listed values.
    expected = [(0.0, 0.0), (1e-3, 1.0), (2e-3, 1.0), (3e-3, 0.0)]
    assert len(bps) == len(expected), bps
    for got, exp in zip(bps, expected):
        assert abs(got[0] - exp[0]) < 1e-12, (got, exp)
        assert abs(got[1] - exp[1]) < 1e-12, (got, exp)

    out = tmp_path / "article.pwl"
    export_pwl(bps, out, relative_time=True)
    text = out.read_text()
    # Three relative deltas of 1000.000000 microseconds.
    assert text.count("+1000.000000u") == 3, text
```

- [ ] **Step 2: Run test to verify it passes (no new code needed if Tasks 2 and 5 are correct)**

Run: `pytest tests/test_waveform_dsl.py::test_ltspice_article_example_roundtrip -v`
Expected: PASS. If it FAILS, debug Task 2 (parser `dt:`) or Task 5 (export_pwl relative formatting) — do not add new production code in this task.

- [ ] **Step 3: Commit**

```bash
git add tests/test_waveform_dsl.py
git commit -m "test: reproduce LTspice article PWL example end-to-end"
```

---

### Task 8: Docs and example YAML

**Files:**
- Modify: `README.md`
- Create: `examples/relative_pulse.yaml`

Document the new step kinds and CLI flag; add a small example file. README updates target the **Step kinds** table and the **CLI reference** block.

- [ ] **Step 1: Update the Step kinds table in README**

In `README.md`, replace the **Step kinds** table with:

```markdown
| Keys | Meaning |
|---|---|
| `hold: VALUE, for: DURATION` | Ramp to VALUE (using slew), then hold for DURATION |
| `t: TIME, value: VALUE` | Reach VALUE at absolute timestamp TIME. TIME may be prefixed with `+` to mean "DURATION after the previous step's t" |
| `dt: DURATION, value: VALUE` | Reach VALUE at `prev_t + DURATION`. Equivalent to `t: "+DURATION"` |
| `slew_rate: RATE` | Optional per-step slew override (any step kind above) |
```

- [ ] **Step 2: Update the CLI reference block in README**

Replace the `wavecraft INPUT ...` usage block in README with:

````markdown
```
wavecraft INPUT [--out-dir DIR] [--dt TIME] [--formats LIST] [--plot] [--relative-time]

  INPUT             Path to .yaml waveform definition
  --out-dir DIR     Output directory (default: same dir as input)
  --dt TIME         CSV resampling period override, e.g. 100ns
  --formats LIST    Comma-separated: csv,pwl,plecs,ltspice (default: all four)
  --plot            Show matplotlib preview (requires matplotlib)
  --relative-time   Emit '+tdelta' times in inline PWL output (LTspice-only;
                    ngspice does not accept this form). The LTspice FILE= output
                    (--formats ltspice) always uses relative deltas.
```
````

- [ ] **Step 3: Add an example YAML**

Create `examples/relative_pulse.yaml`:

```yaml
# Three 1ms unit pulses defined with relative time deltas.
# Reproduces the LTspice article example: PWL(0 0 +1m 1 +1m 1 +1m 0)
name: relative_pulse
steps:
  - {t: "0",    value: "0A"}
  - {dt: "1ms", value: "1A"}
  - {dt: "1ms", value: "1A"}
  - {dt: "1ms", value: "0A"}
```

- [ ] **Step 4: Sanity-check the example builds**

Run: `wavecraft examples/relative_pulse.yaml --out-dir /tmp/wc-check --formats pwl,ltspice --relative-time`
Expected: two files written (`relative_pulse.pwl`, `relative_pulse_ltspice.pwl`). Inspect to confirm `+tdelta` tokens appear.

```bash
grep '+' /tmp/wc-check/relative_pulse.pwl
grep '+' /tmp/wc-check/relative_pulse_ltspice.pwl
```

Expected: at least three `+1000.000000u` lines in the inline file; at least three `+0.001` lines in the FILE= output.

- [ ] **Step 5: Commit**

```bash
git add README.md examples/relative_pulse.yaml
git commit -m "docs: document relative-time PWL syntax and add example"
```

---

## Final verification

- [ ] Run the full test suite once more:

```bash
pytest tests/test_waveform_dsl.py -v
```

Expected: all tests pass, including all new tests added across tasks 1-7.

- [ ] Confirm no unintended files were modified:

```bash
git status
```

Expected: working tree clean.
