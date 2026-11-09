"""Run installed simulators in new directories and compare measured waveforms."""
from __future__ import annotations

import argparse
import bisect
import json
import pathlib
import subprocess
import time
import uuid
import base64
import hashlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
LTSPICE = pathlib.Path(r"C:\Program Files\ADI\LTspice\LTspice.exe")


def unique_run(label):
    path = ROOT / "outputs" / "phase5" / "simulators" / f"{label}-{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"
    path.mkdir(parents=True)
    return path


def write(path, text):
    with path.open("x", encoding="utf-8") as stream:
        stream.write(text)


def raw_ascii(path):
    data = path.read_bytes()
    text = data.decode("utf-16") if data.startswith(b"\xff\xfe") or b"\x00" in data[:100] else data.decode("utf-8")
    header, values = text.split("Values:\n", 1) if "Values:\n" in text else text.split("Values:\r\n", 1)
    variables = []
    for line in header.rsplit("Variables:", 1)[1].splitlines():
        parts = line.split()
        if parts:
            variables.append(parts[1])
    numbers = []
    for line in values.splitlines():
        parts = line.split()
        if parts:
            numbers.append(float(parts[-1]))
    return variables, [numbers[i:i + len(variables)] for i in range(0, len(numbers), len(variables))]


def interpolate(points, t):
    if t <= points[0][0]:
        return points[0][1]
    if t >= points[-1][0]:
        return points[-1][1]
    index = bisect.bisect_right(points, t, key=lambda p: p[0])
    left, right = points[index - 1:index + 1]
    return left[1] + (right[1] - left[1]) * (t - left[0]) / (right[0] - left[0])


def run_ltspice(directory, deck):
    path = directory / "test.cir"
    write(path, deck)
    process = subprocess.run([str(LTSPICE), "-b", "-ascii", str(path)], cwd=directory,
                             capture_output=True, timeout=90, creationflags=subprocess.CREATE_NO_WINDOW)
    write(directory / "process.json", json.dumps({"returncode": process.returncode,
          "stdout": process.stdout.decode(errors="replace"), "stderr": process.stderr.decode(errors="replace")}, indent=2))
    if not path.with_suffix(".raw").exists():
        raise RuntimeError(f"LTspice did not produce {path.with_suffix('.raw')}")
    return raw_ascii(path.with_suffix(".raw"))


def baseline():
    directory = unique_run("syntax-proof")
    points = [(0, 2), (.001, -4), (.002, -4), (.003, 2), (.004, 2)]
    write(directory / "data.pwl", "".join(f"{t:.17g} {v:.17g}\n" for t, v in points))
    pwl = "(0 2 .001 -4 .002 -4 .003 2 .004 2)"
    deck = f"""* Wavecraft installed LTspice syntax proof
Vfinite nf 0 PWL REPEAT FOR 3 {pwl} ENDREPEAT
Vforever nc 0 PWL REPEAT FOREVER {pwl} ENDREPEAT
Ifile 0 ni PWL FILE=data.pwl
Rfinite nf 0 1
Rforever nc 0 1
Rfile ni 0 1
.options plotwinsize=0 numdgt=15 reltol=1e-8
.save V(nf) V(nc) V(ni) I(Ifile)
.tran 0 .015 0 .00001
.end
"""
    variables, rows = run_ltspice(directory, deck)
    results = []
    for name, mode in [("V(nf)", "finite"), ("V(nc)", "continuous"), ("V(ni)", "file")]:
        index = [v.lower() for v in variables].index(name.lower())
        error = max(abs(row[index] - interpolate(points, row[0] % .004 if mode == "continuous" or (mode == "finite" and row[0] < .012) else row[0])) for row in rows)
        results.append({"signal": name, "mode": mode, "samples": len(rows), "maxError": error, "pass": error < 1e-6})
    write(directory / "comparison.json", json.dumps(results, indent=2))
    print(json.dumps({"directory": str(directory), "comparisons": results}, indent=2))
    return all(item["pass"] for item in results)


