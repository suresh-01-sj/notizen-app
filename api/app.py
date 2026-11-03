import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from data.models import Meeting
from data.database import MeetingDatabase
from parser.natural_language_parser import NaturalLanguageParser
from scheduler.alarm_scheduler import AlarmScheduler
from sound.alarm_sound import AlarmSoundManager
from api.schemas import (
    ConnectionManager,
    ParseRequest,
    MeetingCreateRequest,
    MeetingUpdateRequest,
    SnoozeRequest,
)

logger = logging.getLogger("Notizen")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

# Singletons
db = MeetingDatabase()
sound_manager = AlarmSoundManager.get_instance()
scheduler = AlarmScheduler(db, sound_manager)
ws_manager = ConnectionManager()


# Register trigger callback from scheduler
def on_alarm_triggered(meeting: Meeting):
    logger.info(f"Broadcasting alarm triggered for meeting: {meeting.id} - {meeting.title}")
    ws_manager.broadcast_from_thread({
        "event": "ALARM_TRIGGERED",
        "meeting": meeting.to_dict()
    })


scheduler.register_trigger_callback(on_alarm_triggered)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: capture event loop, reschedule all meetings (Section 7.6)
    ws_manager.set_loop(asyncio.get_running_loop())
    logger.info("Initializing Notizen background alarm scheduler...")
    scheduler.reschedule_all()
    yield
    # Shutdown: stop any active sound & cancel timers
    sound_manager.stop()


