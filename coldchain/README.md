# ColdChain Monitor

Temperature and humidity monitoring for pharma cold chains (cold rooms, vaccine fridges, freezers, warehouses)
and server rooms. ESP32 sensor nodes report every minute. The server alerts the right people by **email,
WhatsApp and SMS** when a reading goes out of range, the power fails or a device goes silent. If nobody
acknowledges an alert, it escalates to the next level.

> **اردو خلاصہ:** اسٹاک اور کولنگ: ERP جب بتائے کہ کسی فریج، چلر یا کولڈ روم کا اسٹاک ختم ہو گیا ہے تو سسٹم اس کے ٹمپریچر الرٹ روک دیتا ہے۔ اگر ایڈمن نے اس ڈیوائس کے لیے "Switch cooling off when empty" آن کیا ہو تو 30 منٹ کی مہلت کے بعد ڈیوائس relay کے ذریعے کولنگ بند کر دیتی ہے، اور ERP کے "stocked" بھیجتے ہی کولنگ واپس آن ہو جاتی ہے۔ خالی ہونے پر ڈیٹا بھیجتے رہنا اختیاری ہے۔ حفاظت کے لیے relay اس طرح لگتا ہے کہ ڈیوائس خراب ہو یا بجلی جائے تو کولنگ آن ہی رہے، اور سرور سے ایک گھنٹہ رابطہ نہ ہو تو ڈیوائس خود کولنگ آن کر دیتی ہے۔
>
> **مزید خلاصہ:** یہ سسٹم دو حصوں پر مشتمل ہے۔ (1) `backend/` سرور اور ڈیش بورڈ ہے، جہاں آپ سائٹس اور ڈیوائسز بناتے ہیں، min/max حدیں سیٹ کرتے ہیں اور الرٹ وصول کرنے والے لوگ (لیول 1، 2، 3) شامل کرتے ہیں۔ (2) `firmware/` ESP32 ڈیوائس کا کوڈ ہے، جو ہر منٹ (یا جو وقفہ آپ ڈیش بورڈ سے سیٹ کریں) ریڈنگ لیتا ہے۔ انٹرنیٹ نہ ہو تو ریڈنگز اپنی میموری میں محفوظ رکھتا ہے اور کنکشن بحال ہوتے ہی سب بھیج دیتا ہے۔ ٹمپریچر حد سے باہر جائے، بجلی چلی جائے یا ڈیوائس بند ہو جائے تو متعلقہ ٹیم کو WhatsApp، SMS اور Email پر الرٹ جاتا ہے۔ 15 منٹ تک کوئی acknowledge نہ کرے تو الرٹ اگلے لیول (مینیجر) کو چلا جاتا ہے۔

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
| **Stock-aware cooling** | The ERP reports an appliance empty or stocked (`POST /api/erp/stock`, API key). Empty pauses temperature and power alerts. If enabled per appliance, cooling switches off after a 30-min grace period and comes back on when restocked. HIGH alerts wait while it pulls back into range. Recording while empty is optional (heartbeat only). Full stock history |
| Firmware updates (OTA) | Upload a `firmware.bin`, roll it out to one device or to all. Devices download over Wi-Fi with an MD5 check |
| Security | The device verifies the server certificate (embedded Mozilla roots). Device and ERP keys are stored hashed and shown once |
| 4G fallback | `esp32dev-4g` build with a SIMCom A7670: uploads over cellular when Wi-Fi is down |
| Printable report | Sensor page → **Print / PDF**: chart, summary, MKT, excursions and sign-off lines for inspections |

## Run the server

