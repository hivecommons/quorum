"""API smoke for the shared Vexa service, run INSIDE a throwaway Pod in `meetings` by smoke.sh.

Standard library only. The tenant key comes from $API_KEY (a secretKeyRef); it is never printed.

Against a bot sent to a Meet code that does not exist, it checks that:
  * GET /health answers 200;
  * /ws accepts the key and delivers a meeting.status frame for the bot;
  * POST /bots/google_meet/<id>/chat exists (a 4xx about the bot's state, not a 404 for a missing
    route);
  * the bot is sent with voice (voice_agent_enabled: true), so POST /bots is a 2xx, not the 422
    of a deployment without TTS_SERVICE_URL;
  * POST /bots/google_meet/<id>/speak answers 409 "not in the meeting" (the bot can never be
    admitted), never the voice-disabled 409 or a 404;
  * DELETE /bots/google_meet/<id> stops the bot.
Prints one `CHECK <name> PASS|FAIL <detail>` line per check and exits non-zero on any FAIL.
"""
import base64
import json
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.request

GATEWAY_HOST = os.environ.get("GATEWAY_HOST", "vexa-gateway")
GATEWAY_PORT = int(os.environ.get("GATEWAY_PORT", "8000"))
BASE = f"http://{GATEWAY_HOST}:{GATEWAY_PORT}"
MEET_CODE = os.environ.get("MEET_CODE", "aaa-bbbb-ccc")
PLATFORM = "google_meet"
API_KEY = os.environ["API_KEY"]
HTTP_TIMEOUT = 30
# Seconds to wait for the first meeting.status frame after POST /bots.
STATUS_WAIT = int(os.environ.get("STATUS_WAIT", "90"))
# Seconds to keep reading /ws after DELETE, to see the bot's final status.
TAIL_WAIT = int(os.environ.get("TAIL_WAIT", "20"))
# HTTP status the gateway gives a path no route serves.
NOT_FOUND = 404
CONFLICT = 409
# meeting-api's /speak details: the bot has not been admitted yet / was sent without voice.
SPEAK_NOT_IN_MEETING = "not in the meeting"
VOICE_DISABLED = "not sent with voice_agent_enabled"
WS_OPCODE_TEXT = 0x1
WS_OPCODE_CLOSE = 0x8
WS_OPCODE_PING = 0x9
WS_OPCODE_PONG = 0xA

results = []


def check(name, ok, detail):
    results.append(ok)
    print(f"CHECK {name} {'PASS' if ok else 'FAIL'} {detail}", flush=True)


def route_missing(status, body):
    """FastAPI's answer for a path no route serves (a route's own 404 carries its own detail)."""
    try:
        detail = json.loads(body).get("detail")
    except (ValueError, AttributeError):
        detail = None
    return status == NOT_FOUND and detail == "Not Found"


