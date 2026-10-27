// ColdChain sensor node.
//
// Every interval the node reads its sensors, appends the reading to a queue file in flash (LittleFS) and then
// uploads as much of the queue as it can. When Wi-Fi or the server is down, readings pile up in the queue and
// are sent, with their original timestamps, once the connection is back - so the record has no gaps.
//
// The server answers each upload with the reading interval and the alert limits; the node uses the limits to
// sound its buzzer locally, which still works when the network does not.
//
// Sensors found at boot:
//   SHT4x on I2C  -> "temp" (°C) and "hum" (%RH)   ambient / server room / store room
//   DS18B20 probes -> "probe1", "probe2", ...       inside fridges and freezers (down to -55 °C)

#include <Arduino.h>
#include <ArduinoJson.h>
#include <DallasTemperature.h>
#include <HTTPClient.h>
#include <LittleFS.h>
#include <OneWire.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WiFiManager.h>
#include <Wire.h>
#include <esp_task_wdt.h>
#include <esp_timer.h>
#include <time.h>

#include <Adafruit_SHT4x.h>

#include "config.h"

static const char *QUEUE_FILE = "/queue.jsonl";
static const char *QUEUE_TMP = "/queue.tmp";
static const time_t MIN_VALID_EPOCH = 1704067200;   // 2024-01-01: anything earlier means NTP has not synced

struct Limit {
  String key;
  bool hasMin = false, hasMax = false;
  float min = 0, max = 0;
};

Preferences prefs;
String serverUrl, deviceSerial, deviceKey;
uint32_t intervalS = DEFAULT_INTERVAL_S;
uint32_t bootCount = 0;

Adafruit_SHT4x sht;
bool shtOk = false;
OneWire oneWire(PIN_ONEWIRE);
DallasTemperature probes(&oneWire);
uint8_t probeCount = 0;

Limit limits[8];
uint8_t limitCount = 0;
bool alarmActive = false;
uint64_t alarmSilencedUntil = 0;

uint64_t lastReadingMs = 0;
uint64_t lastWifiRetryMs = 0;
uint64_t buttonDownMs = 0;

static uint64_t uptimeMs() { return esp_timer_get_time() / 1000ULL; }

// --- Configuration ------------------------------------------------------------------------------------------

void loadConfig() {
  prefs.begin("coldchain", false);
  serverUrl = prefs.getString("server", "");
  deviceSerial = prefs.getString("serial", "");
  deviceKey = prefs.getString("key", "");
  intervalS = prefs.getUInt("interval", DEFAULT_INTERVAL_S);
  bootCount = prefs.getUInt("boots", 0) + 1;
  prefs.putUInt("boots", bootCount);
}

bool configured() { return serverUrl.length() && deviceSerial.length() && deviceKey.length(); }

void runSetupPortal() {
  Serial.println("[setup] starting Wi-Fi setup portal " SETUP_AP_NAME);
  digitalWrite(PIN_LED, HIGH);
  esp_task_wdt_delete(NULL);                      // the portal blocks; do not let the watchdog reset us

  WiFiManager wm;
  WiFiManagerParameter pServer("server", "Server URL (e.g. https://monitor.example.com)", serverUrl.c_str(), 120);
  WiFiManagerParameter pSerial("serial", "Device serial (CC-XXXXXX)", deviceSerial.c_str(), 32);
  WiFiManagerParameter pKey("key", "Device key", deviceKey.c_str(), 64);
  wm.addParameter(&pServer);
  wm.addParameter(&pSerial);
  wm.addParameter(&pKey);
  wm.setConfigPortalTimeout(SETUP_PORTAL_TIMEOUT_S);
  wm.setBreakAfterConfig(true);                   // save the fields even if the Wi-Fi test fails
  wm.startConfigPortal(SETUP_AP_NAME);

  serverUrl = String(pServer.getValue());
  serverUrl.trim();
  while (serverUrl.endsWith("/")) serverUrl.remove(serverUrl.length() - 1);
  deviceSerial = String(pSerial.getValue());
  deviceSerial.trim();
  deviceKey = String(pKey.getValue());
  deviceKey.trim();
  prefs.putString("server", serverUrl);
  prefs.putString("serial", deviceSerial);
  prefs.putString("key", deviceKey);

  esp_task_wdt_add(NULL);
  digitalWrite(PIN_LED, LOW);
  Serial.printf("[setup] server=%s serial=%s\n", serverUrl.c_str(), deviceSerial.c_str());
}

