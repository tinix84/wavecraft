# LTspice ASC Multi-Profile Generator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge PR #1, then generate `examples/all_profiles.asc` — one LTspice sub-circuit per YAML waveform profile — and validate it with PyLTSpice.

**Architecture:** Two standalone scripts under `scripts/`. `generate_asc.py` reads every YAML in `examples/`, builds breakpoints via `build_breakpoints`, formats an inline PWL string, and writes a single ASC file cloning the `fig3_tracking.asc` circuit topology for each profile (cells placed side-by-side with a 560-unit X offset). `validate_asc.py` checks the file structurally (token format + unique InstNames) then attempts `AscEditor` from PyLTSpice, falling back gracefully if LTspice symbol files are not on PATH.

**Tech Stack:** Python 3.11+, wavecraft (local package), PyLTSpice 5.5.1 / spicelib 1.5.1

---

## Files

| Action | Path |
|--------|------|
| Create | `scripts/generate_asc.py` |
| Create | `scripts/validate_asc.py` |
| Produces | `examples/all_profiles.asc` (generated artifact, not committed) |

---

## Task 1: Merge PR #1

**Files:** none (git/GitHub operation)

- [ ] **Step 1: Merge the PR**

```bash
gh pr merge 1 --squash --delete-branch
```

Expected output:
```
✓ Squashed and merged pull request #1 (feat: relative-time PWL syntax ...)
✓ Deleted branch feat/relative-time-pwl
```

- [ ] **Step 2: Pull master locally**

```bash
git checkout master && git pull
```

Expected: branch is now `master`, up to date.

- [ ] **Step 3: Verify tests still pass**

```bash
python -m pytest tests/test_waveform_dsl.py -q
```

Expected: `62 passed`.

---

## Task 2: Create `scripts/generate_asc.py`

Circuit topology per cell is copied verbatim from `examples/fig3_tracking.asc`:

```
Vsrc(48V) ─── L2(22nH) ─── node ─── L1(22nH) ─── I_load(PWL)
                              │
                            C1(1u)
                              │
                             GND
```

Each cell is placed at `x_off = n * 560` (n = 0-indexed profile order). All x-coordinates in WIRE, FLAG, and SYMBOL lines are shifted by `x_off`. InstNames get a `_{n+1}` suffix to stay unique.

**Files:**
- Create: `scripts/generate_asc.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_generate_asc.py
import subprocess, sys
from pathlib import Path

SCRIPT = Path(__file__).parent.parent / 'scripts' / 'generate_asc.py'
OUT    = Path(__file__).parent.parent / 'examples' / 'all_profiles.asc'

def test_generate_asc_creates_file(tmp_path):
    result = subprocess.run(
        [sys.executable, str(SCRIPT)], capture_output=True, text=True
    )
    assert result.returncode == 0, result.stderr
    assert OUT.exists(), "all_profiles.asc was not created"

def test_asc_has_correct_structure():
    lines = OUT.read_text(encoding='utf-8').splitlines()
    assert lines[0] == 'Version 4'
    assert lines[1].startswith('SHEET 1')

def test_asc_has_one_current_source_per_yaml():
    from pathlib import Path as P
    n_yamls = len(list(P('examples').glob('*.yaml')))
    text = OUT.read_text(encoding='utf-8')
    n_sources = text.count('SYMBOL current')
    assert n_sources == n_yamls, f"Expected {n_yamls} current sources, got {n_sources}"

def test_asc_no_duplicate_instnames():
    text = OUT.read_text(encoding='utf-8')
    names = [l.split(maxsplit=2)[2].strip()
             for l in text.splitlines() if l.startswith('SYMATTR InstName')]
    dupes = [n for n in names if names.count(n) > 1]
    assert dupes == [], f"Duplicate InstNames: {dupes}"

def test_asc_contains_tran_directive():
    text = OUT.read_text(encoding='utf-8')
    assert '!.tran' in text
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
python -m pytest tests/test_generate_asc.py -v
```

