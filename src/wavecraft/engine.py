from __future__ import annotations

import warnings

import numpy as np

from .models import WaveformSpec, WaveformStep


def build_breakpoints(spec: WaveformSpec) -> list[tuple[float, float]]:
    """Build (time_s, amplitude_A) breakpoints from a WaveformSpec.

    Returns only corner points — the minimal set that fully defines the waveform.
    """
    bps: list[tuple[float, float]] = []
    current_t: float = 0.0
    prev_amp: float = 0.0

    def append_safe(t: float, amp: float) -> None:
        if bps and abs(bps[-1][0] - t) < 1e-15:
            return
        if bps and t < bps[-1][0] - 1e-15:
            return
        bps.append((t, amp))

    def effective_slew(step: WaveformStep) -> float | None:
        return step.slew_rate if step.slew_rate is not None else spec.slew_rate

    def ramp_time(delta_i: float, step: WaveformStep) -> float:
        if delta_i < 1e-12:
            return 0.0
        slew = effective_slew(step)
        if slew is not None:
            return delta_i / slew
        if spec.resolution is not None:
            return spec.resolution
        return 0.0

    for step in spec.steps:
        delta_i = abs(step.value - prev_amp)
        rt = ramp_time(delta_i, step)

        if step.kind == 'hold':
            if rt > 0:
                append_safe(current_t, prev_amp)
                append_safe(current_t + rt, step.value)
                current_t += rt
            append_safe(current_t + step.hold_duration, step.value)
            current_t += step.hold_duration

        elif step.kind == 'absolute':
            declared_t = step.t

            if rt > 0:
                ramp_start = declared_t - rt
                if ramp_start < current_t - 1e-15:
                    actual_t = current_t + rt
                    warnings.warn(
                        f"Step declared at t={declared_t:.6g}s pushed to t={actual_t:.6g}s "
                        f"(slew constraint: ramp needs {rt:.6g}s)",
                        UserWarning,
                        stacklevel=2,
                    )
                    ramp_start = current_t
                else:
                    actual_t = declared_t

                if ramp_start > current_t + 1e-15:
                    append_safe(ramp_start, prev_amp)
                append_safe(actual_t, step.value)
                current_t = actual_t

            else:
                actual_t = declared_t
                if declared_t < current_t - 1e-15:
                    actual_t = current_t + (spec.resolution or 0.0)
                    warnings.warn(
                        f"Step declared at t={declared_t:.6g}s pushed to t={actual_t:.6g}s "
                        f"(timestamp conflict, no slew)",
                        UserWarning,
                        stacklevel=2,
                    )
                append_safe(actual_t, step.value)
                current_t = actual_t

        prev_amp = step.value

    return bps


def resample(
    bps: list[tuple[float, float]],
    dt: float,
) -> tuple[np.ndarray, np.ndarray]:
    """Resample breakpoints to a uniform time grid via linear interpolation."""
    if not bps:
        return np.array([]), np.array([])
    t_bp = np.array([p[0] for p in bps], dtype=float)
    a_bp = np.array([p[1] for p in bps], dtype=float)
    n_samples = int(np.floor((t_bp[-1] - t_bp[0]) / dt))
    t_grid = t_bp[0] + np.arange(n_samples) * dt
    a_grid = np.interp(t_grid, t_bp, a_bp)
    return t_grid, a_grid
