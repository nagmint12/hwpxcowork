"""Read completed job records and emit per-operation statistics. Never pool failed trials."""
import argparse
import csv
import json
from collections import defaultdict
from pathlib import Path
from statistics import median


TIMINGS = ("openMs", "snapshotMs", "mutationMs", "caretMs", "caretReadyMs",
           "pageDataMs", "foregroundMs", "finishMs", "slowestStepMs")


def read_jobs(folder):
    jobs = []
    for f in sorted(folder.glob("*-job.json")):
        job = json.loads(f.read_text())
        raw = f.with_name(f.name.replace("-job.json", ".jsonl"))
        meta, *rows = [json.loads(line) for line in raw.read_text(encoding="utf-8").splitlines()]
        groups = defaultdict(list)
        for row in rows:
            if "foregroundMs" in row and row["round"] > 0:
                groups[(row["page"], row["op"])].append(row)
        jobs.append((job, meta["meta"], rows, groups, raw))
    return jobs


def summaries(jobs, shape):
    for job, meta, rows, groups, raw in jobs:
        for (page, op), group in groups.items():
            row = dict(shape=shape, profile=job["profile"], pages=job["pages"], page=page, op=op,
                       samples=len(group), jobExit=job["exitCode"], source=raw.name,
                       minForegroundMs=min(r["foregroundMs"] for r in group),
                       maxForegroundMs=max(r["foregroundMs"] for r in group),
                       peakCommitMiB=job["peakCommitBytes"] / 1048576,
                       scope=meta.get("scope", "complete"),
                       parkedSamples=sum(r["tailAtLocal"] for r in group) if "tailAtLocal" in group[0] else None,
                       pendingSamples=sum(r["documentPaginationPending"] for r in group) if "documentPaginationPending" in group[0] else None)
            row.update({key: median(r[key] for r in group) if key in group[0] else None for key in TIMINGS})
            yield row


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("folders", type=Path, nargs="+", help="one completed run per directory")
    args = parser.parse_args()
    records = [r for folder in args.folders for r in summaries(read_jobs(folder), folder.as_posix())]
    if not records:
        raise ValueError("No measured samples")
    with args.output.open("x", newline="", encoding="utf-8-sig") as output:
        writer = csv.DictWriter(output, records[0].keys())
        writer.writeheader()
        writer.writerows(records)