app = FastAPI(title="Notizen", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Static files path
BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"


# API Routes
@app.get("/api/meetings")
def get_meetings(
    filter_type: str = Query("upcoming", alias="filter"),
    q: Optional[str] = None
):
    """Fetches meetings based on filter ('upcoming', 'today', 'past', 'all') or search query."""
    if q and q.strip():
        meetings = db.search(q)
    elif filter_type == "today":
        meetings = db.get_today_meetings()
    elif filter_type == "completed":
        meetings = db.get_completed_meetings()
    elif filter_type == "past":
        meetings = db.get_past_meetings()
    elif filter_type == "all":
        meetings = db.get_all_meetings()
    else:
        meetings = db.get_upcoming_meetings()

    return {"meetings": [m.to_dict() for m in meetings]}


@app.post("/api/meetings")
async def create_meeting(req: MeetingCreateRequest):
    """Creates a new meeting and schedules its exact reminder alarm."""
    meeting = Meeting(
        title=req.title.strip(),
        personName=req.personName.strip() if req.personName else "",
        dateTimeMillis=req.dateTimeMillis,
        reminderMinutesBefore=req.reminderMinutesBefore,
        notes=req.notes.strip() if req.notes else "",
        category=req.category.strip() if req.category else "General",
        alarmAudio=req.alarmAudio.strip() if req.alarmAudio else "Default alarm sound",
        isCompleted=False
    )
    meeting_id = db.insert(meeting)
    meeting.id = meeting_id

    # Schedule exact alarm
    scheduler.schedule_reminder(meeting)

    await ws_manager.broadcast({"event": "MEETINGS_UPDATED", "action": "create", "id": meeting_id})
    return {"success": True, "meeting": meeting.to_dict()}


@app.get("/api/meetings/{meeting_id}")
def get_meeting(meeting_id: int):
    meeting = db.get_by_id(meeting_id)
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return {"meeting": meeting.to_dict()}


@app.put("/api/meetings/{meeting_id}")
async def update_meeting(meeting_id: int, req: MeetingUpdateRequest):
    existing = db.get_by_id(meeting_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Meeting not found")

    existing.title = req.title.strip()
    existing.personName = req.personName.strip() if req.personName else ""
    existing.dateTimeMillis = req.dateTimeMillis
    existing.reminderMinutesBefore = req.reminderMinutesBefore
    existing.notes = req.notes.strip() if req.notes else ""
    existing.category = req.category.strip() if req.category else "General"
    if req.alarmAudio is not None:
        existing.alarmAudio = req.alarmAudio.strip() if req.alarmAudio else "Default alarm sound"
    if req.isCompleted is not None:
        existing.isCompleted = req.isCompleted

    success = db.update(existing)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to update meeting")

    # Reschedule alarm (Section 7.5: cancels old alarm and schedules new one)
    if existing.isCompleted:
        scheduler.cancel_reminder(meeting_id)
    else:
        scheduler.schedule_reminder(existing)

    await ws_manager.broadcast({"event": "MEETINGS_UPDATED", "action": "update", "id": meeting_id})
    return {"success": True, "meeting": existing.to_dict()}


@app.delete("/api/meetings/{meeting_id}")
async def delete_meeting(meeting_id: int):
    """Deletes meeting and cancels its scheduled alarm (Section 7.5)."""
    scheduler.cancel_reminder(meeting_id)
    scheduler.dismiss_alarm(meeting_id)
    success = db.delete(meeting_id)
    if not success:
        raise HTTPException(status_code=404, detail="Meeting not found")

    await ws_manager.broadcast({"event": "MEETINGS_UPDATED", "action": "delete", "id": meeting_id})
    return {"success": True}


@app.post("/api/meetings/{meeting_id}/complete")
async def toggle_complete(meeting_id: int, completed: bool = True):
    """Marks meeting completed / uncompleted and updates alarm accordingly."""
    existing = db.get_by_id(meeting_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Meeting not found")

    db.mark_completed(meeting_id, completed)
    if completed:
        scheduler.cancel_reminder(meeting_id)
        scheduler.dismiss_alarm(meeting_id)
    else:
        existing.isCompleted = False
        scheduler.schedule_reminder(existing)

    await ws_manager.broadcast({"event": "MEETINGS_UPDATED", "action": "toggle_complete", "id": meeting_id})
    return {"success": True, "isCompleted": completed}


@app.post("/api/parse")
def parse_natural_language(req: ParseRequest):
    """Parses natural text into meeting parameters with full rule support."""
    parsed = NaturalLanguageParser.parse(req.text)
    return {
        "title": parsed.title,
        "personName": parsed.personName,
        "targetDate": parsed.target_date.isoformat(),
        "targetTime": parsed.target_time.strftime("%H:%M"),
        "dateTimeMillis": parsed.dateTimeMillis,
        "reminderMinutesBefore": parsed.reminderMinutesBefore,
        "rawText": parsed.raw_text
    }


@app.post("/api/alarms/{meeting_id}/dismiss")
async def dismiss_alarm(meeting_id: int):
    """Dismisses active alarm and stops alarm sound (Section 7.4 DismissReceiver)."""
    scheduler.dismiss_alarm(meeting_id)
    await ws_manager.broadcast({"event": "ALARM_DISMISSED", "id": meeting_id})
    return {"success": True}


@app.post("/api/alarms/{meeting_id}/snooze")
async def snooze_alarm(meeting_id: int, req: SnoozeRequest):
    """Snoozes active alarm by N minutes."""
    scheduler.snooze_alarm(meeting_id, req.snoozeMinutes)
    await ws_manager.broadcast({"event": "ALARM_DISMISSED", "id": meeting_id, "snoozed": True})
    return {"success": True, "snoozeMinutes": req.snoozeMinutes}


@app.post("/api/alarms/{meeting_id}/test")
def test_alarm(meeting_id: int):
    """Fires alarm immediately for quick testing."""
    meeting = db.get_by_id(meeting_id)
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    scheduler.trigger_now(meeting_id)
    return {"success": True}


@app.get("/api/alarms/active")
def get_active_alarm():
    """Returns currently ringing meeting ID, if any."""
    is_active = sound_manager.is_playing()
    active_id = sound_manager.active_meeting_id
    meeting_dict = None
    if active_id:
        m = db.get_by_id(active_id)
        if m:
            meeting_dict = m.to_dict()
    return {"isActive": is_active, "meeting": meeting_dict}


# WebSocket endpoint
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await ws_manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)
    except Exception:
        ws_manager.disconnect(websocket)


# Mount static files and SPA route
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
app.mount("/css", StaticFiles(directory=str(STATIC_DIR / "css")), name="css")
app.mount("/js", StaticFiles(directory=str(STATIC_DIR / "js")), name="js")
app.mount("/images", StaticFiles(directory=str(STATIC_DIR / "images")), name="images")


@app.get("/manifest.json")
def serve_manifest():
    return FileResponse(STATIC_DIR / "manifest.json", media_type="application/manifest+json")


@app.get("/sw.js")
def serve_service_worker():
    return FileResponse(
        STATIC_DIR / "sw.js",
        media_type="application/javascript",
        headers={"Service-Worker-Allowed": "/"}
    )


@app.get("/")
def serve_index():
    return FileResponse(STATIC_DIR / "index.html")
