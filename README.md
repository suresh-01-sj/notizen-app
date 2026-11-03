# Notizen — Smart Meeting Scheduler & Alarm Reminders

> **Crafted with ❤️ by Suresh Jourat**

**Notizen** is a lightweight, responsive meeting scheduling and alarm reminder application built with **Python 3.12+**, **FastAPI**, **MongoDB (Compass)**, **WebSockets**, and a modern mobile-first **Progressive Web App (PWA)** frontend.

Notizen allows you to schedule meetings with natural language phrasing or intuitive form pickers, persists meetings in a thread-safe local database, and fires **exact alarm-style reminders** with full-screen alerts, looping dual-tone audio synthesized alarms, and desktop notifications.

---

## 🌟 Key Features

- 📅 **Intelligent Natural Language Scheduling**: Parse phrases such as:
  - *"Lunch with Rahul tomorrow at 1pm"*
  - *"Team sync on Friday at 3pm with Sarah"*
  - *"Design review at 10am"*
- ⏰ **Exact Alarm Engine**: Precise millisecond timers calculate `triggerTime = meetingTime - reminderMinutesBefore`.
- 🔁 **Past-Time & Instant Fallback**: If a trigger time has already elapsed, the alarm safely fires **5 seconds** from now.
- 🔊 **Looping Audio Alarm & Auto-Stop**: Dual-tone synthesized sound (880Hz / 1200Hz) with visual countdown and **60-second auto-stop**.
- 🔔 **Snooze & Dismiss**: Snooze alarms by 5 minutes or dismiss instantly from the modal or desktop notification.
- 📱 **Mobile PWA & Responsive Design**: Seamless layout optimized for both desktop and mobile devices; pairs Date + Time and Offset + Category with sticky action buttons.
- 🔄 **Real-Time WebSockets**: Instant bidirectional updates across all connected browsers and devices.
- ⚡ **MongoDB & Compass Integration**: Live data synchronized directly with MongoDB database `notizen` and collection `notizen_shchedule`.
- 🛡️ **Clean Architecture**: Decoupled schemas, pure function endpoints, implicit namespace packages without unnecessary `__init__.py` files, and 100% passing test coverage.

---

## 🏗️ Architecture & Project Structure

```
notizen/
├── README.md                        # Master documentation & developer guide
├── requirements.txt                 # Project dependencies
├── run.py                           # Application launcher (PC & mobile Wi-Fi)
├── api/
│   ├── app.py                       # FastAPI REST API endpoints & WebSocket handler
│   └── schemas.py                   # Pydantic models & WebSocket ConnectionManager
├── data/
│   ├── models.py                    # Meeting dataclass & serialization
│   └── database.py                  # MongoDB database manager (MongoDB Compass)
├── parser/
│   └── natural_language_parser.py   # Regex & rule-based NLP extraction engine
├── scheduler/
│   └── alarm_scheduler.py           # Exact threading timers & fallback triggers
├── sound/
│   └── alarm_sound.py               # Native audio manager & tones
└── static/                          # Mobile-ready Single Page Application
    ├── index.html                   # Semantic HTML5 UI & PWA manifest link
    ├── manifest.json                # PWA manifest (standalone app configuration)
    ├── sw.js                        # Service worker for offline caching
    ├── css/
    │   └── style.css                # Responsive dark mode glassmorphism styles
    ├── js/
    │   └── app.js                   # Web Audio synthesizer, WebSockets, & UI logic
    └── images/
        ├── notizen_logo.webp        # App brand icon
        ├── icon-192.png             # PWA home screen icon (192x192)
        └── icon-512.png             # PWA splash screen icon (512x512)
```


---

## 🚀 Quick Start

### 1. Prerequisites
- **Python 3.10+** (Python 3.12 recommended)

Install required packages:
```bash
pip install -r requirements.txt
```

### 2. Launch the Application

#### Standard Mode (Local PC)
```bash
python run.py
```
This automatically starts the server at `http://127.0.0.1:8000` and opens your default web browser.

#### Mobile Wi-Fi Mode (Phone Access)
```bash
python run.py --mobile
```
Binds the server to `0.0.0.0` and displays your local network IP (e.g., `http://192.168.1.100:8000`). Open that URL on your mobile phone browser while on the same Wi-Fi.

#### Command-Line Options
| Flag | Description | Default |
|---|---|---|
| `--host` | Host interface to bind to | `127.0.0.1` |
| `--port` | Port number to listen on | `8000` |
| `--mobile` | Binds to `0.0.0.0` for phone access | `False` |
| `--no-browser` | Disables auto-launching the web browser | `False` |

