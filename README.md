# wavecraft

YAML-driven piecewise-linear waveform generator for circuit simulators — outputs CSV, SPICE PWL, LTspice `PWL FILE=`, and PLECS 1D lookup tables.

## What it does

Define a load current waveform in YAML — with slew rates, hold times, and percentage amplitudes — and generate ready-to-use stimulus files for your simulator. Supports both absolute-timestamp steps (`t`+`value`) and duration-relative steps (`hold`+`for`), with per-step slew-rate overrides and automatic conflict resolution when a slew constraint pushes a breakpoint forward.

## Install

### Installation-free browser use

Extract the editor release ZIP into a local folder.
Open `wavecraft.html` in Chrome or Edge.
The editor HTML contains its runtime code and styles.
Keep `diagnostics\THIRD_PARTY_NOTICES.txt` with the distribution.
The diagnostics page is a separate portability test, not the editor.

Use **Save project ZIP** to keep a portable project ZIP.
Keep the ZIP as an explicit backup before closing or moving the HTML.
Browser recovery depends on the browser, origin, and storage policy.
Recovery does not replace the project ZIP.
Direct-file offline use needs a test in each browser configuration.
An HTTP preview does not establish direct-file storage or offline operation.

For an image reconstruction, keep the original image, calibration, raw points, corrections, and source notes in the project.
Review the raw overlay before accepting corrected points.
Record finite edge assumptions and their units.
For CSV input, confirm the columns, units, assumptions, and acceptance controls.
An external WebPlotDigitizer session requires that separate tool.
Its CSV can enter the same explicit mapping workflow.

### Simulator integration

Export the target from the accepted compiled waveform.
Keep the signal units and time units visible during review.
For repeated waveforms, select a finite export horizon when the target requires finite data.

For LTspice inline PWL, include the exported `.cir` source in your circuit.
For file-backed PWL, keep the exported `.cir` include and matching `.txt` data together.
Preserve their relative paths and use the supplied instructions.
The current source is `I_LOAD 0 1`. Positive current flows from node 0 to node 1.
The voltage source is `V_SIGNAL 1 0`. Its output is `V(1)-V(0)`.
Connect the load between nodes 1 and 0.
Set the transient maximum time step below the shortest finite ramp.
Compare corners, segment interiors, repeat boundaries, and endpoint holding.
Relative `+tdelta` entries require LTspice support.

For PLECS, paste the exported `.m` SI vectors into the model Initialization commands.
Connect Clock to Saturation, then to a 1D Look-Up Table.
Set Saturation Lower limit (`LowerLimit`) to `t(1)` and Upper limit (`UpperLimit`) to `t(end)`.
Set the table input vector `x` to `t` and output vector `f(x)` to `y`.
Use linear interpolation and set Locate discontinuities (`ZeroCrossingSignals`) to on.
The Saturation block holds both endpoint levels because the table extrapolates outside its range.
Connect the table output to the matching Controlled Current Source or Controlled Voltage Source.
For a one-point export, use a Constant block with value `y(1)`.
Check the finite horizon and compare simulated values with the compiled waveform.
Export generation alone does not prove simulator agreement.

### Browser editor preview

Start the existing waveform editor with Node 24.11.1 or later:

```powershell
Set-Location 'D:\OneDrive\claude\waveform-dsl\web'
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm start
```

Open <http://127.0.0.1:8771/> for the editor and its preloaded sample.
The alias <http://127.0.0.1:8771/wavecraft-web-prototype.html> opens the same editor.
The server reads the prototype file for each request.
Reload the page after source changes.
You can also open `prototypes\wavecraft-web-prototype.html` directly from disk.

The developer portability bench is separate at <http://127.0.0.1:8771/diagnostics/>.
It uses the existing artifact selected by `outputs\phase1\web\latest.json`.
The preview command does not build or change the proof artifact.

Use `npm run build` to create a new editor artifact under `outputs\ui-restore\web`.
Use `npm run package` to also create an editor ZIP.
Both commands regenerate the prototype's inline semantic bundle before packaging.
Run them only when a source rebuild is intended.
Open `wavecraft.html` as the primary standalone editor.
The package keeps the developer bench under `diagnostics\wavecraft-phase1.html`.
The `latest.json` file in the editor output directory identifies the current package.
To use a different preview port, run `npm start -- --port=8773`.

### Phase 1 browser portability proof

The browser proof tests standalone delivery, local file input, ZIP byte preservation, SVG coordinates, and browser recovery.
It does not compile waveforms or provide the full editor.

Open the generated `wavecraft-phase1.html` directly from disk.
The HTML includes its JavaScript, CSS, sample evidence, and third-party notices.
Use the local file inputs to import UTF-8 YAML and a PNG, JPEG, or WebP image.
Download the proof ZIP, then reopen it to compare the original bytes.

Use the included `HUMAN_TEST.md` card in Windows Chrome and Edge with networking disconnected.
Record the direct-file results before treating a browser configuration as supported.
HTTP checks do not satisfy that gate.
Keep an explicit ZIP backup because browser recovery depends on the browser origin and storage policy.

For development, use Node 24.11.1 or later:

```powershell
Set-Location 'D:\OneDrive\claude\waveform-dsl\web'
npm install --ignore-scripts --no-audit --no-fund
npm test
npm run build:proof
npm run test:browser
npm run package:proof
```

Each build creates a new directory under `outputs/phase1/web`.
The `latest.json` file identifies its HTML and optional release ZIP.
The release ZIP includes notices, metadata, a human test card, and byte-preservation fixtures.
The `test:browser` script serves an HTTP preview and prints a manual checklist.
It does not automate browser checks or report browser test passes.

### Python command-line tool

```bash
pip install wavecraft          # once published to PyPI
pip install -e ".[dev]"           # development install from source
```

### Legacy compatibility baseline

Run the checker from the repository root:

```powershell
Set-Location 'D:\OneDrive\claude\waveform-dsl'
& 'D:\codex-envs\wavecraft-compat\python.exe' scripts\verification\legacy_baseline.py check
```

The checker reads the frozen corpus without rewriting it.
Before running tests that generate schematics, create a unique snapshot.
Replace `<newdirectory>` with a new directory path:

```powershell
& 'D:\codex-envs\wavecraft-compat\python.exe' scripts\verification\legacy_baseline.py snapshot --output '<newdirectory>'
```

Run tests that generate schematics only inside that snapshot.
The generator writes `examples\all_profiles.asc`.

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
| `t: TIME, value: VALUE` | Reach VALUE at absolute timestamp TIME. TIME may be prefixed with `+` to mean "DURATION after the previous absolute timestamp" |
| `dt: DURATION, value: VALUE` | Reach VALUE at `prev_t + DURATION`, where `prev_t` is the **previous absolute timestamp** (i.e., the most recent `t:` or `dt:` step's resolved time; `hold:` steps do not advance `prev_t`). Equivalent to `t: "+DURATION"` |
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

> **Note:** The LTspice `PWL FILE=` output (`_ltspice.pwl`) now emits each row after the first as a `+tdelta` relative-time entry. LTspice accepts this format natively and it is more readable for long waveforms. If you have external tooling that parsed the previous absolute-timestamp two-column format, update it accordingly. The inline `PWL(...)` output (`.pwl`) keeps absolute timestamps by default for ngspice compatibility; pass `--relative-time` to switch it.

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