def expected_at(spec, t):
    points = spec["points"]
    if t < 0:
        return points[0][1]
    if "outer" in spec:
        if spec["outerCount"] != "continuous" and t >= spec["outer"] * spec["outerCount"]:
            return points[-1][1]
        t %= spec["outer"]
        if t >= spec["period"] * (spec["count"] - 1) + points[-1][0]:
            return points[-1][1]
    if "period" in spec:
        if spec["count"] != "continuous" and t >= spec["count"] * spec["period"]:
            return points[-1][1]
        t %= spec["period"]
    return interpolate(points, t)


def query_times(case):
    spec, stop = case["expected"], case["stop"]
    result = {-stop / 100, 0.0, stop}
    starts = [0]
    if "outer" in spec:
        starts = [j * spec["outer"] + k * spec["period"] for j in range(4) for k in range(spec["count"])]
    elif "period" in spec:
        starts = [k * spec["period"] for k in range(5)]
    points = spec["points"]
    delta = min((b[0] - a[0] for a, b in zip(points, points[1:])), default=stop) * 1e-4
    for start in starts:
        for t, value in points:
            for shift in (-delta, 0, delta):
                if 0 <= start + t + shift <= stop:
                    result.add(start + t + shift)
        for a, b in zip(points, points[1:]):
            if start + (a[0] + b[0]) / 2 <= stop:
                result.add(start + (a[0] + b[0]) / 2)
    # Retain a separate, uniform filter-analysis grid alongside corner checks.
    result.update(stop * i / 4096 for i in range(4097))
    return sorted(result)


def adapters(manifest_path):
    manifest_path = pathlib.Path(manifest_path).resolve()
    manifest = json.loads(manifest_path.read_text())
    directory = unique_run("actual-adapters")
    results = []
    for case in manifest["cases"]:
        for export in case["exports"]:
            if export["format"] not in ["pwl", "pwl-file"]:
                continue
            target = directory / f"{case['name']}-{export['format']}"
            target.mkdir()
            source = ""
            for artifact in export["artifacts"]:
                filename = artifact["filename"]
                content = (pathlib.Path(export["directory"]) / filename).read_text()
                write(target / filename, content)
                if filename.endswith(".cir"):
                    source = content
            measure = "I(I_LOAD)" if case["dimension"] == "current" else "V(1)"
            deck = (f"* Actual Wavecraft adapter: {case['name']}\n" + source +
                    f"\nR_LOAD 1 0 1\n.options plotwinsize=0 numdgt=15 reltol=1e-9\n.save V(1) {measure}\n.tran 0 {case['stop']:.17g} 0 {case['stop']/15000:.17g}\n.end\n")
            try:
                variables, rows = run_ltspice(target, deck)
                index = [v.lower() for v in variables].index(measure.lower())
                voltage_index = [v.lower() for v in variables].index("v(1)")
                error = max(abs(row[index] - expected_at(case["expected"], row[0])) for row in rows)
                polarity_error = max(abs(row[index] - row[voltage_index]) for row in rows)
                measured = [(row[0], row[index]) for row in rows]
                corners_error = max(abs(interpolate(measured, t) - expected_at(case["expected"], t)) for t in query_times(case) if t >= 0)
                item = {"case": case["name"], "format": export["format"], "samples": len(rows), "maxError": error,
                        "cornerAndGridError": corners_error, "polarityError": polarity_error,
                        "pass": error < 1e-5 and corners_error < 1e-5 and polarity_error < 1e-8,
                        "directory": str(target), "metadata": export["metadata"]}
            except Exception as exc:
                item = {"case": case["name"], "format": export["format"], "pass": False, "error": str(exc), "directory": str(target)}
            results.append(item)
            print(json.dumps(item), flush=True)
    write(directory / "comparison.json", json.dumps({"manifest": str(manifest_path), "results": results}, indent=2))
    print(directory)
    return all(item["pass"] for item in results)


