#!/usr/bin/env python3
"""Generate examples/all_profiles.asc — one sub-circuit per YAML waveform profile."""
from pathlib import Path
import sys
import warnings

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
      Vsrc(48V) --- L2(22nH) --- node --- L1(22nH) --- I_load(PWL)
                                  |
                                C1(1u)
                                  |
                                 GND
    All x-coordinates from the original are shifted by x_off = n * CELL_WIDTH.
    """
    x = n * CELL_WIDTH
    out = []

    # Wires (from fig3_tracking.asc, x-shifted)
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

    # I_load (PWL current source — the waveform under test)
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

    # Profile label below cell
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
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')
            spec = parse_yaml(yf)
            bps  = build_breakpoints(spec)

        pwl  = _pwl_string(bps)
        # Safe component name: replace non-alphanumeric chars with _
        safe = ''.join(c if c.isalnum() else '_' for c in spec.name)
        all_lines.extend(_cell_lines(n, safe, pwl, spec.name))

        if bps:
            max_t = max(max_t, bps[-1][0])
        print(f"  [{n+1}] {spec.name}: {len(bps)} breakpoints, "
              f"end={bps[-1][0] * 1e3:.3f} ms")

    sheet_w  = len(yaml_files) * CELL_WIDTH + 400
    tran_stop = max_t * 1.1  # 10 % margin past the longest profile

    with open(OUT_FILE, 'w', encoding='utf-8') as f:
        f.write("Version 4\n")
        f.write(f"SHEET 1 {sheet_w} 680\n")
        for line in all_lines:
            f.write(line + "\n")
        f.write(f"TEXT -64 280 Left 2 !.tran {tran_stop:.6g}\n")

    print(f"\nWritten: {OUT_FILE}")
    print(f".tran stop: {tran_stop * 1e3:.3f} ms")


if __name__ == '__main__':
    main()