---

## 🧠 Natural Language Parsing Rules

The parser (`notizen/parser/natural_language_parser.py`) extracts structured parameters from natural conversational phrases:

| Input Pattern | Extracted Value | Rules & Behavior |
|---|---|---|
| `with Rahul`, `with Priya Sharma` | **Person Name** | Ignores stop-words like `"me"`, `"the"`, and weekdays |
| `at 8`, `at 6:15` | **Time** | Hours 1–7 without AM/PM default to **PM** (e.g. 5 &rarr; 17:00)<br>Hours 8–11 default to **AM** (e.g. 9 &rarr; 09:00) |
| `8pm`, `10:30 am` | **Time** | Explicit 12-hour AM/PM formats |
| `today`, `tomorrow`, `day after tomorrow`| **Date** | Relative dates based on current system time |
| `monday`...`sunday`, `mon`...`sun` | **Date** | Next calendar occurrence of that weekday |
| `on 15`, `on 15th` | **Date** | Specific day of the current (or next) month |
| Time only (e.g. `"Sync at 4pm"`) | **Date + Time** | Uses today; if time has passed, rolls over to tomorrow |
| Remaining text | **Title** | Stripped meeting title (falls back to `"Meeting with <Person>"` if < 3 chars) |

---

## ⏰ Exact Alarm & Notification Logic

1. **Trigger Calculation**:
   $$\text{Trigger Time} = \text{Meeting Time} - \text{Reminder Minutes}$$
2. **Past-Time Protection**: If the calculated trigger time has already passed, the alarm automatically fires in **5 seconds** for testing and prompt notification.
3. **Looping Audio Alarm**:
   - Primary: Dual-tone synthesized oscillator alarm (880 Hz / 1200 Hz urgent pulse) via Web Audio API.
   - Server-side fallback: Native Windows audio loop via `winsound`.
4. **60-Second Auto-Stop**:
   - The full-screen alert modal displays a live animated progress bar.
   - If not dismissed, audio automatically silences after 60 seconds to prevent indefinite ringing.
5. **Reboot & Startup Recovery**:
   - On server startup, the lifespan hook queries all upcoming meetings from `notizen.db` and re-arms timers automatically.

---

## 📡 REST API & WebSockets

### Endpoints

| Method | Endpoint | Description | Payload / Response |
|---|---|---|---|
| `GET` | `/api/meetings` | List meetings with filters | Query: `filter` (`upcoming`/`today`/`past`/`all`), `category`, `search` |
| `POST` | `/api/meetings` | Create and schedule meeting | Body: `MeetingCreateRequest` |
| `GET` | `/api/meetings/{id}` | Retrieve meeting by ID | Returns `Meeting` JSON |
| `PUT` | `/api/meetings/{id}` | Update existing meeting | Body: `MeetingUpdateRequest` |
| `DELETE`| `/api/meetings/{id}` | Delete meeting & cancel alarm | Returns `{"success": true}` |
| `POST` | `/api/meetings/{id}/test-alarm` | Trigger alarm immediately (5s fallback) | Returns updated `Meeting` JSON |
| `POST` | `/api/meetings/{id}/snooze` | Snooze alarm by $N$ minutes | Body: `{"minutes": 5}` |
| `POST` | `/api/alarm/stop` | Stop active alarm sound | Returns `{"status": "stopped"}` |
| `POST` | `/api/parse` | Parse natural language text | Body: `{"text": "..."}` |
| `WS` | `/ws` | Real-time WebSocket connection | Broadcasts `MEETING_CREATED`, `ALARM_TRIGGERED`, etc. |

---

## 📱 Mobile PWA Installation

### Add to Home Screen (Zero Install)
1. Launch with mobile support:
   ```bash
   python run.py --mobile
   ```
2. Open the printed **Mobile URL** (`http://<YOUR_IP>:8000`) on your phone.
3. **Android (Chrome)**: Tap the 3 dots menu `⋮` &rarr; tap **"Add to Home screen"** or **"Install app"**.
4. **iOS (Safari)**: Tap the Share button `⎋` &rarr; tap **"Add to Home Screen"**.

### Access Remotely (Over 4G/5G)
Using a free secure tunnel:
```bash
npx -y localtunnel --port 8000
# or
ngrok http 8000
```
Open the generated HTTPS URL on any mobile device from anywhere in the world.

---

## 👨‍💻 Creator & Attribution

- **Project**: Notizen (Meeting Scheduler & Reminders)
- **Creator**: Suresh Jourat
- **License**: MIT