def plecs_model(manifest_path):
    manifest_path = pathlib.Path(manifest_path).resolve()
    manifest = json.loads(manifest_path.read_text())
    directory = unique_run("plecs-manual")
    model_name = "WavecraftPhase5_" + uuid.uuid4().hex[:8]
    script = f"% Dedicated local validation. No application preferences change.\nroot = '{directory.as_posix()}';\n"
    script += "fid = fopen([root '/parameters.txt'], 'w');\n"
    for component in ["Saturation", "Lookup"]:
        script += f"fprintf(fid, '{component}\\n');\nfprintf(fid, '%s\\n', evalc(\"disp(plecs('get', './{component}'))\"));\n"
    script += "fclose(fid);\n"
    prepared = []
    for index, case in enumerate(manifest["cases"]):
        export = next(e for e in case["exports"] if e["format"] == "plecs")
        artifact = next(a for a in export["artifacts"] if a["role"] == "primary")
        data_path = pathlib.Path(export["directory"]) / artifact["filename"]
        queries = query_times(case)
        # A Constant block handles the one-point capability separately.
        if len(case["expected"]["points"]) == 1:
            continue
        output = directory / f"{case['name']}.csv"
        query_literal = " ".join(f"{t:.17g}" for t in queries)
        script += f"\n% {case['name']}\nrun('{data_path.as_posix()}');\nopts = struct();\nopts.ModelVars = struct('t', t, 'y', y);\n"
        script += f"opts.SolverOpts = struct('StartTime', {queries[0]:.17g}, 'TimeSpan', {case['stop']-queries[0]:.17g}, 'OutputTimes', [{query_literal}], 'OutputTimesOption', 'specified', 'MaxStep', {case['stop']/15000:.17g}, 'RelTol', 1e-9, 'Timeout', 60);\n"
        script += f"out = plecs('simulate', opts);\ndlmwrite('{output.as_posix()}', [out.Time(:), out.Values(1,:)(:)], 'precision', '%.17g');\n"
        prepared.append({"case": case, "output": str(output), "queryCount": len(queries)})
    script += "fid = fopen([root '/COMPLETE.txt'], 'w'); fprintf(fid, 'Completed actual PLECS simulations.\\n'); fclose(fid);\nprintf('Wavecraft Phase5 validation complete.\\n');\n"
    write(directory / "run-validation.m", script)
    encoded = base64.b64encode(script.encode()).decode()
    components = []
    def component(kind, name, position, parameters=None):
        result = f'    Component {{\n      Type {kind}\n      Name "{name}"\n      Show on\n      Position [{position}, 100]\n      Direction right\n      Flipped off\n      LabelPosition south\n'
        for parameter, value in (parameters or {}).items():
            result += f'      Parameter {{\n        Variable "{parameter}"\n        Value "{value}"\n        Show off\n      }}\n'
        return result + '    }\n'
    components.append(component("Clock", "Clock", 70))
    components.append(component("Saturation", "Saturation", 160, {"UpperLimit": "t(end)", "LowerLimit": "t(1)"}))
    components.append(component("Lookup1D", "Lookup", 260, {"x": "t", "f(x)": "y", "ZeroCrossingSignals": "1"}))
    components.append(component("Output", "Measured", 360, {"Index": "1", "Width": "-1"}))
    connections = ""
    for source, terminal, target in [("Clock", 1, "Saturation"), ("Saturation", 2, "Lookup"), ("Lookup", 2, "Measured")]:
        connections += f'    Connection {{\n      Type Signal\n      SrcComponent "{source}"\n      SrcTerminal {terminal}\n      DstComponent "{target}"\n      DstTerminal 1\n    }}\n'
    model = f'''Plecs {{
  Name "{model_name}"
  Version "4.9"
  CircuitModel "ContStateSpace"
  StartTime "0"
  TimeSpan "0.01"
  Solver "auto"
  MaxStep "1e-5"
  InitStep "-1"
  FixedStep "1e-6"
  Refine "1"
  RelTol "1e-9"
  AbsTol "-1"
  ZCStepSize "1e-12"
  InitializationCommands "t = [0 1]; y = [0 0];"
  InitialState "1"
  Schematic {{
    Location [0, 50; 650, 350]
    ZoomFactor 1
    SliderPosition [0, 0]
    ShowBrowser off
{''.join(components)}{connections}  }}
  Script {{
    Name "Wavecraft Phase5 validation"
    Script base64 "{encoded}"
  }}
}}
'''
    model_path = directory / f"{model_name}.plecs"
    write(model_path, model)
    write(directory / "prepared.json", json.dumps({"manifest": str(manifest_path), "model": str(model_path), "cases": prepared}, indent=2))
    print(model_path)


