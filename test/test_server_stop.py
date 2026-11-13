"""Offline lifecycle tests for the detached Andon process cleanup worker."""

import importlib.util
import os
import signal
import sys
from pathlib import Path

import pytest

module_spec = importlib.util.spec_from_file_location("andon_server_stop", Path(__file__).parents[1] / "serverStop.py")
worker = importlib.util.module_from_spec(module_spec)
sys.modules[module_spec.name] = worker
module_spec.loader.exec_module(worker)

PROXY = "AFL.automation.shared.TiledProxyDriver"
SPEC = {"screenName": "tiled", "module": PROXY, "port": 8000}


def proc(pid, args, ppid=1, uid=None, started="old"):
    return worker.Process(pid, ppid, os.getuid() if uid is None else uid, "S", started, tuple(args))


def proxy(pid=101, port=8000, **kwargs):
    return proc(pid, ["python", "-u", "-m", PROXY, "--port", str(port)], **kwargs)


@pytest.fixture
def world(monkeypatch):
    class World:
        processes = {}
        signals = []
        exits_on = signal.SIGINT
        spawn_child = False

        def kill(self, pid, sig):
            self.signals.append((pid, sig))
            if self.spawn_child and sig == signal.SIGINT:
                self.processes[103] = proc(103, ["python", "child.py"], ppid=pid)
                self.spawn_child = False
            if sig == self.exits_on:
                self.processes.pop(pid, None)

        def run(self, args, **kwargs):
            if args[0] == "screen":
                self.processes.pop(int(args[2].split(".")[0]), None)

    state = World()
    monkeypatch.setattr(worker, "processes", lambda: dict(state.processes))
    monkeypatch.setattr(worker.os, "kill", state.kill)
    monkeypatch.setattr(worker.subprocess, "run", state.run)
    return state


def stop(spec=SPEC):
    return worker.stop(spec, grace_seconds=0, term_seconds=0, kill_seconds=0)


def test_stops_orphaned_proxy_without_server_module_or_screen(world):
    world.processes = {101: proxy(), 102: proxy(102, port=8001),
                       104: proxy(104, uid=os.getuid() + 1)}
    result = stop()
    assert result["success"] and result["verified"]
    assert world.signals == [(101, signal.SIGINT)]
    assert set(world.processes) == {102, 104}


def test_tracks_script_children_before_screen_disappears(world):
    world.processes = {
        100: proc(100, ["SCREEN", "-S", "tiled", "bash", "-ci", "launcher"]),
        101: proc(101, ["bash", "launcher.sh"], ppid=100),
        102: proc(102, ["python", "driver.py"], ppid=101),
    }
    assert stop()["verified"]
    assert {pid for pid, _sig in world.signals} == {101, 102}
    assert world.processes == {}


def test_escalates_to_term_when_interrupt_is_ignored(world):
    world.processes = {101: proxy()}
    world.exits_on = signal.SIGTERM
    assert stop()["forced"] is False
    assert world.signals == [(101, signal.SIGINT), (101, signal.SIGTERM)]


def test_escalates_to_kill_and_reports_forced_shutdown(world):
    world.processes = {101: proxy()}
    world.exits_on = signal.SIGKILL
    assert stop()["forced"] is True
    assert world.signals[-1] == (101, signal.SIGKILL)
    assert world.processes == {}


def test_reports_remaining_process_instead_of_false_success(world):
    world.processes = {101: proxy()}
    world.exits_on = None
    result = stop()
    assert result["success"] is False
    assert result["remainingPids"] == [101]


def test_captures_child_created_during_shutdown(world):
    world.processes = {101: proxy()}
    world.exits_on = signal.SIGTERM
    world.spawn_child = True
    assert stop()["verified"]
    assert (103, signal.SIGTERM) in world.signals
    assert world.processes == {}


def test_pid_reuse_never_signals_replacement(monkeypatch, world):
    original = proxy()
    replacement = proc(101, ["python", "unrelated.py"], started="new")
    snapshots = iter([{101: original}, {101: replacement}])
    monkeypatch.setattr(worker, "processes", lambda: next(snapshots, {101: replacement}))
    assert stop()["verified"]
    assert world.signals == []


def test_delayed_cleanup_preserves_a_new_instance_on_the_same_port(world):
    world.processes = {101: proxy(started="new"), 102: proxy(102)}
    result = stop({**SPEC, "expectedProcesses": {"101": [os.getuid(), "old"]}})
    assert result["verified"]
    assert world.signals == []
    assert set(world.processes) == {101, 102}


