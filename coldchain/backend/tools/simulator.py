"""Pretend to be one or more ESP32 devices, for demos and testing without hardware.

    python tools/simulator.py --server http://localhost:8000 --serial CC-XXXXXX --key <secret>
    python tools/simulator.py ... --profile fridge --fault high      # door left open: temperature climbs
    python tools/simulator.py ... --fault power                      # mains fails: device reports battery
    python tools/simulator.py ... --backfill 24                      # upload 24 h of history first
    python tools/simulator.py ... --relay                            # obey cooling on/off from the server

Uses only the standard library, so it runs anywhere Python does.
"""
from __future__ import annotations

import argparse
import json
import math
import random
import sys
import time
import urllib.error
import urllib.request

PROFILES = {
    # name: (temperature centre, swing, humidity centre)
    "fridge": (5.0, 1.2, 55.0),
    "freezer": (-20.0, 1.5, None),
    "ambient": (22.0, 2.0, 50.0),
    "server": (21.0, 1.5, 45.0),
}


def reading(profile: str, t: float, fault: str, fault_age: float, warming: float = 0.0) -> dict:
    centre, swing, hum = PROFILES[profile]
    temp = centre + swing * math.sin(t / 1800) + random.uniform(-0.15, 0.15) + warming
    if fault == "high":
        temp += min(fault_age / 60 * 0.6, 15)          # +0.6 °C per minute, capped
    elif fault == "low":
        temp -= min(fault_age / 60 * 0.6, 15)
    values = {"temp": round(temp, 2)}
    if hum is not None:
        values["hum"] = round(hum + 5 * math.sin(t / 2400) + random.uniform(-1, 1), 1)
    return {"ts": int(t), "values": values}


def post(server: str, serial: str, key: str, body: dict) -> dict:
    req = urllib.request.Request(
        server.rstrip("/") + "/api/device/ingest", data=json.dumps(body).encode(), method="POST",
        headers={"Content-Type": "application/json", "X-Device-Serial": serial, "X-Device-Key": key})
    with urllib.request.urlopen(req, timeout=15) as res:
        return json.loads(res.read())


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--server", default="http://localhost:8000")
    p.add_argument("--serial", required=True)
    p.add_argument("--key", required=True)
    p.add_argument("--profile", choices=PROFILES, default="fridge")
    p.add_argument("--fault", choices=["none", "high", "low", "power"], default="none")
    p.add_argument("--fault-after", type=int, default=0, help="seconds of normal operation before the fault")
    p.add_argument("--backfill", type=float, default=0, help="hours of history to upload first")
    p.add_argument("--once", action="store_true", help="send one batch and exit")
    p.add_argument("--fast", type=float, default=1.0, help="speed-up factor for the live loop")
    p.add_argument("--relay", action="store_true", help="simulate a cooling relay that follows the server")
    args = p.parse_args()

    interval = 60
    if args.backfill:
        now = time.time()
        history = [reading(args.profile, now - s, "none", 0)
                   for s in range(int(args.backfill * 3600), 0, -interval)]
        for i in range(0, len(history), 500):
            post(args.server, args.serial, args.key, {"readings": history[i:i + 500], "firmware": "sim-1.0"})
        print(f"Backfilled {len(history)} readings")

    start = time.time()
    cooling, record, warming = "on", True, 0.0
    while True:
        now = time.time()
        elapsed = now - start
        fault = args.fault if elapsed >= args.fault_after else "none"
        fault_age = elapsed - args.fault_after
        # With cooling off the appliance drifts up towards room temperature; with it on it pulls back down.
        warming = min(warming + 0.5, 20.0) if cooling == "off" else max(warming - 1.0, 0.0)
        readings = [reading(args.profile, now, fault, fault_age, warming)] if record else []
        body = {"readings": readings, "firmware": "sim-1.0",
                "rssi": random.randint(-75, -55), "network": "wifi",
                "mains_power": fault != "power", "battery_pct": 100.0 if fault != "power" else 85.0}
        if args.relay:
            body["cooling"] = cooling
        try:
            res = post(args.server, args.serial, args.key, body)
            interval = res.get("interval_seconds", interval)
            record = res.get("record", True)
            if args.relay and res.get("cooling") in ("on", "off"):
                cooling = res["cooling"]
            sent = body["readings"][0]["values"] if body["readings"] else "heartbeat"
            print(f"{time.strftime('%H:%M:%S')} sent {sent} mains={body['mains_power']} "
                  f"cooling={res.get('cooling')} -> next in {interval}s")
        except urllib.error.HTTPError as exc:
            print(f"HTTP {exc.code}: {exc.read().decode()[:200]}", file=sys.stderr)
            if exc.code == 401:
                return 1
        except urllib.error.URLError as exc:
            print(f"Server unreachable: {exc.reason}", file=sys.stderr)
        if args.once:
            return 0
        time.sleep(interval / args.fast)


if __name__ == "__main__":
    sys.exit(main())