// --- Sensors ------------------------------------------------------------------------------------------------

void initSensors() {
#ifndef SIMULATE_SENSORS
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  shtOk = sht.begin(&Wire);
  if (shtOk) {
    sht.setPrecision(SHT4X_HIGH_PRECISION);
    sht.setHeater(SHT4X_NO_HEATER);
  }
  probes.begin();
  probes.setResolution(12);
  probeCount = probes.getDeviceCount();
#endif
  Serial.printf("[sensors] SHT4x %s, %u DS18B20 probe(s)\n", shtOk ? "found" : "not found", probeCount);
}

// Fills `values` with one entry per channel; a failed read is sent as null so the server can tell.
void readSensors(JsonObject values) {
#ifdef SIMULATE_SENSORS
  float t = uptimeMs() / 1000.0f;
  values["temp"] = 5.0f + 1.2f * sinf(t / 1800.0f) + random(-15, 15) / 100.0f;
  values["hum"] = 55.0f + 5.0f * sinf(t / 2400.0f);
#else
  if (shtOk) {
    sensors_event_t hum, temp;
    if (sht.getEvent(&hum, &temp)) {
      values["temp"] = roundf(temp.temperature * 100) / 100;
      values["hum"] = roundf(hum.relative_humidity * 10) / 10;
    } else {
      values["temp"] = nullptr;
      values["hum"] = nullptr;
    }
  }
  if (probeCount) {
    probes.requestTemperatures();
    for (uint8_t i = 0; i < probeCount; i++) {
      float c = probes.getTempCByIndex(i);
      String key = "probe" + String(i + 1);
      if (c == DEVICE_DISCONNECTED_C || c == 85.0f)      // 85 °C is the DS18B20 power-on value, not a reading
        values[key] = nullptr;
      else
        values[key] = roundf(c * 100) / 100;
    }
  }
#endif
}

int mainsPower() {
  if (PIN_MAINS_SENSE < 0) return -1;
  return digitalRead(PIN_MAINS_SENSE) == HIGH ? 1 : 0;
}

float batteryPercent() {
  if (PIN_BATTERY_ADC < 0) return -1;
  float v = analogReadMilliVolts(PIN_BATTERY_ADC) * BATTERY_DIVIDER / 1000.0f;
  if (v < 2.5f) return -1;                                 // no cell fitted
  return constrain((v - 3.3f) / (4.2f - 3.3f) * 100.0f, 0.0f, 100.0f);
}

// --- Local alarm --------------------------------------------------------------------------------------------

void updateAlarm(JsonObject values) {
  bool breach = false;
  for (uint8_t i = 0; i < limitCount; i++) {
    JsonVariant v = values[limits[i].key];
    if (v.isNull()) continue;
    float x = v.as<float>();
    if ((limits[i].hasMin && x < limits[i].min) || (limits[i].hasMax && x > limits[i].max)) breach = true;
  }
  if (breach && !alarmActive) Serial.println("[alarm] value out of range");
  alarmActive = breach;
}

void driveIndicators() {
  uint64_t now = uptimeMs();
  bool sounding = alarmActive && now >= alarmSilencedUntil;
  if (PIN_BUZZER >= 0) digitalWrite(PIN_BUZZER, sounding && (now / 250) % 8 < 2 ? HIGH : LOW);
  uint32_t period = alarmActive ? 200 : 2000;
  digitalWrite(PIN_LED, (now % period) < period / 10 ? HIGH : LOW);
}