def compare_plecs(prepared_path):
    prepared_path = pathlib.Path(prepared_path)
    prepared = json.loads(prepared_path.read_text())
    results = []
    for fixture in prepared["cases"]:
        path = pathlib.Path(fixture["output"])
        if not path.exists():
            results.append({"case": fixture["case"]["name"], "pass": False, "error": "No actual simulator output"})
            continue
        rows = [[float(v) for v in line.split(",")] for line in path.read_text().splitlines() if line.strip()]
        error = max(abs(row[1] - expected_at(fixture["case"]["expected"], row[0])) for row in rows)
        results.append({"case": fixture["case"]["name"], "samples": len(rows), "maxError": error, "pass": error < 1e-5})
    output = prepared_path.parent / f"comparison-{uuid.uuid4().hex[:8]}.json"
    write(output, json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))
    return len(results) > 0 and all(item["pass"] for item in results)


def artifacts_match(previous_path, current_path):
    previous = json.loads(pathlib.Path(previous_path).read_text())
    current = json.loads(pathlib.Path(current_path).read_text())
    if len(previous["cases"]) != len(current["cases"]):
        raise ValueError("Fixture case counts differ")
    results = []
    for old_case, new_case in zip(previous["cases"], current["cases"]):
        if old_case["name"] != new_case["name"]:
            raise ValueError("Fixture case names differ")
        for old_export, new_export in zip(old_case["exports"], new_case["exports"]):
            if old_export["format"] != new_export["format"] or len(old_export["artifacts"]) != len(new_export["artifacts"]):
                raise ValueError("Export formats or artifact counts differ")
            for old_artifact, new_artifact in zip(old_export["artifacts"], new_export["artifacts"]):
                if old_artifact["filename"] != new_artifact["filename"]:
                    raise ValueError("Artifact filenames differ")
                old_bytes = (pathlib.Path(old_export["directory"]) / old_artifact["filename"]).read_bytes()
                new_bytes = (pathlib.Path(new_export["directory"]) / new_artifact["filename"]).read_bytes()
                results.append({"case": old_case["name"], "format": old_export["format"], "filename": old_artifact["filename"],
                                "match": old_bytes == new_bytes, "numericArtifact": not old_artifact["filename"].endswith("-instructions.txt"),
                                "oldSha256": hashlib.sha256(old_bytes).hexdigest(), "newSha256": hashlib.sha256(new_bytes).hexdigest()})
    output = pathlib.Path(current_path).parent / f"artifact-binding-{uuid.uuid4().hex[:8]}.json"
    write(output, json.dumps({"previousManifest": str(previous_path), "currentManifest": str(current_path),
                             "previousSourceSha256": previous["exportSourceSha256"], "currentSourceSha256": current["exportSourceSha256"], "results": results}, indent=2))
    print(json.dumps({"output": str(output), "artifacts": len(results), "numericArtifacts": sum(r["numericArtifact"] for r in results),
                      "numericMatch": all(r["match"] for r in results if r["numericArtifact"]), "changed": [r for r in results if not r["match"]]}, indent=2))
    return all(r["match"] for r in results if r["numericArtifact"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["baseline", "adapters", "plecs-model", "compare-plecs", "artifacts-match"])
    parser.add_argument("path", nargs="?")
    parser.add_argument("path2", nargs="?")
    arguments = parser.parse_args()
    if arguments.operation == "baseline": sys.exit(0 if baseline() else 2)
    elif arguments.operation == "adapters": sys.exit(0 if adapters(arguments.path) else 2)
    elif arguments.operation == "plecs-model": plecs_model(arguments.path)
    elif arguments.operation == "compare-plecs": sys.exit(0 if compare_plecs(arguments.path) else 2)
    elif arguments.operation == "artifacts-match": sys.exit(0 if artifacts_match(arguments.path, arguments.path2) else 2)
