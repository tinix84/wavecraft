from __future__ import annotations

import argparse
from pathlib import Path

from .engine import build_breakpoints
from .exporters import export_csv, export_ltspice_pwl, export_plecs, export_pwl
from .models import WaveformSpec
from .parser import parse_quantity, parse_yaml


def _run(spec: WaveformSpec, out_dir: Path, formats: list[str], dt_override: float | None) -> None:
    bps = build_breakpoints(spec)
    name = spec.name

    if not bps:
        print("  WARNING: no breakpoints generated — check waveform steps.")
        return

    t_end_us = bps[-1][0] * 1e6
    t_end_ms = bps[-1][0] * 1e3
    peak_a   = max(abs(p[1]) for p in bps)

    print(f"  Breakpoints : {len(bps)}")
    print(f"  Duration    : {t_end_us:.2f} µs  ({t_end_ms:.3f} ms)")
    print(f"  Peak        : {peak_a:.2f} A")

    if 'csv' in formats:
        dt = dt_override if dt_override is not None else spec.resolution
        if dt is None:
            print("  WARNING: no resolution set and no --dt given; skipping CSV.")
        else:
            path = out_dir / f"{name}.csv"
            export_csv(bps, dt, path)
            print(f"  Saved CSV   : {path}")

    if 'pwl' in formats:
        path = out_dir / f"{name}.pwl"
        export_pwl(bps, path, source_name='I_LOAD', spec=spec)
        print(f"  Saved PWL   : {path}")

    if 'plecs' in formats:
        path = out_dir / f"{name}_plecs.py"
        export_plecs(bps, path, name=name)
        print(f"  Saved PLECS : {path}")

    if 'ltspice' in formats:
        path = out_dir / f"{name}_ltspice.pwl"
        export_ltspice_pwl(bps, path, spec=spec)
        print(f"  Saved LTspice : {path}")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description='Generate waveform outputs from a YAML definition file.'
    )
    parser.add_argument('input', help='Path to .yaml waveform definition')
    parser.add_argument('--out-dir', default=None,
                        help='Output directory (default: same as input file)')
    parser.add_argument('--dt', default=None,
                        help='CSV resampling period override, e.g. 100ns')
    parser.add_argument('--formats', default='csv,pwl,plecs,ltspice',
                        help='Comma-separated: csv,pwl,plecs,ltspice (default: all four)')
    parser.add_argument('--plot', action='store_true',
                        help='Show matplotlib preview (requires matplotlib)')
    args = parser.parse_args(argv)

    input_path = Path(args.input).resolve()
    out_dir    = Path(args.out_dir).resolve() if args.out_dir else input_path.parent
    formats    = [f.strip().lower() for f in args.formats.split(',')]
    dt_override = parse_quantity(args.dt).to('second').magnitude if args.dt else None

    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"Loading: {input_path}")
    spec = parse_yaml(input_path)
    print(f"  Name        : {spec.name}")
    print(f"  Nominal     : {spec.nominal_current} A" if spec.nominal_current else "  Nominal     : (none)")
    print(f"  Slew rate   : {spec.slew_rate/1e6:.3g} A/µs" if spec.slew_rate else "  Slew rate   : (none)")
    print(f"  Resolution  : {spec.resolution*1e6:.3g} µs" if spec.resolution else "  Resolution  : (none)")
    print(f"  Steps       : {len(spec.steps)}")
    print()

    _run(spec, out_dir, formats, dt_override)

    if args.plot:
        try:
            import matplotlib.pyplot as plt
            bps = build_breakpoints(spec)
            t_us = [p[0] * 1e6 for p in bps]
            a    = [p[1] for p in bps]
            plt.figure(figsize=(12, 4))
            plt.step(t_us, a, where='post', linewidth=1.5)
            plt.xlabel('Time (µs)')
            plt.ylabel('Amplitude (A)')
            plt.title(spec.name)
            plt.grid(True, alpha=0.4)
            plt.tight_layout()
            plt.show()
        except ImportError:
            print("matplotlib not available — skipping plot.")


if __name__ == '__main__':
    main()
