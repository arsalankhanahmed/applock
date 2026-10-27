// ColdChain sensor node.
//
// Every interval the node reads its sensors, appends the reading to a queue file in flash (LittleFS) and then
// uploads as much of the queue as it can. When Wi-Fi or the server is down, readings pile up in the queue and
// are sent, with their original timestamps, once the connection is back - so the record has no gaps.
// Built with a 4G modem (esp32dev-4g, SIMCom A7670), it uploads over cellular whenever Wi-Fi is down; TLS runs
// inside the modem, which is given the same root certificates and told to verify the server.
//
// Each upload response carries the reading interval, the alert limits (used for the local buzzer, which still
// works without a network), whether to keep recording, the cooling command and, when assigned, a firmware update.
//
// Sensors found at boot:
//   SHT4x on I2C  -> "temp" (°C) and "hum" (%RH)   ambient / server room / store room
//   DS18B20 probes -> "probe1", "probe2", ...       inside fridges and freezers (down to -55 °C)
//
// Cooling control: a relay wired through its normally-closed contact. Energised = cooling OFF, so a dead,
// rebooting or unplugged controller always leaves cooling ON. It is only energised while the server says "off"
// and comes back ON by itself after COOLING_FAILSAFE_MS without hearing from the server.

#include <Arduino.h>
#include <ArduinoJson.h>
#include <DallasTemperature.h>
#include <HTTPClient.h>
#include <LittleFS.h>
#include <OneWire.h>
#include <Preferences.h>
#include <Update.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WiFiManager.h>
#include <Wire.h>
#include <esp_task_wdt.h>
#include <esp_timer.h>
#include <sys/time.h>
#include <time.h>

#include <Adafruit_SHT4x.h>

#include "certs.h"
#include "config.h"

#if defined(TINY_GSM_MODEM_A7672X)
#define USE_CELLULAR 1
#include <ArduinoHttpClient.h>
#include <TinyGsmClient.h>
HardwareSerial SerialAT(1);
TinyGsm modem(SerialAT);
TinyGsmClient gsmClient(modem, 0);
TinyGsmClientSecure gsmSecure(modem, 1);
String apn;
bool modemTlsReady = false;
static const char *MODEM_CA_FILE = "coldchain_ca.pem";
#endif

static const char *QUEUE_FILE = "/queue.jsonl";
static const char *QUEUE_TMP = "/queue.tmp";
static const time_t MIN_VALID_EPOCH = 1704067200;   // 2024-01-01: anything earlier means the clock is not set

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

bool recordReadings = true;          // false while the appliance is empty and data sharing is off
bool coolingOff = false;             // relay state
uint64_t lastServerContactMs = 0;

String otaError;                     // reported with the next upload
String otaLastVersion;
uint64_t otaLastAttemptMs = 0;

uint64_t lastReadingMs = 0;
uint64_t lastWifiRetryMs = 0;
uint64_t buttonDownMs = 0;

static uint64_t uptimeMs() { return esp_timer_get_time() / 1000ULL; }
static bool clockValid() { return time(nullptr) >= MIN_VALID_EPOCH; }

// --- Configuration ------------------------------------------------------------------------------------------

void loadConfig() {
  prefs.begin("coldchain", false);
  serverUrl = prefs.getString("server", "");
  deviceSerial = prefs.getString("serial", "");
  deviceKey = prefs.getString("key", "");
  intervalS = prefs.getUInt("interval", DEFAULT_INTERVAL_S);
  bootCount = prefs.getUInt("boots", 0) + 1;
  prefs.putUInt("boots", bootCount);
#ifdef USE_CELLULAR
  apn = prefs.getString("apn", "");
#endif
}

bool configured() { return serverUrl.length() && deviceSerial.length() && deviceKey.length(); }

static String trimmed(const char *value) {
  String s(value);
  s.trim();
  return s;
}

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
#ifdef USE_CELLULAR
  WiFiManagerParameter pApn("apn", "SIM APN (Jazz: jazzconnect.mobilinkworld.com, Zong: zonginternet, "
                                   "Telenor: internet, Ufone: ufone.internet)", apn.c_str(), 64);
  wm.addParameter(&pApn);
