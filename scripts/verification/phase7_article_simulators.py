"""Compare installed LTspice outputs with the independent article baseline."""
from __future__ import annotations

import hashlib
import json
import pathlib
import sys
import time
import uuid

from phase5_simulators import LTSPICE, ROOT, interpolate, query_times, run_ltspice, write


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    manifest_path = pathlib.Path(sys.argv[1]).resolve()
    manifest = json.loads(manifest_path.read_text())
    baseline_path = manifest_path.parent / "independent-baseline.json"
    baseline = json.loads(baseline_path.read_text())
    points = baseline["compiled"]
    directory = ROOT / "outputs" / "phase7" / f"article-ltspice-{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"
    directory.mkdir()
    environment = {
        "capturedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "executable": str(LTSPICE), "executableSha256": sha256(LTSPICE),
        "observedFileVersion": "26.0.1.0",
        "versionEvidence": "PowerShell Get-Item LTspice.exe VersionInfo: FileVersion and ProductVersion both 26.0.1.0.",
        "help": str(LTSPICE.parent / "LTspiceHelp" / "commandlineswitches.htm"),
        "commandArguments": ["-b", "-ascii", "test.cir"],
        "manifest": str(manifest_path), "manifestSha256": sha256(manifest_path),
        "independentBaseline": str(baseline_path), "baselineSha256": sha256(baseline_path),
        "tolerances": {"currentAbsA": 1e-5, "polarityAbsA": 1e-8},
        "scope": "Actual LTspice current source into a 1 ohm load. Numerical stimulus comparison only. No PLECS run.",
    }
    write(directory / "environment.json", json.dumps(environment, indent=2))
    results = []
    for case in manifest["cases"]:
        assert case["expected"]["points"] == points
        for export in case["exports"]:
            if export["format"] not in ["pwl", "pwl-file"]:
                continue
            target = directory / f"{case['name']}-{export['format']}"
            target.mkdir()
            artifacts = []
            source = ""
            for artifact in export["artifacts"]:
                original_path = pathlib.Path(export["directory"]) / artifact["filename"]
                content = original_path.read_text()
                write(target / artifact["filename"], content)
                artifacts.append({"path": str(original_path), "sha256": sha256(original_path)})
                if original_path.suffix == ".cir":
                    source = content
            deck = (f"* Published article {case['name']} actual {export['format']} adapter\n" + source +
                    "\nR_LOAD 1 0 1\n.options plotwinsize=0 numdgt=15 reltol=1e-9\n" +
                    f".save V(1) I(I_LOAD)\n.tran 0 {case['stop']:.17g} 0 {case['stop']/15000:.17g}\n.end\n")
            try:
                variables, rows = run_ltspice(target, deck)
                names = [v.lower() for v in variables]
                current_index = names.index("i(i_load)")
                voltage_index = names.index("v(1)")
                measured = [(row[0], row[current_index]) for row in rows]
                raw_error = max(abs(value - interpolate(points, t)) for t, value in measured)
                polarity_error = max(abs(row[current_index] - row[voltage_index]) for row in rows)
                queries = [t for t in query_times(case) if t >= 0]
                details = [{"timeS": t, "expectedA": interpolate(points, t), "measuredA": interpolate(measured, t),
                            "errorA": abs(interpolate(measured, t) - interpolate(points, t))} for t in queries]
                query_error = max(row["errorA"] for row in details)
                # The corrected return edge runs from raw point 8 to corrected point 9.
                edge_start, edge_end = baseline["corrected"][8:10]
                finite_edge_times = [edge_start[0] + (edge_end[0] - edge_start[0]) * f for f in [0, .25, .5, .75, 1]]
                finite_edge = [{"timeS": t, "expectedA": interpolate(points, t), "measuredA": interpolate(measured, t)} for t in finite_edge_times]
                endpoint_times = [points[-1][0], (points[-1][0] + case["stop"]) / 2, case["stop"]]
                endpoint_hold = [{"timeS": t, "expectedA": points[-1][1], "measuredA": interpolate(measured, t)} for t in endpoint_times]
                write(target / "query-comparison.json", json.dumps(details, indent=2))
                item = {"case": case["name"], "format": export["format"], "samples": len(rows), "queryCount": len(queries),
                        "sampleErrorA": raw_error, "cornerInteriorGridErrorA": query_error, "sourcePolarityErrorA": polarity_error,
                        "finiteEdgeAssumedDurationS": edge_end[0] - edge_start[0], "finiteEdge": finite_edge, "endpointHold": endpoint_hold,
                        "artifacts": artifacts, "directory": str(target),
                        "pass": raw_error < 1e-5 and query_error < 1e-5 and polarity_error < 1e-8}
            except Exception as exc:
                item = {"case": case["name"], "format": export["format"], "pass": False, "error": str(exc), "directory": str(target)}
            results.append(item)
            print(json.dumps(item), flush=True)
    write(directory / "comparison.json", json.dumps({"environment": environment, "results": results, "plecs": "Unverified. No actual native or RPC run."}, indent=2))
    print(directory, flush=True)
    return 0 if len(results) == 4 and all(item["pass"] for item in results) else 2


if __name__ == "__main__":
    sys.exit(main())
