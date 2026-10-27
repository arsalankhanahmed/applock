# ColdChain Monitor

Temperature and humidity monitoring for pharma cold chains (cold rooms, vaccine fridges, freezers, warehouses)
and server rooms. ESP32 sensor nodes report every minute. The server alerts the right people by **email,
WhatsApp and SMS** when a reading goes out of range, the power fails or a device goes silent. If nobody
acknowledges an alert, it escalates to the next level.

> **اردو خلاصہ:** یہ سسٹم دو حصوں پر مشتمل ہے۔ (1) `backend/` سرور اور ڈیش بورڈ ہے، جہاں آپ سائٹس اور ڈیوائسز بناتے ہیں، min/max حدیں سیٹ کرتے ہیں اور الرٹ وصول کرنے والے لوگ (لیول 1، 2، 3) شامل کرتے ہیں۔ (2) `firmware/` ESP32 ڈیوائس کا کوڈ ہے، جو ہر منٹ (یا جو وقفہ آپ ڈیش بورڈ سے سیٹ کریں) ریڈنگ لیتا ہے۔ انٹرنیٹ نہ ہو تو ریڈنگز اپنی میموری میں محفوظ رکھتا ہے اور کنکشن بحال ہوتے ہی سب بھیج دیتا ہے۔ ٹمپریچر حد سے باہر جائے، بجلی چلی جائے یا ڈیوائس بند ہو جائے تو متعلقہ ٹیم کو WhatsApp، SMS اور Email پر الرٹ جاتا ہے۔ 15 منٹ تک کوئی acknowledge نہ کرے تو الرٹ اگلے لیول (مینیجر) کو چلا جاتا ہے۔

```
 ESP32 + SHT45 / DS18B20 ──HTTPS (JSON, batched)──▶ FastAPI ──▶ SQLite / PostgreSQL
   ▲ queue in flash while offline                     │
   └── interval + limits come back in each response   ├─▶ alert engine ─▶ Email · WhatsApp · SMS
                                                       └─▶ dashboard (/, served by the same app)
```

## What's in the MVP

| Area | Included |
|---|---|
| Devices | Create a device to get its serial and key (the key is shown once), set Wi-Fi from a phone via a captive portal, change the reading interval from the dashboard, issue a new key |
| Sensors | Detected automatically from the first upload. Min/max limits, an "alert after N minutes" delay so a door opened for a minute doesn't page anyone, and an on/off switch |
| Alerts | HIGH / LOW, **POWER** (device running on battery, i.e. load-shedding), **OFFLINE** (no data). Acknowledge with a note, close manually, auto-resolve when the condition clears |
| Escalation | Level 1 is told first. If the alert is unacknowledged after 15 min it goes to level 2, then 3. At the top level, reminders go out every 30 min |
| Channels | Email (any SMTP), WhatsApp (Meta Cloud API), SMS (Twilio or any HTTP bulk-SMS gateway, e.g. a local aggregator). Each has a `log` mode for testing |
| Offline data | The device stores readings in flash (about 6 days at 1/min) and uploads them with their original timestamps. Excursions found in buffered data are reported once, as an "excursion" |
| Compliance | Append-only audit trail (logins, limit changes, acknowledgements). Per-sensor report with min/max/avg, **MKT**, time-in-range and excursions. CSV export |
| Roles | ADMIN (everything) and OPERATOR (view and acknowledge) |

## Run the server

```bash
cd coldchain/backend
python -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env            # set ADMIN_PASSWORD and JWT_SECRET at least
uvicorn app.main:app --reload   # http://localhost:8000
pytest                          # 15 tests: ingestion, delays, escalation, power/offline, reports
```

Sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`, then:

1. **Sites & devices**: add a site, then add a device. Copy the serial and key it shows.
2. **Contacts**: add people with their level and channels. **Send test** checks that each channel reaches them.
3. Once the device reports, open each sensor and set its limits.

### Try it without hardware

```bash
python tools/simulator.py --serial CC-XXXXXX --key <key> --profile fridge --backfill 24
python tools/simulator.py --serial CC-XXXXXX --key <key> --fault high --fault-after 120   # temperature climbs
python tools/simulator.py --serial CC-XXXXXX --key <key> --fault power                    # mains failure
```

Stop the simulator and the device goes OFFLINE after 5 minutes.

### Deploy

`Dockerfile` runs anywhere: Render, Railway, a VPS, or a PC in the warehouse. For production, use
PostgreSQL (`DATABASE_URL=postgres://...`), put HTTPS in front, and set a long random `JWT_SECRET`. The
dashboard has no external dependencies (Chart.js is bundled), so it also works on a LAN without internet.
If your host sleeps idle apps, set `RUN_BACKGROUND_LOOP=false` and `TICK_TOKEN`, and have a cron call
`POST /api/internal/tick` with header `X-Tick-Token` every minute. Otherwise offline detection stops
while the app sleeps.