#endif
  wm.setConfigPortalTimeout(SETUP_PORTAL_TIMEOUT_S);
  wm.setBreakAfterConfig(true);                   // save the fields even if the Wi-Fi test fails
  wm.startConfigPortal(SETUP_AP_NAME);

  serverUrl = trimmed(pServer.getValue());
  while (serverUrl.endsWith("/")) serverUrl.remove(serverUrl.length() - 1);
  deviceSerial = trimmed(pSerial.getValue());
  deviceKey = trimmed(pKey.getValue());
  prefs.putString("server", serverUrl);
  prefs.putString("serial", deviceSerial);
  prefs.putString("key", deviceKey);
#ifdef USE_CELLULAR
  apn = trimmed(pApn.getValue());
  prefs.putString("apn", apn);
#endif

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

// --- Cooling relay ------------------------------------------------------------------------------------------

void setCooling(bool off, const char *why) {
  if (PIN_COOLING_RELAY < 0 || off == coolingOff) return;
  coolingOff = off;
  digitalWrite(PIN_COOLING_RELAY, off ? RELAY_ACTIVE_LEVEL : !RELAY_ACTIVE_LEVEL);
  Serial.printf("[cooling] %s (%s)\n", off ? "OFF" : "ON", why);
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

// --- Transport ----------------------------------------------------------------------------------------------

struct Url {
  bool https = false;
  String host;
  uint16_t port = 80;
};

Url parseServer() {
  Url u;
  String rest = serverUrl;
  if (rest.startsWith("https://")) {
    u.https = true;
    u.port = 443;
    rest = rest.substring(8);
  } else if (rest.startsWith("http://")) {
    rest = rest.substring(7);
  }
  int slash = rest.indexOf('/');
  if (slash >= 0) rest = rest.substring(0, slash);
  int colon = rest.indexOf(':');
  if (colon >= 0) {
    u.port = rest.substring(colon + 1).toInt();
    rest = rest.substring(0, colon);
  }
  u.host = rest;
  return u;
}

void configureTls(WiFiClientSecure &secure) {
#ifdef TLS_INSECURE
  secure.setInsecure();
#else
  secure.setCACert(ROOT_CAS);
#endif
}

String networkName() {
  if (WiFi.status() == WL_CONNECTED) return "wifi";
#ifdef USE_CELLULAR
  if (modem.isGprsConnected()) return "cellular";
#endif
  return "none";
}

int signalDbm() {
  if (WiFi.status() == WL_CONNECTED) return WiFi.RSSI();
#ifdef USE_CELLULAR
  int csq = modem.getSignalQuality();
  if (csq > 0 && csq < 99) return -113 + 2 * csq;
#endif
  return 0;
}

#ifdef USE_CELLULAR
void modemPowerOn() {
  SerialAT.begin(115200, SERIAL_8N1, PIN_MODEM_RX, PIN_MODEM_TX);
  if (PIN_MODEM_PWRKEY >= 0) {
    pinMode(PIN_MODEM_PWRKEY, OUTPUT);
    digitalWrite(PIN_MODEM_PWRKEY, HIGH);
    delay(100);
    digitalWrite(PIN_MODEM_PWRKEY, LOW);
    delay(1000);
    digitalWrite(PIN_MODEM_PWRKEY, HIGH);
  }
  Serial.println("[4g] modem powering up");
}

// Brings up the data connection (blocking, up to ~70 s). Also sets the clock from the network if unset,
// because certificate checks need the date.
bool cellularConnect() {
  if (modem.isGprsConnected()) return true;
  esp_task_wdt_reset();
  if (!modem.testAT(5000) && !modem.restart()) {
    Serial.println("[4g] modem not responding");
    return false;
  }
  if (!modem.waitForNetwork(60000L)) {
    Serial.println("[4g] no network");
    return false;
  }
  esp_task_wdt_reset();
  if (!modem.gprsConnect(apn.c_str())) {
    Serial.println("[4g] data connection failed - check the APN");
    return false;
  }
  if (!clockValid()) {
    int y, mo, d, h, mi, s;
    float tz;
    if (modem.getNetworkTime(&y, &mo, &d, &h, &mi, &s, &tz) && y >= 2024) {
      struct tm t = {};
      t.tm_year = y - 1900;
      t.tm_mon = mo - 1;
      t.tm_mday = d;
      t.tm_hour = h;
      t.tm_min = mi;
      t.tm_sec = s;
      setenv("TZ", "UTC0", 1);
      tzset();
      struct timeval tv = {mktime(&t) - (time_t)(tz * 3600), 0};
      settimeofday(&tv, nullptr);
      Serial.println("[4g] clock set from network time");
    }
  }
  if (!modemTlsReady) {
    // Load our root certificates into the modem and make it verify the server (authmode 1), which
    // the library does not switch on by itself.
    modemTlsReady = gsmSecure.addCertificate(MODEM_CA_FILE, ROOT_CAS, strlen(ROOT_CAS));
    gsmSecure.setCertificate(MODEM_CA_FILE);
    modem.sendAT(GF("+CSSLCFG=\"authmode\",0,1"));
    modemTlsReady = modem.waitResponse(5000L) == 1 && modemTlsReady;
    if (!modemTlsReady) Serial.println("[4g] could not load certificates into the modem");
  }
  Serial.println("[4g] connected");
  return true;
}

int cellularPost(const Url &u, const String &path, const String &body, String &response) {
#ifndef TLS_INSECURE
  if (u.https && !modemTlsReady) return 0;                // never send the key over unverified TLS
#endif
  Client &client = u.https ? static_cast<Client &>(gsmSecure) : static_cast<Client &>(gsmClient);
  HttpClient http(client, u.host.c_str(), u.port);
  http.setHttpResponseTimeout(HTTP_TIMEOUT_MS);
  http.beginRequest();
  http.post(path);
  http.sendHeader("Content-Type", "application/json");
  http.sendHeader("Content-Length", body.length());
  http.sendHeader("X-Device-Serial", deviceSerial);
  http.sendHeader("X-Device-Key", deviceKey);
  http.beginBody();
  http.print(body);
  http.endRequest();
  int code = http.responseStatusCode();
  response = code > 0 ? http.responseBody() : "";
  http.stop();
  return code;
}
#endif

int wifiPost(const String &path, const String &body, String &response) {
  HTTPClient http;
  WiFiClient plain;
  WiFiClientSecure secure;
  configureTls(secure);
  String url = serverUrl + path;
  bool ok = url.startsWith("https://") ? http.begin(secure, url) : http.begin(plain, url);
  if (!ok) return -1;
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Serial", deviceSerial);
  http.addHeader("X-Device-Key", deviceKey);
  int code = http.POST(body);
  response = code > 0 ? http.getString() : "";
  if (code < 0) Serial.printf("[http] %s\n", HTTPClient::errorToString(code).c_str());
  http.end();
  return code;
}

// POST over Wi-Fi when available, otherwise over 4G (if fitted). Returns the HTTP status, or <= 0.
int postJson(const String &path, const String &body, String &response) {
  Url u = parseServer();
  // Certificate dates cannot be checked before the clock is set; keep queueing until then.
  if (u.https && !clockValid()) {
#ifndef TLS_INSECURE
#ifdef USE_CELLULAR
    if (WiFi.status() != WL_CONNECTED) cellularConnect();     // may set the clock from the network
#endif
    if (!clockValid()) {
      Serial.println("[http] waiting for the clock before using HTTPS");
      return 0;
    }
#endif
  }
  if (WiFi.status() == WL_CONNECTED) return wifiPost(path, body, response);
#ifdef USE_CELLULAR
  if (cellularConnect()) return cellularPost(u, path, body, response);
#endif
  return 0;
}

// --- Firmware update (over Wi-Fi) ---------------------------------------------------------------------------

void performOta(const String &version, const String &path, const String &md5, size_t size) {
  uint64_t now = uptimeMs();
  if (version == otaLastVersion && now - otaLastAttemptMs < OTA_RETRY_MS) return;
  otaLastVersion = version;
  otaLastAttemptMs = now;
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[ota] update waiting for Wi-Fi (not downloaded over 4G)");
    return;
  }
  Serial.printf("[ota] downloading %s (%u bytes)\n", version.c_str(), (unsigned)size);
  esp_task_wdt_delete(NULL);

  HTTPClient http;
  WiFiClient plain;
  WiFiClientSecure secure;
  configureTls(secure);
  String url = serverUrl + path;
  bool ok = url.startsWith("https://") ? http.begin(secure, url) : http.begin(plain, url);
  String error;
  if (!ok) {
    error = "bad url";
  } else {
    http.setTimeout(HTTP_TIMEOUT_MS);
    http.addHeader("X-Device-Serial", deviceSerial);
    http.addHeader("X-Device-Key", deviceKey);
    int code = http.GET();
    if (code != 200) {
      error = "download HTTP " + String(code);
    } else if (!Update.begin(size)) {
      error = String("begin: ") + Update.errorString();
    } else {
      Update.setMD5(md5.c_str());
      size_t written = Update.writeStream(*http.getStreamPtr());
      if (written != size) {
        error = "short download " + String((unsigned)written) + "/" + String((unsigned)size);
        Update.abort();
      } else if (!Update.end()) {
        error = String("verify: ") + Update.errorString();      // includes MD5 mismatch
      }
    }
    http.end();
  }
  esp_task_wdt_add(NULL);
  if (error.length()) {
    otaError = version + ": " + error;
    Serial.printf("[ota] failed: %s\n", otaError.c_str());
    return;
  }
  Serial.println("[ota] installed, restarting");
  delay(500);
  ESP.restart();
}

