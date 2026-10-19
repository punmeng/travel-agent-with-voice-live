"""LOCAL OFFLINE feasibility only. Not an Internet gateway or deployable service."""
import asyncio
import os
import re
from http.cookies import SimpleCookie

import httpx
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.websockets import WebSocket
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidHandshake

ALLOWED = {
    ("GET", "/api/bootstrap"), ("GET", "/api/progress"),
    ("POST", "/api/chat"), ("POST", "/api/select"), ("POST", "/api/reprice"),
    ("POST", "/api/consent"), ("POST", "/api/purchase"), ("POST", "/api/voice/session"),
}


class NodeAdapter:
    def __init__(self, origin):
        if not re.fullmatch(r"http://127\.0\.0\.1:\d+", origin):
            raise ValueError("Loopback worker required")
        self.origin = origin
        self.cookies = {}
        self.lost_sessions = set()
        self.lock = asyncio.Lock()
        self.client = httpx.AsyncClient(timeout=90, follow_redirects=False, trust_env=False)

    def session_id(self, connection):
        query = connection.query_params.get("agent_session_id")
        platform = os.environ.get("FOUNDRY_AGENT_SESSION_ID")
        if query is not None and not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", query):
            raise ValueError("Invalid explicit session")
        if platform and query and platform != query:
            raise ValueError("Session conflict")
        value = platform or getattr(connection.state, "session_id", None) or query
        if not value or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value):
            raise ValueError("Invalid session")
        return value

    async def cookie(self, sid):
        async with self.lock:
            if sid in self.lost_sessions:
                raise ValueError("Session lost; explicit new journey required")
            if sid not in self.cookies:
                if len(self.cookies) >= 8:
                    raise ValueError("Prototype session limit")
                response = await self.client.get(f"{self.origin}/api/bootstrap", headers={"Cookie": ""})
                response.raise_for_status()
                parsed = SimpleCookie()
                parsed.load(response.headers["set-cookie"])
                self.cookies[sid] = f"journey={parsed['journey'].value}"
            return self.cookies[sid]

    async def invoke(self, request: Request):
        try:
            raw = bytearray()
            async for chunk in request.stream():
                raw.extend(chunk)
                if len(raw) > 13000:
                    return JSONResponse({"error": "BODY_LIMIT"}, status_code=413)
            import json
            payload = json.loads(raw)
            if not isinstance(payload, dict) or set(payload) - {"method", "path", "body", "requestId"}:
                raise ValueError("Invalid envelope")
            method, path = payload.get("method"), payload.get("path")
            checkout = method == "GET" and isinstance(path, str) and re.fullmatch(r"/checkout/[a-f0-9]{64}", path)
            if not checkout and (method, path) not in ALLOWED:
                raise ValueError("Operation not allowed")
            sid = self.session_id(request)
            cookie = await self.cookie(sid)
            params = None
            if path == "/api/progress":
                if not re.fullmatch(r"[a-f0-9-]{36}", payload.get("requestId", "")):
                    raise ValueError("Invalid request ID")
                params = {"requestId": payload["requestId"]}
            response = await self.client.request(
                method, self.origin + path, params=params,
                json=payload.get("body", {}) if method == "POST" else None,
                headers={"Cookie": cookie, "Origin": self.origin},
            )
            if "set-cookie" in response.headers:
                self.lost_sessions.add(sid)
                return JSONResponse({"error": "JOURNEY_STATE_LOST"}, status_code=409)
            # Never forward the private worker cookie or rewrite secured checkout HTML.
            return Response(response.content, status_code=response.status_code,
                            headers={"Content-Type": response.headers["content-type"]})
        except (ValueError, KeyError, TypeError):
            return JSONResponse({"error": "ADAPTER_CONTRACT"}, status_code=400)
        except httpx.HTTPError:
            return JSONResponse({"error": "WORKER_UNAVAILABLE"}, status_code=502)

    async def duplex(self, websocket: WebSocket):
        try:
            sid = self.session_id(websocket)
            nonce = websocket.query_params.get("nonce", "")
            if sid not in self.cookies or sid in self.lost_sessions or not re.fullmatch(r"[a-f0-9]{64}", nonce):
                await websocket.close(1008)
                return
            async with connect(
                self.origin.replace("http:", "ws:") + "/api/voice/stream",
                origin=self.origin, additional_headers={"Cookie": self.cookies[sid]},
                subprotocols=["journey-voice", nonce], max_size=1_048_576,
                max_queue=4, write_limit=65536, proxy=None,
            ) as worker:
                async def inbound():
                    while True:
                        frame = await websocket.receive()
                        if frame["type"] == "websocket.disconnect":
                            await worker.close()
                            return
                        data = frame.get("bytes") if frame.get("bytes") is not None else frame.get("text")
                        size = len(data.encode("utf-8")) if isinstance(data, str) else len(data or b"")
                        if data is None or size > 48000:
                            await websocket.close(1009)
                            return
                        await worker.send(data)

                async def outbound():
                    try:
                        async for frame in worker:
                            if isinstance(frame, bytes):
                                await websocket.send_bytes(frame)
                            else:
                                await websocket.send_text(frame)
                    finally:
                        await websocket.close(worker.close_code if worker.close_code in {1000, 1001, 1008, 1009} else 1011)

                tasks = [asyncio.create_task(inbound()), asyncio.create_task(outbound())]
                try:
                    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                    for task in done:
                        task.result()
                finally:
                    for task in tasks:
                        task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
        except ValueError:
            await websocket.close(1008)
        except (OSError, ConnectionClosed, InvalidHandshake):
            await websocket.close(1011)


def make_host(adapter):
    from azure.ai.agentserver.invocations import InvocationAgentServerHost
    host = InvocationAgentServerHost(configure_observability=None, access_log=None)
    host.invoke_handler(adapter.invoke)
    host.ws_handler(adapter.duplex)
    host.shutdown_handler(adapter.client.aclose)
    return host


if __name__ == "__main__":
    if os.environ.get("HOSTED_ADAPTER_OFFLINE") != "true":
        raise RuntimeError("Offline prototype only")
    make_host(NodeAdapter(os.environ["HOSTED_NODE_ORIGIN"])).run(host="127.0.0.1")
