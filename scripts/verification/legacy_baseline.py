"""Freeze or check legacy results without changing the Python implementation."""
from __future__ import annotations

import argparse
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import runpy
import shutil
import sys
import warnings


ROOT = Path(__file__).resolve().parents[2]
FIXTURES = Path('tests/fixtures/legacy')


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_new_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf-8', newline='\n') as stream:
        json.dump(value, stream, indent=2, ensure_ascii=True, allow_nan=False)
        stream.write('\n')


def characterize(root: Path, relative: str, sample_dt: float | None = None) -> dict:
    """Keep raw binary64 values and warning messages. Exclude locations and dates."""
    from wavecraft import parse_yaml, build_breakpoints, resample

    source = root / relative
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter('always')
        spec = parse_yaml(source)
        points = build_breakpoints(spec)
        if sample_dt is None:
            span = points[-1][0] - points[0][0] if points else 0.0
            # Bound large article profiles while retaining each selected sample.
            sample_dt = spec.resolution or (span / 128 if span > 0 else 1e-6)
            if span / sample_dt > 256:
                sample_dt = span / 128
        times, amplitudes = resample(points, sample_dt)
    helper = runpy.run_path(str(root / 'scripts/generate_asc.py'))['_pwl_string']
    return {
        'input': relative,
        'sha256': digest(source),
        'spec': asdict(spec),
        'breakpoints': [list(point) for point in points],
        'warnings': [
            {'category': warning.category.__name__, 'message': str(warning.message)}
            for warning in caught
        ],
        'sampling': {
            'dt': sample_dt,
            'time_s': times.tolist(),
            'amplitude_A': amplitudes.tolist(),
        },
        'schematic_repeat_pwl': helper(points) if points else None,
    }


def freeze(root: Path, destination: Path) -> None:
    """Create expectations explicitly. Refuse an existing corpus or input copy."""
    if (destination / 'corpus.json').exists():
        raise FileExistsError(destination / 'corpus.json')
    records = []
    original_inputs = []
    inputs = sorted((root / 'examples').glob('*.yaml')) + [root / 'tests/fixture_basic.yaml']
    for source in inputs:
        relative = source.relative_to(root)
        target = destination / 'inputs' / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as stream:
            stream.write(source.read_bytes())
        original_inputs.append({'source': relative.as_posix(), 'sha256': digest(source)})
    for source in sorted((destination / 'inputs').rglob('*.yaml')):
        records.append(characterize(root, source.relative_to(root).as_posix()))
    write_new_json(destination / 'corpus.json', {
        'format': 'wavecraft-legacy-baseline-v1',
        'sampling_policy': 'Use resolution up to 256 samples. Otherwise use span/128. Exclude final breakpoint.',
        'original_inputs': original_inputs,
        'cases': records,
    })
    print(f'Frozen {len(records)} cases in {destination / "corpus.json"}')


def check(root: Path, corpus_path: Path) -> list[str]:
    """Read frozen expectations. Never create or update an expectation."""
    corpus = json.loads(corpus_path.read_text(encoding='utf-8'))
    failures = []
    for expected in corpus['cases']:
        actual = characterize(root, expected['input'], expected['sampling']['dt'])
        for field in expected:
            if actual[field] != expected[field]:
                failures.append(f'{expected["input"]}: {field} differs')
    return failures


def snapshot(root: Path, destination: Path) -> None:
    """Copy required inputs into a new directory. Retain all previous snapshots."""
    destination.mkdir(parents=True, exist_ok=False)
    files = []
    for directory in ('src', 'tests', 'scripts', 'examples'):
        for path in sorted((root / directory).rglob('*')):
            if path.is_file() and '__pycache__' not in path.parts and path.suffix in ('.py', '.yaml', '.json', '.asc', '.txt'):
                files.append(path)
    files.extend(root / name for name in ('pyproject.toml', 'README.md', 'LICENSE'))
    hashes = {}
    for source in files:
        relative = source.relative_to(root)
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        hashes[relative.as_posix()] = digest(source)
        if digest(target) != hashes[relative.as_posix()]:
            raise ValueError(f'Snapshot bytes differ: {relative}')
    write_new_json(destination / 'source-hashes.json', hashes)
    print(f'Snapshot: {destination} ({len(files)} files)')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('snapshot', 'freeze', 'check'))
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--output', type=Path)
    arguments = parser.parse_args()
    root = arguments.root.resolve()
    sys.path.insert(0, str(root / 'src'))
    if arguments.operation == 'snapshot':
        if arguments.output is None:
            parser.error('snapshot requires --output with a new directory')
        snapshot(root, arguments.output.resolve())
    elif arguments.operation == 'freeze':
        freeze(root, arguments.output.resolve() if arguments.output else root / FIXTURES)
    else:
        failures = check(root, arguments.output or root / FIXTURES / 'corpus.json')
        for failure in failures:
            print(failure)
        if failures:
            raise SystemExit(1)
        print('Legacy baseline matches the frozen corpus.')


if __name__ == '__main__':
    main()
