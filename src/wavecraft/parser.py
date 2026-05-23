from __future__ import annotations

import re
from pathlib import Path

import pint
import yaml

from .models import WaveformSpec, WaveformStep

ureg = pint.UnitRegistry()
Q_ = ureg.Quantity

_UNIT_MAP: dict[str, str] = {
    'A': 'ampere', 'mA': 'milliampere', 'uA': 'microampere', 'nA': 'nanoampere',
    's': 'second', 'ms': 'millisecond', 'us': 'microsecond',
    'ns': 'nanosecond', 'ps': 'picosecond',
    'V': 'volt', 'mV': 'millivolt',
    'W': 'watt', 'kW': 'kilowatt', 'MW': 'megawatt',
}


def _norm_unit(u: str) -> str:
    return _UNIT_MAP.get(u, u)


def parse_quantity(s: str) -> pint.Quantity:
    """Parse SPICE-compatible string to pint Quantity.

    Handles: "240A", "6A/us", "500us", "5ms", "1s", "1000ms", "24mA"
    """
    s = str(s).strip()
    m = re.fullmatch(
        r'([+-]?\d+\.?\d*(?:[eE][+-]?\d+)?)\s*([A-Za-z]+)(?:/([A-Za-z]+))?',
        s
    )
    if m:
        val = float(m.group(1))
        num = _norm_unit(m.group(2))
        den = m.group(3)
        if den:
            return Q_(val, f'{num}/{_norm_unit(den)}')
        return Q_(val, num)
    return ureg.Quantity(s)


def _resolve_value(raw: str, nominal_current: float | None) -> float:
    """Resolve a value string (percent or absolute) to Amps."""
    raw = str(raw).strip()
    if raw.endswith('%'):
        if nominal_current is None:
            raise ValueError(
                f"nominal_current is required to resolve percentage value: {raw!r}"
            )
        return (float(raw[:-1]) / 100.0) * nominal_current
    return parse_quantity(raw).to('ampere').magnitude


def parse_yaml(path: str | Path) -> WaveformSpec:
    """Load a YAML waveform definition and return a WaveformSpec."""
    with open(path) as f:
        raw = yaml.safe_load(f)

    name = raw.get('name', Path(path).stem)

    nominal_current: float | None = None
    if 'nominal_current' in raw:
        nominal_current = parse_quantity(raw['nominal_current']).to('ampere').magnitude

    slew_rate: float | None = None
    if 'slew_rate' in raw:
        slew_rate = parse_quantity(raw['slew_rate']).to('ampere/second').magnitude

    resolution: float | None = None
    if 'resolution' in raw:
        resolution = parse_quantity(raw['resolution']).to('second').magnitude

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
            elif re.fullmatch(r'[+-]?\d+\.?\d*(?:[eE][+-]?\d+)?', t_raw):
                # bare number with no unit — treat as seconds
                t = float(t_raw)
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
