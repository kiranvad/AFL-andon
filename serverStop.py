"""Bounded, account-scoped process cleanup for an Andon Screen launcher.

This worker uses only the standard library. Andon runs it independently of its
own terminal so an interrupted GUI shutdown does not interrupt server cleanup.
"""

import json
import os
import shlex
import signal
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Process:
    pid: int
    ppid: int
    uid: int
    state: str
    started: str
    args: tuple

    @property
    def identity(self):
        return self.uid, self.started


def processes():
    result = subprocess.run(
        ["ps", "-ax", "-o", "pid=,ppid=,uid=,stat=,lstart=,args="],
        check=True, capture_output=True, text=True, timeout=2,
    )
    found = {}
    for line in result.stdout.splitlines():
        fields = line.split(None, 9)
        if len(fields) != 10:
            continue
        pid, ppid, uid = map(int, fields[:3])
        if uid != os.getuid() or pid <= 1 or pid == os.getpid():
            continue
        started = " ".join(fields[4:9])
        try:
            # /proc preserves argument boundaries, including paths with spaces.
            # The kernel start tick also protects against PID reuse.
            proc = Path("/proc") / str(pid)
            if Path("/proc").is_dir():
                args = tuple(os.fsdecode(arg) for arg in
                             (proc / "cmdline").read_bytes().split(b"\0") if arg)
                started = (proc / "stat").read_text().rpartition(")")[2].split()[19]
            else:
                args = tuple(shlex.split(fields[9]))
        except (OSError, ValueError, IndexError):
            continue  # An exited or inaccessible process must never be signalled.
        found[pid] = Process(pid, ppid, uid, fields[3], started, args)
    return found


def flag(args, name):
    for index, arg in enumerate(args):
        if arg == name and index + 1 < len(args):
            return args[index + 1]
        if arg.startswith(name + "="):
            return arg[len(name) + 1:]
    return None


def is_screen(process, spec):
    return (process.uid == os.getuid() and process.args and Path(process.args[0]).name.lower() == "screen"
            and flag(process.args, "-S") == spec["screenName"])


def matches_server(process, spec):
    args = process.args
    if process.uid != os.getuid() or not args:
        return False
    executable = Path(args[0]).name
    if spec.get("module"):
        # Match the actual interpreter invocation, never text inside bash -c or
        # another cleanup worker. Two instances of one module on different
        # ports must be independently stoppable.
        return (executable.startswith("python")
                and flag(args, "-m") == spec["module"]
                and spec.get("port") is not None
                and flag(args, "--port") == str(spec["port"]))
    paths = spec.get("paths", [])
    if spec.get("kind") == "tiled":
        for index in range(len(args) - 3):
            if args[index:index + 3] == ("tiled", "serve", "config") or (
                Path(args[index]).name == "tiled"
                and args[index + 1:index + 3] == ("serve", "config")
            ):
                return args[index + 3] in paths
        return False
    if spec.get("kind") == "script":
        return any(arg in paths for arg in args[:2])
    return False


def descendants(snapshot, roots):
    result = set(roots)
    while True:
        added = {pid for pid, process in snapshot.items()
                 if process.uid == os.getuid() and process.ppid in result and pid not in result}
        if not added:
            return result
        result.update(added)


def alive(snapshot, targets):
    return {pid: process for pid, process in targets.items()
            if pid in snapshot and snapshot[pid].identity == process.identity
            and not snapshot[pid].state.startswith("Z")}


def server_roots(snapshot, spec):
    expected = spec.get("expectedProcesses")
    if expected is not None:
        # Delayed shutdown fallback must never target a fresh Andon session
        # that happens to use the same Screen name, module, or port.
        return {pid for pid, process in snapshot.items()
                if list(process.identity) == expected.get(str(pid))}
    return {pid for pid, process in snapshot.items()
            if is_screen(process, spec) or matches_server(process, spec)}