def test_delayed_cleanup_stops_only_its_captured_instance(world):
    world.processes = {101: proxy(), 102: proxy(102, started="new")}
    result = stop({**SPEC, "expectedProcesses": {"101": [os.getuid(), "old"]}})
    assert result["verified"]
    assert world.signals == [(101, signal.SIGINT)]
    assert set(world.processes) == {102}


def test_native_catalog_matches_config_path_with_spaces(world):
    paths = ["/private configs/local.yml"]
    world.processes = {
        101: proc(101, ["/env/bin/python", "/env/bin/tiled", "serve", "config", paths[0]]),
        102: proc(102, ["tiled", "serve", "config", "/other/local.yml"]),
    }
    assert stop({"screenName": "tiled", "kind": "tiled", "paths": paths})["verified"]
    assert set(world.processes) == {102}


def test_does_not_match_module_text_inside_shell_or_cleanup_arguments():
    assert not worker.matches_server(proc(101, ["bash", "-c", "python -m " + PROXY + " --port 8000"]), SPEC)
    assert not worker.matches_server(proc(102, ["python", "-c", "stop()", str(SPEC)]), SPEC)


def test_failed_process_inspection_is_reported(monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["worker", '{"screenName":"tiled"}'])
    monkeypatch.setattr(worker, "processes", lambda: (_ for _ in ()).throw(OSError("ps unavailable")))
    assert worker.main() == 1
    assert "ps unavailable" in capsys.readouterr().out


def test_shutdown_fallback_waits_for_parent_then_stops_driver_before_tiled(monkeypatch, capsys):
    import json
    calls = []
    parents = iter([200, 1])
    monkeypatch.setattr(worker.os, "getppid", lambda: next(parents, 1))
    snapshot = {
        100: proc(100, ["SCREEN", "-S", "driver"]),
        101: proc(101, ["python", "driver.py"], ppid=100),
        102: proc(102, ["SCREEN", "-S", "tiled"]),
    }
    monkeypatch.setattr(worker, "processes", lambda: snapshot)
    monkeypatch.setattr(worker.time, "sleep", lambda seconds: calls.append(("sleep", seconds)))
    def cleanup(spec):
        expected = [100, 101] if spec["screenName"] == "driver" else [102]
        assert spec["expectedProcesses"] == {str(pid): [os.getuid(), "old"] for pid in expected}
        calls.append(("stop", spec["screenName"]))
        return {"success": True, "verified": True}
    monkeypatch.setattr(worker, "stop", cleanup)
    monkeypatch.setattr(sys, "argv", ["worker", json.dumps({"watchParent": 200, "groups": [
        [{"name": "driver", "spec": {"screenName": "driver"}}],
        [{"name": "tiled", "spec": {"screenName": "tiled"}}],
    ]})])
    assert worker.main() == 0
    assert calls == [("sleep", 0.2), ("sleep", 8), ("stop", "driver"), ("stop", "tiled")]
    assert json.loads(capsys.readouterr().out)["results"]["tiled"]["verified"]


@pytest.mark.parametrize("stubborn", [False, True])
def test_real_process_cleanup_preserves_other_instance(tmp_path, stubborn):
    import select
    import subprocess
    (tmp_path / "andon_stop_fixture.py").write_text(
        "import signal, sys, time\n"
        "if '--stubborn' in sys.argv:\n"
        "    signal.signal(signal.SIGINT, signal.SIG_IGN)\n"
        "    signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
        "print('ready', flush=True)\n"
        "while True: time.sleep(0.05)\n"
    )
    children = []
    try:
        for port in [50001, 50002]:
            args = [sys.executable, "-m", "andon_stop_fixture", "--port", str(port)]
            if stubborn:
                args.append("--stubborn")
            child = subprocess.Popen(args, cwd=tmp_path, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            children.append(child)
            assert select.select([child.stdout], [], [], 3)[0], "fixture did not become ready"
            assert child.stdout.readline().strip() == b"ready"
        result = worker.stop({"screenName": "fixture", "module": "andon_stop_fixture", "port": 50001},
                             grace_seconds=0.1, term_seconds=0.1, kill_seconds=1)
        assert result["verified"]
        assert result["forced"] is stubborn
        children[0].wait(timeout=2)
        assert children[1].poll() is None
    finally:
        for child in children:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=2)
