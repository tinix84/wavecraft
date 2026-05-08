from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal


@dataclass
class WaveformStep:
    kind: Literal['absolute', 'hold']
    value: float                        # Amps — always resolved at parse time
    t: float | None = None              # seconds (absolute steps only)
    hold_duration: float | None = None  # seconds (hold steps only)
    slew_rate: float | None = None      # A/s (per-step override; None = use global)


@dataclass
class WaveformSpec:
    name: str
    nominal_current: float | None       # Amps
    slew_rate: float | None             # A/s (global)
    resolution: float | None            # seconds (CSV dt + ramp fallback)
    steps: list[WaveformStep] = field(default_factory=list)
