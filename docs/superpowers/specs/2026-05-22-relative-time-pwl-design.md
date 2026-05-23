# Relative-time PWL syntax — design

Date: 2026-05-22
Status: Approved (pending user spec review)

## Motivation

LTspice's PWL sources accept a relative time-delta shorthand
([Analog Devices article](https://www.analog.com/en/resources/technical-articles/ltspice-piecewise-linear-functions-for-voltage-current-sources.html)):

```
PWL(0 0 +1m 1 +1m 1 +1m 0)
```

Each `+dt` means "dt after the previous breakpoint". This improves readability when
many evenly-spaced or relatively-defined breakpoints are involved, and removes the need
to mentally add up timestamps when authoring or reviewing waveforms.

The current DSL supports two step kinds:

- `t: TIME, value: V` — absolute timestamp (linear interpolation from previous point)
- `hold: V, for: DUR` — ramp-then-hold (uses `slew_rate`)

`hold`/`for` already expresses a duration, but carries ramp/hold semantics tied to
`slew_rate`. There is no current way to express a pure PWL breakpoint as a delta from
the previous one. This spec adds that capability and propagates it to the LTspice
exporters.

## Scope

In scope:

1. New input syntax in `parser.py`: `t: "+DUR"` prefix form and explicit `dt: DUR` key.
2. Output changes in `exporters.py`:
   - `export_ltspice_pwl` (PWL FILE= data file): always emits `+tdelta` for non-first rows.
   - `export_pwl` (inline `PWL(...)`): absolute by default; relative when opted in.
3. Tests covering parse, export, and round-trip.
4. README updates and one example using the new syntax.

Out of scope:

- Changes to the internal `WaveformStep` model or `engine.py` (deltas resolve to
  absolute `t` at parse time).
- Changes to `export_csv` or `export_plecs` (their formats are inherently absolute).
- Negative relative deltas (rejected at parse time). Decreasing absolute `t:` timestamps are not rejected at parse time; the engine pushes conflicting breakpoints forward with a warning.

## Input syntax

Two equivalent forms, freely mixable with existing step kinds:

```yaml
steps:
  - {t: "0",        value: "0A"}
  - {t: "+1ms",     value: "1A"}      # form 1: '+' prefix on t:
  - {dt: "1ms",     value: "1A"}      # form 2: explicit dt: key
  - {dt: "1ms",     value: "0A"}
  - {hold: "240A",  for: "5ms"}       # existing hold/for still works
  - {t: "100ms",    value: "0A"}      # existing absolute t still works
```

### Semantics

- Resolved at parse time: `t_resolved = prev_step.t + delta`.
- Linear interpolation from the previous breakpoint to the resolved point (same as
  absolute `t:`). **No ramp/hold split, no `slew_rate` involvement** — a pure PWL
  breakpoint.
- For the **first step**, `prev_t = 0` (so a leading `dt: "1ms"` resolves to `t=1ms`).
- Per-step `slew_rate:` override is permitted and behaves identically to the
  absolute-`t:` case (existing engine logic).

### Validation

The parser raises `ValueError` with the step index for:

- Negative delta (`dt: "-1ms"` or `t: "+-1ms"`) — time must be monotonically increasing.
- Both `t:` and `dt:` set on the same step.
- `dt:` without `value:`.
- A `+`-prefixed `t:` value that fails to parse as a duration.

## Output syntax

### `export_ltspice_pwl` (PWL FILE= data file)

**Behavior change: always emits relative deltas.** LTspice is the only consumer of
this exporter (the file extension and format are LTspice-specific), and the
`+tdelta` form is preferred for readability.

First row is the absolute anchor; subsequent rows use `+<dt>` in seconds.

Example (rendered for breakpoints `[(0, 0), (5e-4, 420), (5.5e-3, 360)]`):

```
; Generated: 2026-05-22
; name: example | nominal: 240A | slew: 6A/us
; time(s)              current(A)
  0                     0
  +0.0005               420
  +0.005                360
```

Time-column format follows the existing `%.10g` numeric formatter, with a literal
`+` prefix prepended for all non-first rows.

### `export_pwl` (inline SPICE `PWL(...)`)

**Default: unchanged** (absolute timestamps, preserving ngspice compatibility).

New opt-in: a `relative_time: bool = False` keyword argument. When `True`, non-first
breakpoints are emitted with a `+` prefix in microsecond units, preserving the
existing `u` suffix.

Absolute (default):

```
I_LOAD 0 1 PWL(
+         0.000000u    0.000000
+       500.000000u  420.000000
+      5500.000000u  360.000000
+ )
```

Relative (`relative_time=True`):

```
I_LOAD 0 1 PWL(
+         0.000000u    0.000000
+      +500.000000u  420.000000
+     +5000.000000u  360.000000
+ )
```

## CLI

New flag on `wavecraft` CLI: `--relative-time` (boolean).

- Passes `relative_time=True` to `export_pwl`.
- Has no effect on `export_ltspice_pwl` (which is always relative under this design).
- Has no effect on `export_csv` or `export_plecs`.

The README's CLI table is updated to document the flag.

## Files touched

- `src/wavecraft/parser.py` — `+t` prefix and `dt:` key handling; validation.
- `src/wavecraft/exporters.py` — `export_ltspice_pwl` always relative;
  `export_pwl` gains `relative_time` kwarg.
- `src/wavecraft/cli.py` — `--relative-time` flag plumbed to `export_pwl`.
- `tests/` — parser tests, exporter tests, round-trip test.
- `README.md` — step-kind table gains `dt:` row; `t:` row notes `+` prefix;
  CLI table gains `--relative-time`; example added.
- `examples/` — one new or modified example demonstrating `dt:`.

## Testing

Parser:
- `{dt: "1ms"}` and `{t: "+1ms"}` produce identical resolved `t` and `value`.
- First-step `dt:` or `t: "+..."` resolves against `prev_t = 0`.
- Negative delta → `ValueError` mentioning the step index.
- Both `t:` and `dt:` on one step → `ValueError`.
- `dt:` without `value:` → `ValueError`.
- Mixed sequence (`t`, `+t`, `dt`, `hold`) round-trips to the expected absolute
  breakpoints.
- Per-step `slew_rate:` works with `dt:` and `+t` forms.

Exporters:
- `export_ltspice_pwl` emits absolute first row, `+`-prefixed subsequent rows.
- `export_pwl` default output unchanged (regression guard).
- `export_pwl(relative_time=True)` emits `+`-prefixed subsequent rows.
- LTspice example `PWL(0 0 +1m 1 +1m 1 +1m 0)` reproduced from a YAML using
  `dt:` and exported through `export_pwl(relative_time=True)` matches.

Round-trip:
- Author YAML with `dt:`, build breakpoints, export via each format, then parse the
  data back from the LTspice FILE= output (parsing the file is test-side, not a
  production feature) — resulting breakpoints match the originals within float
  tolerance.

## Migration / compatibility

- All existing YAML files continue to parse and produce identical output for
  `export_csv`, `export_pwl` (default), and `export_plecs`.
- `export_ltspice_pwl` output format changes for any user who reads the file with
  custom tooling. LTspice itself handles both formats, so simulation behavior is
  unaffected. This is called out in the README and a brief changelog note.

## Open questions

None — all design decisions resolved during brainstorming:

1. Both `t: "+DUR"` and `dt: DUR` supported (user choice).
2. First step's `prev_t` defaults to 0 (user confirmed).
3. Both LTspice exporters support relative output (user choice).
4. `export_pwl` keeps absolute default + `--relative-time` opt-in for ngspice
   compatibility (user choice).