void applyServerConfig(JsonDocument &res) {
  if (res["interval_seconds"].is<uint32_t>()) {
    uint32_t s = res["interval_seconds"].as<uint32_t>();
    if (s >= 10 && s <= 3600 && s != intervalS) {
      intervalS = s;
      prefs.putUInt("interval", intervalS);
      Serial.printf("[config] interval now %us\n", intervalS);
    }
  }
  JsonObject sensors = res["sensors"].as<JsonObject>();
  if (sensors.isNull()) return;
  limitCount = 0;
  for (JsonPair kv : sensors) {
    if (limitCount >= 8) break;
    Limit &l = limits[limitCount++];
    l.key = kv.key().c_str();
    l.hasMin = !kv.value()["min"].isNull();
    l.hasMax = !kv.value()["max"].isNull();
    l.min = kv.value()["min"] | 0.0f;
    l.max = kv.value()["max"] | 0.0f;
  }
}

// --- Queue --------------------------------------------------------------------------------------------------

// Drops roughly the oldest quarter of the queue so the newest data always fits.
void trimQueue() {
  File in = LittleFS.open(QUEUE_FILE, "r");
  if (!in) return;
  size_t skip = in.size() / 4;
  in.seek(skip);
  in.readStringUntil('\n');                                // finish the partial line
  File out = LittleFS.open(QUEUE_TMP, "w");
  uint8_t buf[512];
  while (in.available()) out.write(buf, in.read(buf, sizeof(buf)));
  in.close();
  out.close();
  LittleFS.remove(QUEUE_FILE);
  LittleFS.rename(QUEUE_TMP, QUEUE_FILE);
  Serial.println("[queue] full: dropped oldest readings");
}

void enqueue(const String &line) {
  File f = LittleFS.open(QUEUE_FILE, "a");
  if (f && f.size() + line.length() > QUEUE_MAX_BYTES) {
    f.close();
    trimQueue();
    f = LittleFS.open(QUEUE_FILE, "a");
  }
  if (!f) {
    Serial.println("[queue] cannot open queue file");
    return;
  }
  f.println(line);
  f.close();
}

// Removes the first `bytes` bytes (the lines just uploaded) from the queue.
void consumeQueue(size_t bytes) {
  File in = LittleFS.open(QUEUE_FILE, "r");
  if (!in) return;
  if (bytes >= in.size()) {
    in.close();
    LittleFS.remove(QUEUE_FILE);
    return;
  }
  in.seek(bytes);
  File out = LittleFS.open(QUEUE_TMP, "w");
  uint8_t buf[512];
  while (in.available()) out.write(buf, in.read(buf, sizeof(buf)));
  in.close();
  out.close();
  LittleFS.remove(QUEUE_FILE);
  LittleFS.rename(QUEUE_TMP, QUEUE_FILE);
}

// --- Upload -------------------------------------------------------------------------------------------------

// Sends one batch from the head of the queue. Returns true when the batch was accepted and more may remain.
bool uploadBatch() {
  File f = LittleFS.open(QUEUE_FILE, "r");
  if (!f || f.size() == 0) {
    if (f) f.close();
    return false;
  }
  String body = "{\"readings\":[";
  size_t consumed = 0;
  int n = 0;
  while (f.available() && n < MAX_BATCH) {
    String line = f.readStringUntil('\n');
    consumed = f.position();
    line.trim();
    if (!line.length()) continue;
    if (n++) body += ',';
    body += line;
  }
  bool more = f.available();
  f.close();

  int mains = mainsPower();
  float battery = batteryPercent();
  body += "],\"firmware\":\"" FW_VERSION "\",\"network\":\"wifi\",\"rssi\":" + String(WiFi.RSSI());
  body += ",\"uptime_ms\":" + String((unsigned long long)uptimeMs()) + ",\"boot\":" + String(bootCount);
  if (mains >= 0) body += String(",\"mains_power\":") + (mains ? "true" : "false");
  if (battery >= 0) body += ",\"battery_pct\":" + String(battery, 0);
  body += "}";

  HTTPClient http;
  WiFiClient plain;
  WiFiClientSecure secure;
  // TODO(production): pin the server's root CA with secure.setCACert() instead of skipping verification.
  secure.setInsecure();
  String url = serverUrl + "/api/device/ingest";
  bool ok = url.startsWith("https://") ? http.begin(secure, url) : http.begin(plain, url);
  if (!ok) return false;
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Serial", deviceSerial);
  http.addHeader("X-Device-Key", deviceKey);
  int code = http.POST(body);
  String response = code > 0 ? http.getString() : "";
  http.end();

  if (code == 200) {
    consumeQueue(consumed);
    JsonDocument res;
    if (!deserializeJson(res, response)) applyServerConfig(res);
    Serial.printf("[upload] %d reading(s) sent\n", n);
    return more;
  }
  if (code == 401) Serial.println("[upload] 401: wrong serial or key - hold BOOT for 5 s to re-enter them");
  else if (code == 422) {
    Serial.println("[upload] 422: server rejected the batch; dropping it");
    consumeQueue(consumed);                                 // never block the queue on one bad batch
  } else Serial.printf("[upload] failed: %d %s\n", code, code < 0 ? http.errorToString(code).c_str() : "");
  return false;
}

