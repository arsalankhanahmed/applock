// Board wiring and tunables. Every pin can be overridden from platformio.ini with -D PIN_xxx=n.
#pragma once

// --- Pins (defaults: classic ESP32 DevKit) ---------------------------------------------------------------
#ifndef PIN_I2C_SDA
#define PIN_I2C_SDA 21          // SHT45 / SHT40 temperature + humidity (I2C address 0x44)
#endif
#ifndef PIN_I2C_SCL
#define PIN_I2C_SCL 22
#endif
#ifndef PIN_ONEWIRE
#define PIN_ONEWIRE 4           // DS18B20 waterproof probes for fridges / freezers, 4.7k pull-up to 3V3
#endif
#ifndef PIN_BUZZER
#define PIN_BUZZER 25           // active buzzer through a transistor; -1 to disable
#endif
#ifndef PIN_LED
#define PIN_LED 2               // on-board LED: slow blink = OK, fast blink = alarm, solid = setup portal
#endif
#ifndef PIN_BUTTON
#define PIN_BUTTON 0            // BOOT button: hold 5 s at any time to reopen the Wi-Fi setup portal
#endif
#ifndef PIN_MAINS_SENSE
#define PIN_MAINS_SENSE 34      // HIGH while the 5 V adapter is powered (divider 10k/20k from 5 V); -1 = not fitted
#endif
#ifndef PIN_BATTERY_ADC
#define PIN_BATTERY_ADC 35      // Li-ion cell through a 100k/100k divider; -1 = not fitted
#endif

#ifndef PIN_COOLING_RELAY
#define PIN_COOLING_RELAY 26    // relay module input; -1 = no cooling control fitted (see README for wiring)
#endif
#ifndef RELAY_ACTIVE_LEVEL
#define RELAY_ACTIVE_LEVEL HIGH // level that ENERGISES the relay, which switches cooling OFF (NC contact)
#endif

// 4G modem (only with -D TINY_GSM_MODEM_SIM7600 / A7672X): UART and power key.
#ifndef PIN_MODEM_RX
#define PIN_MODEM_RX 16         // ESP32 RX  <- modem TX
#endif
#ifndef PIN_MODEM_TX
#define PIN_MODEM_TX 17         // ESP32 TX  -> modem RX
#endif
#ifndef PIN_MODEM_PWRKEY
#define PIN_MODEM_PWRKEY 27     // -1 if the modem board powers up by itself
#endif

// --- Behaviour ----------------------------------------------------------------------------------------------
#ifndef FW_VERSION
#define FW_VERSION "dev"
#endif
#define SETUP_AP_NAME "ColdChain-Setup"
#define SETUP_PORTAL_TIMEOUT_S 300       // give up on the portal after 5 min and keep logging offline
#define DEFAULT_INTERVAL_S 60
#define MAX_BATCH 50                     // readings per upload
#define QUEUE_MAX_BYTES (512 * 1024)     // ~6 days at one reading a minute; oldest dropped beyond this
#define HTTP_TIMEOUT_MS 15000
#define WIFI_RETRY_MS 30000
#define WATCHDOG_S 120
#define BATTERY_DIVIDER 2.0f
// Cooling switched off by the server comes back ON by itself if the server has not been heard for this long,
// so a lost connection can never leave restocked goods without cooling.
#define COOLING_FAILSAFE_MS (60UL * 60 * 1000)
#define OTA_RETRY_MS (60UL * 60 * 1000)  // a failed update is retried at most hourly
// Build with -D TLS_INSECURE to skip certificate checks (testing against a self-signed server only).