**WhatsApp:** create a Meta WhatsApp Business app and get a message template approved (category *Utility*).
The body takes three variables: `{{1}}` location, `{{2}}` alert text, `{{3}}` link. Example:
*"ColdChain alert at {{1}}: {{2}}. Details: {{3}}"*. Then set `WHATSAPP_PROVIDER=meta`, the token, the
phone number ID and `WHATSAPP_TEMPLATE_NAME`.

**SMS in Pakistan:** most bulk-SMS providers (branded "masking" SMS) expose an HTTP GET API. Put it in
`SMS_HTTP_URL` with `{to}` and `{text}` placeholders and set `SMS_PROVIDER=http`.

## Device API

```
POST /api/device/ingest
X-Device-Serial: CC-7F3A2B
X-Device-Key:    <key>
{"readings": [{"ts": 1730000000, "values": {"temp": 4.21, "hum": 51.3, "probe1": -19.8}}],
 "mains_power": true, "battery_pct": 96, "rssi": -61, "network": "wifi", "firmware": "0.1.0",
 "uptime_ms": 3600000, "boot": 12}
→ {"stored": 3, "server_time": 1730000002, "interval_seconds": 60,
   "sensors": {"temp": {"min": 2.0, "max": 8.0}, ...}}
```

The API takes up to 500 readings per request. Duplicates are ignored, so a device can safely resend a batch
whose response it missed. Before NTP has synced, a device sends `up` (its uptime in ms) and `boot` instead
of `ts`, and the server works out the time.

## Hardware (first prototype)

| Part | Use | Approx. PKR |
|---|---|---|
| ESP32 DevKit (WROOM-32) or ESP32-S3 DevKitC | the node | 1,500–3,000 |
| Sensirion **SHT45** (or SHT40/SHT31) breakout | air temperature + humidity, ±0.1 °C | 1,500–3,500 |
| **DS18B20** waterproof probe + 4.7 kΩ resistor | inside fridges/freezers, −55…+125 °C | 300–600 each |
| 18650 Li-ion cell + TP4056/IP5306 charger board | keeps reporting through load-shedding | 800–1,500 |
| Active buzzer + NPN transistor, LED | local alarm | 100 |
| Resistors 10k/20k (mains sense), 100k/100k (battery) | power-fail and battery monitoring | 50 |
| IP65 ABS enclosure, cable gland | — | 500–1,200 |

**Wiring (ESP32 DevKit)**: SHT45 SDA→21, SCL→22, 3V3, GND · DS18B20 data→4 (4.7k to 3V3) · buzzer→25 ·
mains sense→34 (5 V adapter through a 10k/20k divider) · battery→35 (through 100k/100k) · BOOT button = GPIO0.
Pins are in `firmware/include/config.h`, and `platformio.ini` overrides them per board.

For **−80 °C ultra-low freezers**, the DS18B20 is out of range. Use a PT100 probe with a MAX31865 board
(next firmware step).

## Firmware

```bash
cd coldchain/firmware
pio run -e esp32dev -t upload && pio device monitor     # or -e esp32s3, or -e esp32dev-sim (no sensors)
```

On first boot, the device opens the Wi-Fi network **ColdChain-Setup**. Connect a phone to it, pick the site's
Wi-Fi, and enter the server URL, serial and key. To reopen the portal later, hold **BOOT** for 5 s. A short
press silences the buzzer for 30 min. LED: slow blink = OK, fast blink = out of range, solid = setup portal.

CI (`.github/workflows/coldchain-ci.yml`) builds all three firmware variants and runs the backend tests on every
push. Download `firmware.bin` from the run's artifacts.

## Next steps

1. **4G fallback**: SIM7600/A7670 module with TinyGSM, used when Wi-Fi is down. Wi-Fi routers usually die
   with the mains.
2. Verify the server certificate on the device (it currently uses `setInsecure()`) and add OTA firmware updates.
3. PT100/MAX31865 support for −80 °C, a door-open contact, and a small OLED display.
4. Scheduled PDF reports (daily/weekly/monthly) by email, plus per-sensor calibration certificates and due dates.
5. Multi-tenant (one server, many client companies), voice-call alerts at night, and a mobile app with push.
6. Custom PCB (KiCad → JLCPCB/PCBWay) and a branded enclosure.
