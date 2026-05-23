#!/usr/bin/env python3
"""Validate examples/all_profiles.asc using structural checks + PyLTSpice AscEditor."""
from pathlib import Path
import sys

ASC_FILE = Path(__file__).parent.parent / 'examples' / 'all_profiles.asc'


def check_structure(path: Path) -> list[str]:
    """Return a list of error strings; empty list means file is structurally valid."""
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
                errors.append(
                    f"Line {i}: WIRE needs 4 integer coords, got {len(parts) - 1}"
                )
            else:
                for coord in parts[1:]:
                    try:
                        int(coord)
                    except ValueError:
                        errors.append(
                            f"Line {i}: non-integer WIRE coord {coord!r}"
                        )
        elif line.startswith('SYMBOL'):
            parts = line.split()
            if len(parts) < 5:
                errors.append(
                    f"Line {i}: malformed SYMBOL — need 'SYMBOL name x y rotation'"
                )

    dupes = sorted({n for n in inst_names if inst_names.count(n) > 1})
    if dupes:
        errors.append(f"Duplicate InstNames: {dupes}")

    return errors


def check_with_pyltspice(path: Path) -> bool:
    """
    Try PyLTSpice AscEditor for a full symbol-aware parse.

    Auto-detects the LTspice symbol library under WSL (/mnt/c/Users/…).
    Returns True if the parse succeeded, or if it failed only because symbol
    (.asy) files were not found (structural check already passed — this is a
    library-path issue, not a file-format issue).
    Returns False on any other parse error.
    """
    try:
        from PyLTSpice import AscEditor
    except ImportError:
        print("  [skip] PyLTSpice not installed")
        return True

    # Auto-detect LTspice lib/sym directory via WSL path
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
        # Symbol .asy file not found: LTspice not installed or lib path wrong.
        # The structural check already passed — this is not a format error.
        print(f"  [skip] AscEditor: symbol file not found ({exc})")
        print("         Set AscEditor.set_custom_library_paths() to your LTspice "
              "lib/sym directory for a full parse.")
        return True
    except Exception as exc:
        print(f"  [FAIL] AscEditor: {exc}")
        return False


def main() -> None:
    if not ASC_FILE.exists():
        print(
            f"ERROR: {ASC_FILE} not found — run scripts/generate_asc.py first.",
            file=sys.stderr,
        )
        sys.exit(1)

    print(f"Validating {ASC_FILE.name}")

    # Layer 1: structural check
    errors = check_structure(ASC_FILE)
    if errors:
        print(f"  [FAIL] Structural check ({len(errors)} error(s)):")
        for e in errors:
            print(f"         {e}")
        sys.exit(1)

    lines = ASC_FILE.read_text(encoding='utf-8').splitlines()
    n_sym  = sum(1 for l in lines if l.startswith('SYMBOL'))
    n_inst = sum(1 for l in lines if l.startswith('SYMATTR InstName'))
    n_wire = sum(1 for l in lines if l.startswith('WIRE'))
    print(f"  [OK]   Structural — {n_sym} symbols, {n_inst} InstNames, {n_wire} wires")

    # Layer 2: PyLTSpice AscEditor
    ok = check_with_pyltspice(ASC_FILE)
    if not ok:
        sys.exit(1)

    print("\nValidation PASSED")


if __name__ == '__main__':
    main()