def api(method, path, body=None):
    req = urllib.request.Request(
        BASE + path, method=method,
        headers={"X-API-Key": API_KEY, "Content-Type": "application/json"},
        data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
            return r.status, r.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")


class WS:
    """Minimal RFC 6455 client: text frames in and out, masks what it sends, answers pings."""

    def __init__(self, host, port, path, headers):
        self.sock = socket.create_connection((host, port), timeout=HTTP_TIMEOUT)
        key = base64.b64encode(os.urandom(16)).decode()
        lines = [f"GET {path} HTTP/1.1", f"Host: {host}:{port}", "Upgrade: websocket",
                 "Connection: Upgrade", f"Sec-WebSocket-Key: {key}", "Sec-WebSocket-Version: 13"]
        lines += [f"{k}: {v}" for k, v in headers.items()]
        self.sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = self.sock.recv(4096)
            if not chunk:
                break
            resp += chunk
        head, _, self.buf = resp.partition(b"\r\n\r\n")
        self.status_line = head.split(b"\r\n", 1)[0].decode(errors="replace")
        self.lock = threading.Lock()

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("socket closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _send(self, opcode, payload):
        mask = os.urandom(4)
        n = len(payload)
        hdr = bytes([0x80 | opcode])
        if n < 126:
            hdr += bytes([0x80 | n])
        elif n < 65536:
            hdr += bytes([0x80 | 126]) + n.to_bytes(2, "big")
        else:
            hdr += bytes([0x80 | 127]) + n.to_bytes(8, "big")
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        with self.lock:
            self.sock.sendall(hdr + mask + masked)

    def send_text(self, text):
        self._send(WS_OPCODE_TEXT, text.encode())

    def recv(self):
        """Next text frame, or None when the server closed."""
        while True:
            b1, b2 = self._read(2)
            opcode, n = b1 & 0x0F, b2 & 0x7F
            if n == 126:
                n = int.from_bytes(self._read(2), "big")
            elif n == 127:
                n = int.from_bytes(self._read(8), "big")
            mask = self._read(4) if b2 & 0x80 else None
            payload = self._read(n)
            if mask:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            if opcode == WS_OPCODE_PING:
                self._send(WS_OPCODE_PONG, payload)
                continue
            if opcode == WS_OPCODE_CLOSE:
                return None
            if opcode == WS_OPCODE_TEXT:
                return payload.decode(errors="replace")


def main():
    st, body = api("GET", "/health")
    check("health", st == 200, f"HTTP {st}")

    ws = WS(GATEWAY_HOST, GATEWAY_PORT, "/ws", {"X-API-Key": API_KEY})
    check("ws_connect", " 101 " in ws.status_line + " ", ws.status_line)
    frames = []

    def reader():
        while True:
            try:
                f = ws.recv()
            except Exception:  # noqa: BLE001 - socket gone, stop reading
                return
            if f is None:
                return
            frames.append((time.time(), f))

    threading.Thread(target=reader, daemon=True).start()

    st, body = api("POST", "/bots", {"platform": PLATFORM, "native_meeting_id": MEET_CODE,
                                     "voice_agent_enabled": True})
    check("bot_create_voice", st in (200, 201), f"HTTP {st} {body[:200]}")
    ws.send_text(json.dumps({"action": "subscribe",
                             "meetings": [{"platform": PLATFORM, "native_id": MEET_CODE}]}))

    # The chat and speak routes, while the bot is booting/joining (it can never be admitted).
    path = f"/bots/{PLATFORM}/{MEET_CODE}"
    st, body = api("POST", f"{path}/chat", {"text": "quorum smoke"})
    check("chat_route", 400 <= st < 500 and not route_missing(st, body), f"HTTP {st} {body[:200]}")
    st, body = api("POST", f"{path}/speak", {"text": "quorum smoke"})
    check("speak_route", st == CONFLICT and SPEAK_NOT_IN_MEETING in body
          and VOICE_DISABLED not in body, f"HTTP {st} {body[:200]}")

    deadline = time.time() + STATUS_WAIT
    status_frame = None
    while time.time() < deadline and status_frame is None:
        for _, f in list(frames):
            try:
                d = json.loads(f)
            except ValueError:
                continue
            if d.get("type") == "meeting.status":
                status_frame = d
                break
        time.sleep(1)
    kinds = sorted({(json.loads(f).get("type") if f.startswith("{") else "?") for _, f in frames})
    subscribed = any('"subscribed"' in f and MEET_CODE in f for _, f in frames)
    check("ws_subscribe", subscribed, "subscribed ack for the bot's meeting")
    check("ws_meeting_status", status_frame is not None,
          f"frame={json.dumps(status_frame)[:300] if status_frame else None} types_seen={kinds}")

    st, body = api("DELETE", path)
    check("bot_delete", st in (200, 202, 204), f"HTTP {st} {body[:200]}")
    time.sleep(TAIL_WAIT)
    statuses = []
    for _, f in frames:
        try:
            d = json.loads(f)
        except ValueError:
            continue
        if d.get("type") == "meeting.status":
            statuses.append((d.get("payload") or {}).get("status") or d.get("status"))
    print(f"ws status sequence: {statuses}", flush=True)
    for _, f in frames:
        if '"error"' in f or '"subscribed"' in f:
            print(f"ws frame: {f[:300]}", flush=True)
    st, body = api("GET", "/bots/status")
    print(f"GET /bots/status HTTP {st} {body[:300]}", flush=True)
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