Expected: `ERRORS` or `FAILED` (script doesn't exist yet).

- [ ] **Step 3: Create `scripts/` directory and write `generate_asc.py`**

```python
#!/usr/bin/env python3
"""Generate examples/all_profiles.asc — one sub-circuit per YAML waveform profile."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent / 'src'))

from wavecraft import parse_yaml
from wavecraft.engine import build_breakpoints

EXAMPLES_DIR = Path(__file__).parent.parent / 'examples'
OUT_FILE     = EXAMPLES_DIR / 'all_profiles.asc'

# Horizontal spacing between sub-circuits (LTspice coordinate units).
# Original cell spans x=-176..272 = 448 units; 560 leaves 112 units of margin.
CELL_WIDTH = 560


def _pwl_string(bps: list[tuple[float, float]]) -> str:
    """Format breakpoints as an LTspice inline PWL value string."""
    tokens = []
    for t_s, amp_a in bps:
        tokens.append(f"{t_s:.10g}")
        tokens.append(f"{amp_a:.6g}")
    return "PWL(" + " ".join(tokens) + ")"


def _cell_lines(n: int, inst_suffix: str, pwl: str, label: str) -> list[str]:
    """
    ASC lines for one sub-circuit cell at x_off = n * CELL_WIDTH.

    Topology cloned from examples/fig3_tracking.asc:
      WIRE -112 128 -176 128
      WIRE 64 128 -32 128
      WIRE 112 128 64 128
      WIRE 272 128 192 128
      WIRE 64 144 64 128
      WIRE 272 144 272 128
      FLAG -176 208 0
      FLAG 272 224 0
      FLAG 64 208 0
      SYMBOL ind 96 144 R270     (L1)
      SYMBOL cap 48 144 R0       (C1)
      SYMBOL current 272 144 R0  (I_load)
      SYMBOL voltage -176 112 R0 (Vsrc)
      SYMBOL ind -128 144 R270   (L2)
    """
    x = n * CELL_WIDTH
    out = []

    # Wires
    out += [
        f"WIRE {x-112} 128 {x-176} 128",
        f"WIRE {x+64} 128 {x-32} 128",
        f"WIRE {x+112} 128 {x+64} 128",
        f"WIRE {x+272} 128 {x+192} 128",
        f"WIRE {x+64} 144 {x+64} 128",
        f"WIRE {x+272} 144 {x+272} 128",
    ]

    # Ground flags
    out += [
        f"FLAG {x-176} 208 0",
        f"FLAG {x+272} 224 0",
        f"FLAG {x+64} 208 0",
    ]

    # L1 (load-side inductor)
    out += [
        f"SYMBOL ind {x+96} 144 R270",
        "WINDOW 0 32 56 VTop 2",
        "WINDOW 3 5 56 VBottom 2",
        f"SYMATTR InstName L1_{inst_suffix}",
        "SYMATTR Value 22n",
        "SYMATTR SpiceLine Rser=1m",
    ]

    # C1 (decoupling capacitor)
    out += [
        f"SYMBOL cap {x+48} 144 R0",
        f"SYMATTR InstName C1_{inst_suffix}",
        "SYMATTR Value 1u",
    ]

    # I_load (PWL current source — our waveform)
    out += [
        f"SYMBOL current {x+272} 144 R0",
        f"SYMATTR InstName I_{inst_suffix}",
        f"SYMATTR Value {pwl}",
    ]

    # Vsrc (48 V DC supply)
    out += [
        f"SYMBOL voltage {x-176} 112 R0",
        "WINDOW 123 0 0 Left 0",
        "WINDOW 39 0 0 Left 0",
        f"SYMATTR InstName V{n+1}",
        "SYMATTR Value 48",
    ]

    # L2 (source-side inductor)
    out += [
        f"SYMBOL ind {x-128} 144 R270",
        "WINDOW 0 32 56 VTop 2",
        "WINDOW 3 5 56 VBottom 2",
        f"SYMATTR InstName L2_{inst_suffix}",
        "SYMATTR Value 22n",
        "SYMATTR SpiceLine Rser=1m",
    ]

    # Comment label below the cell
    out.append(f"TEXT {x-176} 250 Left 2 ;{label}")

    return out


def main() -> None:
    yaml_files = sorted(EXAMPLES_DIR.glob('*.yaml'))
    if not yaml_files:
        print("No YAML files found in examples/", file=sys.stderr)
        sys.exit(1)

    all_lines: list[str] = []
    max_t = 0.0

    print(f"Generating {OUT_FILE.name} from {len(yaml_files)} profiles:")
    for n, yf in enumerate(yaml_files):
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')
            spec = parse_yaml(yf)
            bps  = build_breakpoints(spec)

        pwl   = _pwl_string(bps)
        # Safe component name: letters/digits/underscores only
        safe  = ''.join(c if c.isalnum() else '_' for c in spec.name)
        label = spec.name

        all_lines.extend(_cell_lines(n, safe, pwl, label))
        if bps:
            max_t = max(max_t, bps[-1][0])
        print(f"  [{n+1}] {spec.name}: {len(bps)} breakpoints, "
              f"end={bps[-1][0]*1e3:.3f} ms")

    sheet_w = len(yaml_files) * CELL_WIDTH + 400
    tran_stop = max_t * 1.1  # 10 % margin

    with open(OUT_FILE, 'w', encoding='utf-8') as f:
        f.write("Version 4\n")
        f.write(f"SHEET 1 {sheet_w} 680\n")
        for line in all_lines:
            f.write(line + "\n")
        f.write(f"TEXT -64 280 Left 2 !.tran {tran_stop:.6g}\n")

    print(f"\nWritten: {OUT_FILE}")
    print(f".tran stop: {tran_stop*1e3:.3f} ms")


if __name__ == '__main__':
    main()
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
python -m pytest tests/test_generate_asc.py -v
```

Expected: `5 passed`.

- [ ] **Step 5: Spot-check the output**

```bash
python scripts/generate_asc.py
head -5 examples/all_profiles.asc
grep "SYMATTR InstName" examples/all_profiles.asc
grep "!\.tran" examples/all_profiles.asc
```

Expected first 2 lines:
```
Version 4
SHEET 1 3200 680
```

Expected InstNames: `L1_fig3_mixed`, `L2_fig3_mixed`, `C1_fig3_mixed`, `I_fig3_mixed`,
`V1` … `V5`, etc. — one set per profile, no duplicates.

- [ ] **Step 6: Commit**

```bash
git add scripts/generate_asc.py tests/test_generate_asc.py
git commit -m "feat: generate_asc.py — one LTspice sub-circuit per YAML profile"
```

---

## Task 3: Create `scripts/validate_asc.py`

Validation has two layers:

1. **Structural** — pure Python, no symbol files needed: checks `Version`/`SHEET` header, validates WIRE token counts and integer coords, checks no duplicate `InstName`s.
2. **PyLTSpice `AscEditor`** — attempts to parse the ASC via the PyLTSpice API. If LTspice symbol files are present (Windows path auto-detected via WSL `/mnt/c/Users/<user>/AppData/Local/Programs/ADI/LTspice/lib/sym`), this does a full parse. If symbols are not found, the step is skipped with a message (structural check is sufficient headless).

**Files:**
- Create: `scripts/validate_asc.py`

- [ ] **Step 1: Write the failing test**

Add to `tests/test_generate_asc.py`:

```python
def test_validate_asc_exits_zero():
    """validate_asc.py must exit 0 on a freshly generated all_profiles.asc."""
    validate = Path(__file__).parent.parent / 'scripts' / 'validate_asc.py'
    result = subprocess.run(
        [sys.executable, str(validate)], capture_output=True, text=True
    )
    assert result.returncode == 0, result.stdout + result.stderr
```

- [ ] **Step 2: Run the new test to confirm it fails**

```bash
python -m pytest tests/test_generate_asc.py::test_validate_asc_exits_zero -v
```

Expected: `FAILED` (script missing).

- [ ] **Step 3: Write `scripts/validate_asc.py`**

```python
#!/usr/bin/env python3
"""Validate examples/all_profiles.asc using structural checks + PyLTSpice AscEditor."""
from pathlib import Path
import sys

ASC_FILE = Path(__file__).parent.parent / 'examples' / 'all_profiles.asc'


def check_structure(path: Path) -> list[str]:
    """Return a list of error strings; empty list means OK."""
    errors: list[str] = []
    lines = path.read_text(encoding='utf-8').splitlines()

    if not lines or not lines[0].startswith('Version'):
        errors.append(f"Line 1: expected 'Version …', got {lines[0]!r}")
    if len(lines) < 2 or not lines[1].startswith('SHEET'):
        errors.append(f"Line 2: expected 'SHEET …', got {lines[1]!r}")

    inst_names: list[str] = []
    for i, line in enumerate(lines, 1):
        if line.startswith('SYMATTR InstName'):
            parts = line.split(maxsplit=2)
            if len(parts) < 3:
                errors.append(f"Line {i}: empty InstName")
            else:
                inst_names.append(parts[2].strip())
        elif line.startswith('WIRE'):
            parts = line.split()
            if len(parts) != 5:
                errors.append(f"Line {i}: WIRE needs 4 coords, got {len(parts)-1}")
            else:
                for coord in parts[1:]:
                    try:
                        int(coord)
                    except ValueError:
                        errors.append(f"Line {i}: non-integer coord {coord!r}")
        elif line.startswith('SYMBOL'):
            parts = line.split()
            if len(parts) < 5:
                errors.append(f"Line {i}: malformed SYMBOL (need symbol x y rot)")

    dupes = sorted({n for n in inst_names if inst_names.count(n) > 1})
    if dupes:
        errors.append(f"Duplicate InstNames: {dupes}")

    return errors


def check_with_pyltspice(path: Path) -> bool:
    """
    Try PyLTSpice AscEditor. Auto-detects LTspice symbol library via WSL path.
    Returns True if parse succeeded or symbols simply not found (structural OK).
    Returns False on any other AscEditor error.
    """
    try:
        from PyLTSpice import AscEditor
    except ImportError:
        print("  [skip] PyLTSpice not installed")
        return True

    # Try to point AscEditor at the LTspice symbol library on the Windows side.
    wsl_users = Path('/mnt/c/Users')
    if wsl_users.exists():
        for user_dir in wsl_users.iterdir():
            sym_path = user_dir / 'AppData/Local/Programs/ADI/LTspice/lib/sym'
            if sym_path.exists():
                AscEditor.set_custom_library_paths(str(sym_path))
                print(f"  LTspice lib: {sym_path}")
                break

    try:
        ed = AscEditor(str(path))
        comps = ed.get_components()
        print(f"  AscEditor OK — {len(comps)} components: {sorted(comps)}")
        return True
    except FileNotFoundError as exc:
        # Symbol .asy file not found — LTspice not installed or lib path wrong.
        # Structural check passed; this is not a file-format error.
        print(f"  [skip] AscEditor: symbol not found ({exc})")
        print("         Install LTspice or add its lib/sym path to run a full parse.")
        return True
    except Exception as exc:
        print(f"  [FAIL] AscEditor: {exc}")
        return False


def main() -> None:
    if not ASC_FILE.exists():
        print(f"ERROR: {ASC_FILE} not found — run scripts/generate_asc.py first.")
        sys.exit(1)

    print(f"Validating {ASC_FILE.name}")

    errors = check_structure(ASC_FILE)
    if errors:
        print(f"  [FAIL] Structural check ({len(errors)} error(s)):")
        for e in errors:
            print(f"         {e}")
        sys.exit(1)

    lines = ASC_FILE.read_text(encoding='utf-8').splitlines()
    n_sym = sum(1 for l in lines if l.startswith('SYMBOL'))
    n_inst = sum(1 for l in lines if l.startswith('SYMATTR InstName'))
    print(f"  [OK]   Structural check — {n_sym} symbols, {n_inst} InstNames, "
          f"{sum(1 for l in lines if l.startswith('WIRE'))} wires")

    ok = check_with_pyltspice(ASC_FILE)
    if not ok:
        sys.exit(1)

    print("\nValidation PASSED")


if __name__ == '__main__':
    main()
```

- [ ] **Step 4: Run all tests**

```bash
python -m pytest tests/test_generate_asc.py -v
```

Expected: `6 passed`.

- [ ] **Step 5: Run validation manually and read output**

```bash
python scripts/validate_asc.py
```

Expected output (symbol files absent scenario):
```
Validating all_profiles.asc
  [OK]   Structural check — 30 symbols, 30 InstNames, 30 wires
  [skip] AscEditor: symbol not found (File voltage.asy not found)
         Install LTspice or add its lib/sym path to run a full parse.

Validation PASSED
```

Expected output (LTspice installed via WSL):
```
Validating all_profiles.asc
  LTspice lib: /mnt/c/Users/tinix/AppData/Local/Programs/ADI/LTspice/lib/sym
  [OK]   Structural check — 30 symbols, 30 InstNames, 30 wires
  AscEditor OK — 30 components: ['C1_fig3_mixed', 'C1_fig3_tracking', ...]

Validation PASSED
```

- [ ] **Step 6: Commit**

```bash
git add scripts/validate_asc.py tests/test_generate_asc.py
git commit -m "feat: validate_asc.py — structural + PyLTSpice AscEditor validation"
```

---

## Quick-start after merging

```bash
# 1. Merge PR (Task 1)
gh pr merge 1 --squash --delete-branch
git checkout master && git pull

# 2. Generate ASC (Task 2)
python scripts/generate_asc.py

# 3. Validate (Task 3)
python scripts/validate_asc.py
```

The generated `examples/all_profiles.asc` can be opened directly in LTspice.