def stop(spec, grace_seconds=3, term_seconds=3, kill_seconds=2):
    if not spec.get("screenName"):
        raise ValueError("A Screen name is required to identify the server.")
    spec = dict(spec)
    spec["paths"] = [os.path.expanduser(path) for path in spec.get("paths", []) if path]
    initial = processes()
    roots = server_roots(initial, spec)
    screens = {pid for pid in roots if is_screen(initial[pid], spec)}
    targets = {pid: initial[pid] for pid in descendants(initial, roots)}
    forced = False

    def refresh():
        snapshot = processes()
        live = alive(snapshot, targets)
        # Capture children created during graceful shutdown before their parent
        # disappears. Retain each original start identity when checking exits.
        for pid in descendants(snapshot, live):
            if pid not in targets:
                targets[pid] = snapshot[pid]
        return alive(snapshot, targets)

    def send(sig, selected):
        # Recheck identities immediately before signalling; never kill by port
        # alone, by a broad module regex, or by another user's Screen name.
        current = alive(processes(), selected)
        for pid in current:
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                pass

    def wait(seconds):
        deadline = time.monotonic() + seconds
        while True:
            live = refresh()
            if not live or time.monotonic() >= deadline:
                return live
            time.sleep(min(0.1, max(0, deadline - time.monotonic())))

    send(signal.SIGINT, {pid: process for pid, process in targets.items() if pid not in screens})
    # Screen itself usually exits after its server exits. If only Screen remains,
    # it must still be explicitly closed and verified below.
    live = wait(grace_seconds) if targets else {}
    if live:
        send(signal.SIGTERM, {pid: process for pid, process in live.items() if pid not in screens})
        live = wait(term_seconds)
    if live:
        for pid in screens:
            if pid in alive(processes(), targets):
                try:
                    subprocess.run(
                        ["screen", "-S", str(pid) + "." + spec["screenName"], "-X", "quit"],
                        capture_output=True, timeout=2,
                    )
                except (OSError, subprocess.TimeoutExpired):
                    pass  # Escalate and verify below even if Screen is broken.
        live = wait(0.2)
    if live:
        forced = True
        send(signal.SIGKILL, live)
        live = wait(kill_seconds)
    # A process may have escaped Screen before Stop began, or a launcher may
    # have respawned. Verify command identity again as well as captured PIDs.
    final = processes()
    remaining = set(alive(final, targets)) | {
        pid for pid in server_roots(final, spec)
        if not final[pid].state.startswith("Z")
    }
    if remaining:
        return {"success": False, "error": "Server processes remain after Stop: "
                + ", ".join(map(str, sorted(remaining))), "remainingPids": sorted(remaining)}
    return {"success": True, "verified": True, "forced": forced, "alreadyStopped": not targets}


def main():
    try:
        spec = json.loads(sys.argv[1])
        if spec.get("watchParent"):
            snapshot = processes()
            for group in spec.get("groups", []):
                for item in group:
                    original = item["spec"]
                    original["paths"] = [os.path.expanduser(path) for path in original.get("paths", []) if path]
                    targets = descendants(snapshot, server_roots(snapshot, original))
                    original["expectedProcesses"] = {
                        str(pid): list(snapshot[pid].identity) for pid in targets
                    }
            deadline = time.monotonic() + 60
            while os.getppid() == spec["watchParent"] and time.monotonic() < deadline:
                time.sleep(0.2)
            # Give any already-started stop workers their full grace period.
            # This is a bounded fallback for abrupt terminal/session closure.
            time.sleep(8)
        if "groups" in spec:
            results = {}
            # Finish driver cleanup before taking down their Tiled service,
            # even if the GUI's terminal disappears while this worker runs.
            for group in spec["groups"]:
                if not group:
                    continue
                with ThreadPoolExecutor(max_workers=len(group)) as pool:
                    pending = {item["name"]: pool.submit(stop, item["spec"]) for item in group}
                    for name, future in pending.items():
                        try:
                            results[name] = future.result()
                        except Exception as error:
                            results[name] = {"success": False, "error": str(error)}
            result = {"success": all(item["success"] for item in results.values()), "results": results}
        else:
            result = stop(spec)
    except Exception as error:
        result = {"success": False, "error": "Could not verify server shutdown: " + str(error)}
    print(json.dumps(result), flush=True)
    return 0 if result["success"] else 1


if __name__ == "__main__":
    sys.exit(main())