// --- Server response ----------------------------------------------------------------------------------------

void applyServerConfig(JsonDocument &res) {
  lastServerContactMs = uptimeMs();
  if (!clockValid() && res["server_time"].is<uint32_t>()) {
    // Plain-HTTP servers only (HTTPS needs the clock first); better than no timestamps at all.
    struct timeval tv = {(time_t)res["server_time"].as<uint32_t>(), 0};
    settimeofday(&tv, nullptr);
  }
  if (res["interval_seconds"].is<uint32_t>()) {
    uint32_t s = res["interval_seconds"].as<uint32_t>();
    if (s >= 10 && s <= 3600 && s != intervalS) {
      intervalS = s;
      prefs.putUInt("interval", intervalS);
      Serial.printf("[config] interval now %us\n", intervalS);
    }
  }
  if (res["record"].is<bool>()) {
    bool record = res["record"].as<bool>();
    if (record != recordReadings) Serial.printf("[config] recording %s\n", record ? "resumed" : "paused (empty)");
    recordReadings = record;
  }
  if (res["cooling"].is<const char *>()) setCooling(strcmp(res["cooling"].as<const char *>(), "off") == 0, "server");

  JsonObject sensors = res["sensors"].as<JsonObject>();
  if (!sensors.isNull()) {
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
    if (limitCount == 0) alarmActive = false;
  }

  JsonObject ota = res["ota"].as<JsonObject>();
  if (!ota.isNull()) {
    performOta(ota["version"] | "", ota["url"] | "", ota["md5"] | "", ota["size"] | 0);
  }
}

