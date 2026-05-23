from __future__ import annotations

from pathlib import Path

import pandas as pd

from .engine import resample
from .models import WaveformSpec


def export_csv(
    bps: list[tuple[float, float]],
    dt: float,
    output_path: str | Path,
) -> None:
    """Write resampled waveform to CSV (columns: time_s, time_ms, time_us, amplitude_A)."""
    t, a = resample(bps, dt)
    df = pd.DataFrame({
        'time_s':      t,
        'time_ms':     t * 1e3,
        'time_us':     t * 1e6,
        'amplitude_A': a,
    })
    df.to_csv(output_path, index=False)


def export_pwl(
    bps: list[tuple[float, float]],
    output_path: str | Path,
    source_name: str = 'I_LOAD',
    spec: WaveformSpec | None = None,
) -> None:
    """Write breakpoints as a SPICE PWL current source definition."""
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
        for t_s, amp_a in bps:
            f.write(f"+  {t_s * 1e6:14.6f}u  {amp_a:14.6f}\n")
        f.write("+ )\n")


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


def export_plecs(
    bps: list[tuple[float, float]],
    output_path: str | Path,
    name: str = '',
) -> None:
    """Write breakpoints as a PLECS 1D lookup table (two Python vectors)."""
    x_vals  = [f"{p[0]:.10g}" for p in bps]
    fx_vals = [f"{p[1]:.10g}" for p in bps]
    with open(output_path, 'w') as f:
        if name:
            f.write(f"# PLECS 1D Lookup Table — {name}\n")
        f.write("# x: time (s), monotonically increasing\n")
        f.write("# f_x: amplitude (A)\n")
        f.write(f"x   = [{', '.join(x_vals)}]\n")
        f.write(f"f_x = [{', '.join(fx_vals)}]\n")