```bash
cd coldchain/backend
python -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env            # set ADMIN_PASSWORD and JWT_SECRET at least
uvicorn app.main:app --reload   # http://localhost:8000
pytest                          # 23 tests: ingestion, delays, escalation, power/offline, reports, ERP, OTA
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

Stop the simulator and the device goes OFFLINE after 5 minutes. Add `--relay` to make the simulator obey
cooling on/off from the server (the temperature drifts up while cooling is off).

## ERP integration: switch cooling off when stock runs out

1. **ERP** page → create an API key and put it in the ERP.
2. **Sites & devices** → a device's settings: set its **ERP code** (the ERP's own ID for that fridge or cold
   room), tick **Switch cooling off when empty**, and choose whether to **keep recording while empty**.
3. The ERP calls the API when stock hits zero and again when goods are booked in:

```
POST /api/erp/stock
X-API-Key: cck_...
{"device": "WH1-FRIDGE-03", "state": "empty", "reference": "GIN-10293"}     # or "quantity": 0
{"device": "WH1-FRIDGE-03", "state": "stocked", "reference": "GRN-5521"}
{"updates": [ ... up to 200 ... ]}
GET  /api/erp/stock                                                          # state of every appliance
```

What happens:

| Event | Server | Device |
|---|---|---|
| ERP: empty | Marks it EMPTY and closes open HIGH/LOW/POWER alerts. No temperature alerts while empty. Tells level-1 contacts | Local buzzer limits cleared |
| +30 min (`COOLING_OFF_DELAY_MINUTES`), only if opted in | `cooling: "off"` in each upload response | Energises the relay, so cooling stops. Reports `cooling: off`, and contacts are told |
| Recording off while empty | `record: false`, interval 15 min | Sends a heartbeat only |
| ERP: stocked | `cooling: "on"` immediately. HIGH alerts held until back in range (max 3 h) | Relay released, so cooling starts |
| No server contact for 1 h | — | Cooling back ON by itself (fail-safe) |

The dashboard can also mark stock by hand, or force cooling on or off. Every change goes to the audit trail
and the stock history. Send **stocked** before the goods arrive, so the appliance has time to cool down.
Without the opt-in, "empty" only pauses alerts and cooling stays on.

**Relay wiring (have an electrician do it):** use a relay module rated for the load, on its **normally-closed
(NC)** contact, switching the **thermostat or contactor control circuit**, not the compressor's power directly.
NC means that when the ESP32 is unpowered, rebooting or broken, the circuit stays closed and cooling runs.
Relay input → GPIO 26 (DevKit) or GPIO 10 (S3). Commercial chillers usually have a remote on/off or
"enable" terminal, which is the right place to connect.

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
 "uptime_ms": 3600000, "boot": 12, "cooling": "on"}
→ {"stored": 3, "server_time": 1730000002, "interval_seconds": 60, "record": true, "cooling": "on",
   "sensors": {"temp": {"min": 2.0, "max": 8.0}, ...},
   "ota": {"version": "0.3.0", "url": "/api/device/firmware/4.bin", "size": 1180000, "md5": "..."}}   # when assigned
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
| 1-channel relay module (opto-isolated, 10 A) | cooling on/off via the NC contact | 300–600 |
| SIMCom **A7670** 4G (LTE Cat-1) board + SIM | uploads when Wi-Fi is down | 4,000–7,000 |

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

Builds: `esp32dev`, `esp32s3`, `esp32dev-sim` (no sensors needed) and `esp32dev-4g` (A7670 modem on
GPIO 16/17, PWRKEY 27; the setup portal also asks for the SIM's APN).

On first boot, the device opens the Wi-Fi network **ColdChain-Setup**. Connect a phone to it, pick the site's
Wi-Fi, and enter the server URL, serial and key. To reopen the portal later, hold **BOOT** for 5 s. A short
press silences the buzzer for 30 min. LED: slow blink = OK, fast blink = out of range, solid = setup portal.

CI (`.github/workflows/coldchain-ci.yml`) builds all four firmware variants and runs the backend tests on every
push. Download `firmware.bin` from the run's artifacts, then upload it on the **Firmware** page to update devices
over the air (`partitions.csv` has two app slots for this, plus a 768 KB queue).

HTTPS: the device checks the server certificate against the root CAs in `include/certs.h` (Let's Encrypt,
Google, Amazon, DigiCert, Sectigo, GlobalSign and others), which covers Render, Cloudflare, AWS and most hosts.
For a server with a private CA, append that CA to the file. It waits for the clock (NTP, or network time on
4G) before its first HTTPS upload. Readings are queued meanwhile.

Licences: the firmware links DallasTemperature and TinyGSM (LGPL). If you sell devices, provide the object
files or source needed to relink them. Everything else is MIT, BSD or Apache-2.0.

## Next steps

1. Bench test on real hardware: Wi-Fi setup, SHT45/DS18B20 readings, the relay with a lamp in place of a
   compressor, the 4G modem with a Jazz/Zong SIM, and one OTA update.
2. Device-side alerts by SMS straight from the 4G modem when the server is unreachable.
3. PT100/MAX31865 for −80 °C, a door-open contact, and a small OLED display.
4. Scheduled PDF reports by email, plus calibration certificates and due dates per sensor.
5. Multi-tenant (one server, many client companies), voice-call alerts at night, and a mobile app with push.
6. Custom PCB (KiCad → JLCPCB/PCBWay) with the relay, modem and battery on board, in a branded enclosure.
