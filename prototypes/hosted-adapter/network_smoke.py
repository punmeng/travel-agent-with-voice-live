"""Bounded real-socket check of the official local host; no cloud calls."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
from uuid import uuid4

import httpx
from websockets.sync.client import connect

root = Path(__file__).parent
worker = subprocess.Popen(["node", str(root / "node-worker.js")],
                          env={**os.environ, "HOSTED_ADAPTER_OFFLINE": "true"},
                          stdout=subprocess.PIPE, text=True, encoding="utf-8")
host = None
try:
    worker_port = json.loads(worker.stdout.readline())["port"]
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    host = subprocess.Popen(
        [sys.executable, str(root / "adapter.py")],
        env={**os.environ, "HOSTED_ADAPTER_OFFLINE": "true",
             "HOSTED_NODE_ORIGIN": f"http://127.0.0.1:{worker_port}", "PORT": str(port)},
    )
    origin = f"http://127.0.0.1:{port}"
    with httpx.Client(timeout=5, trust_env=False) as client:
        deadline = time.monotonic() + 20
        while True:
            try:
                ready = client.get(origin + "/readiness")
                ready.raise_for_status()
                break
            except (httpx.ConnectError, httpx.HTTPStatusError):
                if host.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError("Official local host did not become ready")
                time.sleep(0.1)
        sid = str(uuid4())

        def invoke(path="/api/bootstrap", body=None):
            response = client.post(
                origin + "/invocations", params={"agent_session_id": sid},
                json={"method": "GET" if body is None else "POST", "path": path,
                      **({"body": body} if body is not None else {})},
            )
            response.raise_for_status()
            return response.json()

        assert invoke()["state"]["turns"] == 0
        nonce = invoke("/api/voice/session", {})["nonce"]
        with connect(f"ws://127.0.0.1:{port}/invocations_ws?agent_session_id={sid}&nonce={nonce}",
                     proxy=None, open_timeout=10) as ws:
            assert json.loads(ws.recv(timeout=5))["type"] == "ready"
            ws.send(bytes(480))
            for _ in range(8):
                event = json.loads(ws.recv(timeout=5))
                if event["type"] == "result":
                    break
            else:
                raise AssertionError("No offline voice result")
            ws.send(json.dumps({"type": "stop"}))
        deadline = time.monotonic() + 3
        while True:
            state = invoke()
            if not state["pending"]:
                break
            if time.monotonic() > deadline:
                raise AssertionError("Voice turn lock did not settle")
            time.sleep(0.05)
        assert state["state"]["turns"] == 1
        assert len(state["history"]) == 2
        print(json.dumps({
            "officialSdk": "azure-ai-agentserver-invocations 1.2.0",
            "transport": "real Hypercorn loopback HTTP + WebSocket",
            "readiness": ready.status_code,
            "sameSessionTextVoice": True,
            "binaryPcmAndJsonControl": True,
            "cloudCalls": 0,
            "azureAcceptanceVerified": False,
        }))
finally:
    if host is not None:
        host.terminate()
        host.wait(timeout=10)
    worker.terminate()
    worker.wait(timeout=10)
    worker.stdout.close()