// --- Queue --------------------------------------------------------------------------------------------------

// Copies the queue from byte `from` onwards into a fresh file (drops everything before it).
void rewriteQueueFrom(size_t from) {
  File in = LittleFS.open(QUEUE_FILE, "r");
  if (!in) return;
  if (from >= in.size()) {
    in.close();
    LittleFS.remove(QUEUE_FILE);
    return;
  }
  in.seek(from);
  File out = LittleFS.open(QUEUE_TMP, "w");
  uint8_t buf[512];
  while (in.available()) out.write(buf, in.read(buf, sizeof(buf)));
  in.close();
  out.close();
  LittleFS.remove(QUEUE_FILE);
  LittleFS.rename(QUEUE_TMP, QUEUE_FILE);
}

// Drops roughly the oldest quarter of the queue so the newest data always fits.
void trimQueue() {
  File in = LittleFS.open(QUEUE_FILE, "r");
  if (!in) return;
  in.seek(in.size() / 4);
  in.readStringUntil('\n');                                // finish the partial line
  size_t from = in.position();
  in.close();
  rewriteQueueFrom(from);
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

// --- Upload -------------------------------------------------------------------------------------------------

// Sends one batch from the head of the queue (or an empty heartbeat when `heartbeat` is set and the queue is
// empty). Returns true when the batch was accepted and more readings remain.
bool uploadBatch(bool heartbeat) {
  String body = "{\"readings\":[";
  size_t consumed = 0;
  int n = 0;
  bool more = false;
  File f = LittleFS.open(QUEUE_FILE, "r");
  if (f) {
    while (f.available() && n < MAX_BATCH) {
      String line = f.readStringUntil('\n');
      consumed = f.position();
      line.trim();
      if (!line.length()) continue;
      if (n++) body += ',';
      body += line;
    }
    more = f.available();
    f.close();
  }
  if (n == 0 && !heartbeat) return false;

  int mains = mainsPower();
  float battery = batteryPercent();
  body += "],\"firmware\":\"" FW_VERSION "\",\"network\":\"" + networkName() + "\"";
  int dbm = signalDbm();
  if (dbm) body += ",\"rssi\":" + String(dbm);
  body += ",\"uptime_ms\":" + String((unsigned long long)uptimeMs()) + ",\"boot\":" + String(bootCount);
  if (mains >= 0) body += String(",\"mains_power\":") + (mains ? "true" : "false");
  if (battery >= 0) body += ",\"battery_pct\":" + String(battery, 0);
  if (PIN_COOLING_RELAY >= 0) body += String(",\"cooling\":\"") + (coolingOff ? "off" : "on") + "\"";
  if (otaError.length()) {
    JsonDocument e;
    e.set(otaError);
    String quoted;
    serializeJson(e, quoted);
    body += ",\"ota_error\":" + quoted;
  }
  body += "}";

  String response;
  int code = postJson("/api/device/ingest", body, response);
  if (code == 200) {
    if (consumed) rewriteQueueFrom(consumed);
    otaError = "";
    Serial.printf("[upload] %d reading(s) sent via %s\n", n, networkName().c_str());
    JsonDocument res;
    if (!deserializeJson(res, response)) applyServerConfig(res);   // may restart for a firmware update
    return more;
  }
  if (code == 401) Serial.println("[upload] 401: wrong serial or key - hold BOOT for 5 s to re-enter them");
  else if (code == 422) {
    Serial.println("[upload] 422: server rejected the batch; dropping it");
    if (consumed) rewriteQueueFrom(consumed);               // never block the queue on one bad batch
  } else if (code != 0) Serial.printf("[upload] failed: %d\n", code);
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
  if (PIN_COOLING_RELAY >= 0) {
    digitalWrite(PIN_COOLING_RELAY, !RELAY_ACTIVE_LEVEL);  // cooling ON from the first instant
    pinMode(PIN_COOLING_RELAY, OUTPUT);
  }

  esp_task_wdt_init(WATCHDOG_S, true);
  esp_task_wdt_add(NULL);

  if (!LittleFS.begin(true)) Serial.println("[fs] LittleFS mount failed");
  loadConfig();
  initSensors();
#ifdef USE_CELLULAR
  modemPowerOn();
#endif

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  if (!configured() || digitalRead(PIN_BUTTON) == LOW) {
    runSetupPortal();
  } else {
    WiFi.begin();                                           // credentials saved by WiFiManager
  }
  configTime(0, 0, "pool.ntp.org", "time.google.com", "time.cloudflare.com");
  lastReadingMs = uptimeMs() - (uint64_t)intervalS * 1000;  // take the first reading straight away
  lastServerContactMs = uptimeMs();
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
    if (recordReadings) takeReading();
    if (configured()) {
      bool more = uploadBatch(true);                        // always check in, even with nothing queued
      for (int i = 0; i < 5 && more; i++) {                 // drain a backlog a few batches at a time
        esp_task_wdt_reset();
        more = uploadBatch(false);
      }
    }
  }

  if (coolingOff && now - lastServerContactMs > COOLING_FAILSAFE_MS) setCooling(false, "failsafe: server silent");

  if (WiFi.status() != WL_CONNECTED && now - lastWifiRetryMs > WIFI_RETRY_MS) {
    lastWifiRetryMs = now;
    WiFi.reconnect();
  }

  driveIndicators();
  delay(20);
}
