# wavecraft

YAML-driven piecewise-linear waveform generator for circuit simulators — outputs CSV, SPICE PWL, LTspice `PWL FILE=`, and PLECS 1D lookup tables.

## What it does

Define a load current waveform in YAML — with slew rates, hold times, and percentage amplitudes — and generate ready-to-use stimulus files for your simulator. Supports both absolute-timestamp steps (`t`+`value`) and duration-relative steps (`hold`+`for`), with per-step slew-rate overrides and automatic conflict resolution when a slew constraint pushes a breakpoint forward.

## Install

```bash
pip install wavecraft          # once published to PyPI
pip install -e ".[dev]"           # development install from source
```

## Quick start

```bash
wavecraft examples/nvidia_pulse.yaml --formats ltspice,pwl
```

```
Loading: examples/nvidia_pulse.yaml
  Name        : nvidia_gpu_pulse
  Steps       : 10
  Breakpoints : 10
  Duration    : 128.00 µs  (0.128 ms)
  Peak        : ...
  Saved PWL      : examples/nvidia_gpu_pulse.pwl
  Saved LTspice  : examples/nvidia_gpu_pulse_ltspice.pwl
```

## YAML format

### Top-level keys

| Key | Type | Description |
|---|---|---|
| `name` | string | Output filename stem |
| `nominal_current` | quantity | 100% reference, e.g. `"240A"` |
| `slew_rate` | quantity | Global slew rate, e.g. `"6A/us"` |
| `resolution` | quantity | CSV sampling period + ramp slot fallback when no slew, e.g. `"1us"` |
| `steps` | list | Sequence of waveform steps (see below) |

### Step kinds

| Keys | Meaning |
|---|---|
| `hold: VALUE, for: DURATION` | Ramp to VALUE (using slew), then hold for DURATION |
| `t: TIME, value: VALUE` | Reach VALUE at absolute timestamp TIME. TIME may be prefixed with `+` to mean "DURATION after the previous step's t" |
| `dt: DURATION, value: VALUE` | Reach VALUE at `prev_t + DURATION`. Equivalent to `t: "+DURATION"` |
| `slew_rate: RATE` | Optional per-step slew override (any step kind above) |

**VALUE** accepts: `"240A"`, `"175%"` (of `nominal_current`), `"24mA"`  
**TIME / DURATION** accept: `"500us"`, `"5ms"`, `"1s"`, `"100ns"`

### Example

```yaml
name: my_load_step
nominal_current: "240A"
slew_rate: "6A/us"
resolution: "1us"

steps:
  - {t: "0us",    value: "0A"}
  - {hold: "175%", for: "500us"}
  - {hold: "360A", for: "5ms"}
  - {t: "1s",     value: "0A"}
```

## Output formats

| Format | Extension | Use |
|---|---|---|
| CSV | `.csv` | Columns: `time_s`, `time_ms`, `time_us`, `amplitude_A` — resampled at `resolution` |
| SPICE PWL | `.pwl` | Inline `PWL(...)` element for LTspice / ngspice |
| LTspice PWL FILE= | `_ltspice.pwl` | Two-column `time(s) current(A)` data file |
| PLECS | `_plecs.py` | `x` and `f_x` vectors for a 1D Lookup Table block |

## CLI reference

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

## Python API

```python
from wavecraft import parse_yaml, build_breakpoints, export_ltspice_pwl

spec = parse_yaml("examples/nvidia_pulse.yaml")
bps  = build_breakpoints(spec)
export_ltspice_pwl(bps, "output.pwl", spec=spec)
```

Full public API: `WaveformStep`, `WaveformSpec`, `parse_quantity`, `parse_yaml`,
`build_breakpoints`, `resample`, `export_csv`, `export_pwl`, `export_ltspice_pwl`, `export_plecs`.

## License

MIT