void takeReading() {
  JsonDocument doc;
  time_t now = time(nullptr);
  if (now >= MIN_VALID_EPOCH) {
    doc["ts"] = (uint32_t)now;
  } else {
    doc["up"] = (unsigned long long)uptimeMs();
    doc["boot"] = bootCount;
  }
  JsonObject values = doc["values"].to<JsonObject>();
  readSensors(values);
  updateAlarm(values);
  String line;
  serializeJson(doc, line);
  enqueue(line);
  Serial.println("[reading] " + line);
}

// --- Main ---------------------------------------------------------------------------------------------------

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.printf("\nColdChain node %s\n", FW_VERSION);
  pinMode(PIN_LED, OUTPUT);
  pinMode(PIN_BUTTON, INPUT_PULLUP);
  if (PIN_BUZZER >= 0) pinMode(PIN_BUZZER, OUTPUT);
  if (PIN_MAINS_SENSE >= 0) pinMode(PIN_MAINS_SENSE, INPUT);

  esp_task_wdt_init(WATCHDOG_S, true);
  esp_task_wdt_add(NULL);

  if (!LittleFS.begin(true)) Serial.println("[fs] LittleFS mount failed");
  loadConfig();
  initSensors();

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  if (!configured() || digitalRead(PIN_BUTTON) == LOW) {
    runSetupPortal();
  } else {
    WiFi.begin();                                           // credentials saved by WiFiManager
  }
  configTime(0, 0, "pool.ntp.org", "time.google.com", "time.cloudflare.com");
  lastReadingMs = uptimeMs() - (uint64_t)intervalS * 1000;  // take the first reading straight away
}

void loop() {
  esp_task_wdt_reset();
  uint64_t now = uptimeMs();

  // BOOT button: short press silences the buzzer for 30 min, a 5 s hold reopens the setup portal.
  if (digitalRead(PIN_BUTTON) == LOW) {
    if (!buttonDownMs) buttonDownMs = now;
    if (now - buttonDownMs > 5000) {
      buttonDownMs = 0;
      runSetupPortal();
      WiFi.begin();
    }
  } else if (buttonDownMs) {
    if (now - buttonDownMs > 50) alarmSilencedUntil = now + 30ULL * 60 * 1000;
    buttonDownMs = 0;
  }

  if (now - lastReadingMs >= (uint64_t)intervalS * 1000) {
    lastReadingMs = now;
    takeReading();
    if (WiFi.status() == WL_CONNECTED && configured()) {
      for (int i = 0; i < 5 && uploadBatch(); i++) esp_task_wdt_reset();   // drain a backlog a few batches at a time
    }
  }

  if (WiFi.status() != WL_CONNECTED && now - lastWifiRetryMs > WIFI_RETRY_MS) {
    lastWifiRetryMs = now;
    WiFi.reconnect();
  }

  driveIndicators();
  delay(20);
}
