"""Official SDK ASGI transport + real loopback Node core; no Azure or real speech."""
import asyncio
import json
import os
from pathlib import Path
import subprocess
import unittest
from uuid import uuid4

from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from adapter import NodeAdapter, make_host


class AdapterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.worker = subprocess.Popen(
            ["node", str(Path(__file__).with_name("node-worker.js"))],
            env={**os.environ, "HOSTED_ADAPTER_OFFLINE": "true"},
            stdout=subprocess.PIPE, text=True, encoding="utf-8",
        )
        # The parent test command has an overall deadline; only its own worker is stopped.
        info = json.loads(cls.worker.stdout.readline())
        cls.origin = f"http://127.0.0.1:{info['port']}"

    @classmethod
    def tearDownClass(cls):
        cls.worker.terminate()
        cls.worker.wait(timeout=10)
        cls.worker.stdout.close()

    def setUp(self):
        self.adapter = NodeAdapter(self.origin)

        self.client = TestClient(make_host(self.adapter))
        self.client.__enter__()
        self.sid = str(uuid4())

    def tearDown(self):
        self.client.__exit__(None, None, None)

    def invoke(self, path="/api/bootstrap", body=None, sid=None, method=None):
        return self.client.post(
            "/invocations", params={"agent_session_id": sid or self.sid},
            json={"method": method or ("POST" if body is not None else "GET"),
                  "path": path, **({"body": body} if body is not None else {})},
        )

    def ticket(self):
        response = self.invoke("/api/voice/session", {})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["nonce"]

    def say(self, message, **extra):
        state = self.invoke().json()["state"]
        quote = state["quote"]
        context = {k: quote[k] for k in ["version", "total", "currency", "expiresAt"]} if quote else None
        if context is not None:
            context["quoteId"] = quote["id"]
        response = self.invoke("/api/chat", {
            "message": message, "requestId": str(uuid4()),
            "offerIds": [o["id"] for o in state["offers"]], "quoteContext": context, **extra,
        })
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        text = result["text"]
        for _ in range(60):
            if not result["state"].get("moreReply"):
                return result, text
            response = self.invoke("/api/chat", {"message": "繼續", "requestId": str(uuid4())})
            self.assertEqual(response.status_code, 200, response.text)
            result = response.json()
            text += "\n" + result["text"]
        self.fail("Reply pagination exceeded bound")

    def ws(self, nonce, sid=None):
        return self.client.websocket_connect(
            f"/invocations_ws?agent_session_id={sid or self.sid}&nonce={nonce}")

    def test_http_continuity_isolation_and_idempotency(self):
        first = self.invoke().json()
        self.assertEqual(first["state"]["turns"], 0)
        payload = {"message": "您好", "requestId": str(uuid4())}
        one = self.invoke("/api/chat", payload)
        self.assertEqual(one.status_code, 200, one.text)
        repeated = self.invoke("/api/chat", payload).json()
        first_result = one.json()
        # HTTP correlation IDs intentionally identify each transport request, not the write.
        repeated.pop("correlationId")
        first_result.pop("correlationId")
        self.assertEqual(repeated, first_result)
        self.assertEqual(self.invoke().json()["state"]["turns"], 1)
        self.assertEqual(self.invoke(sid=str(uuid4())).json()["state"]["turns"], 0)
        self.assertNotIn("set-cookie", one.headers)
        self.assertNotIn("journey=", one.text)
        bad = self.invoke("/api/chat", {**payload, "message": "不同"})
        self.assertEqual(bad.status_code, 409)
        self.assertEqual(bad.json()["error"], "IDEMPOTENCY_CONFLICT")

    def test_strict_envelope_and_backend_validation(self):
        self.assertEqual(self.invoke("https://evil.invalid").status_code, 400)
        self.assertEqual(self.invoke("/api/reset", {}).status_code, 400)
        bad = self.client.post("/invocations?agent_session_id=valid", json={
            "method": "GET", "path": "/api/bootstrap", "cookie": "journey=attacker"})
        self.assertEqual(bad.status_code, 400)
        self.assertEqual(self.invoke("/api/chat", {"message": "您好", "role": "price"}).status_code, 400)
        self.assertEqual(self.invoke("/api/purchase", {}).status_code, 400)
        bad = self.client.post("/invocations?agent_session_id=bad%2Fid", json={
            "method": "GET", "path": "/api/bootstrap"})
        self.assertEqual(bad.status_code, 400)

    def test_voice_pcm_text_stop_and_same_session_continuity(self):
        nonce = self.ticket()
        with self.ws(nonce) as socket:
            ready = socket.receive_json()
            self.assertEqual(ready["type"], "ready")
            # This worker's test double converts PCM to the fixed greeting, no cloud ASR/TTS.
            socket.send_bytes(bytes(480))
            events = []
            while not events or events[-1]["type"] != "result":
                events.append(socket.receive_json())
            result = events[-1]
            self.assertTrue(any(e["type"] == "progress" and e["role"] == "intent" for e in events))
            socket.send_json({"type": "displayed", "turnId": result["turnId"]})
            blocked = self.invoke("/api/chat", {"message": "您好"})
            self.assertEqual(blocked.status_code, 409)
            self.assertEqual(blocked.json()["error"], "VOICE_ACTIVE")
            socket.send_json({"type": "mute", "muted": True})
            socket.send_json({"type": "stop"})
            with self.assertRaises(WebSocketDisconnect):
                socket.receive_json()
        state = self.invoke().json()
        self.assertEqual(state["state"]["turns"], 1)
        self.assertEqual(len(state["history"]), 2)
        self.assertEqual(self.invoke("/api/chat", {"message": "您好"}).status_code, 200)

    def test_nonce_is_session_bound_and_single_use(self):
        nonce = self.ticket()
        other = str(uuid4())
        self.invoke(sid=other)
        with self.ws(nonce, other) as socket:
            with self.assertRaises(WebSocketDisconnect):
                socket.receive_json()
        # Internal Node nonce authority consumes attempted wrong-session ticket: no replay.
        with self.ws(nonce) as socket:
            with self.assertRaises(WebSocketDisconnect):
                socket.receive_json()

    def test_missing_worker_journey_fails_closed_instead_of_silent_recovery(self):
        self.invoke()
        self.adapter.cookies[self.sid] = f"journey={uuid4()}"
        response = self.invoke()
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"], "JOURNEY_STATE_LOST")
        self.assertEqual(self.invoke("/api/chat", {"message": "您好"}).status_code, 400)
        with self.ws("a" * 64) as socket:
            with self.assertRaises(WebSocketDisconnect):
                socket.receive_json()

    def test_disallowed_voice_control_does_not_reach_model_or_transaction(self):
        with self.ws(self.ticket()) as socket:
            self.assertEqual(socket.receive_json()["type"], "ready")
            socket.send_json({"type": "purchase", "total": 1})
            event = socket.receive_json()
            self.assertEqual(event["code"], "VOICE_PROTOCOL")
            with self.assertRaises(WebSocketDisconnect):
                socket.receive_json()
        self.assertEqual(self.invoke().json()["state"]["turns"], 0)

    def test_close_disconnects_voice_without_resetting_trip(self):
        self.invoke("/api/chat", {"message": "我想去大阪"})
        with self.ws(self.ticket()) as socket:
            self.assertEqual(socket.receive_json()["type"], "ready")
        # Receive/close bridge cleanup settles on the transport event loop.
        async def settle():
            await asyncio.sleep(0.05)
        self.client.portal.call(settle)
        self.assertEqual(self.invoke("/api/chat", {"message": "您好"}).status_code, 200)
        self.assertGreater(self.invoke().json()["state"]["turns"], 1)

    def test_search_quote_consent_and_checkout_authority_stay_in_node(self):
        trip = {"origin": "TPE", "destination": "NRT", "date": "2026-11-12",
                "returnDate": "2026-11-16", "travelers": 2, "cabin": "economy",
                "budget": 50000, "lowWalking": True, "flexibleDays": 0}
        result, _ = self.say("搜尋航班", trip=trip, action="search")
        self.assertTrue(result["state"]["offers"])
        self.say("選第一班")
        state = self.invoke().json()["state"]
        repriced = self.invoke("/api/reprice", {"offerId": state["selected"]})
        self.assertEqual(repriced.status_code, 200, repriced.text)
        quote = repriced.json()["state"]["quote"]
        consent = {k: quote[k] for k in ["version", "total", "currency", "expiresAt"]}
        consent.update(quoteId=quote["id"], accepted=True)
        # Adapter must not let its alternate route bypass the existing presentation gate.
        rejected = self.invoke("/api/consent", consent)
        self.assertEqual(rejected.status_code, 409)
        self.assertEqual(rejected.json()["error"], "QUOTE_NOT_PRESENTED")
        self.say("重新報價")
        result, text = self.say("我同意這個報價，請給我模擬結帳連結")
        import re
        path = re.search(r"/checkout/[a-f0-9]{64}", text).group()
        page = self.invoke(path)
        self.assertEqual(page.status_code, 200)
        self.assertIn("不接受信用卡", page.text)
        self.assertEqual(self.invoke(path, sid=str(uuid4())).status_code, 404)


if __name__ == "__main__":
    unittest.main(verbosity=2)
