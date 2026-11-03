import asyncio
from typing import Optional, Set
from fastapi import WebSocket
from pydantic import BaseModel


# =============================================================================
# WebSocket Connection Manager Class
# =============================================================================
class ConnectionManager:
    """Manages active WebSocket client connections and thread-safe broadcasts."""

    def __init__(self):
        self.active_connections: Set[WebSocket] = set()
        self.loop: Optional[asyncio.AbstractEventLoop] = None

    def set_loop(self, loop: asyncio.AbstractEventLoop):
        self.loop = loop

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.add(websocket)

    def disconnect(self, websocket: WebSocket):
        self.active_connections.discard(websocket)

    async def broadcast(self, message: dict):
        disconnected = []
        for connection in list(self.active_connections):
            try:
                await connection.send_json(message)
            except Exception:
                disconnected.append(connection)
        for dead in disconnected:
            self.active_connections.discard(dead)

    def broadcast_from_thread(self, message: dict):
        if self.loop and self.loop.is_running():
            asyncio.run_coroutine_threadsafe(self.broadcast(message), self.loop)


# =============================================================================
# Pydantic Request & Response Data Classes
# =============================================================================
class ParseRequest(BaseModel):
    text: str


class MeetingCreateRequest(BaseModel):
    title: str
    personName: Optional[str] = ""
    dateTimeMillis: int
    reminderMinutesBefore: int = 30
    notes: Optional[str] = ""
    category: Optional[str] = "General"
    alarmAudio: Optional[str] = "Default alarm sound"


class MeetingUpdateRequest(BaseModel):
    title: str
    personName: Optional[str] = ""
    dateTimeMillis: int
    reminderMinutesBefore: int = 30
    notes: Optional[str] = ""
    category: Optional[str] = "General"
    alarmAudio: Optional[str] = "Default alarm sound"
    isCompleted: Optional[bool] = False


class SnoozeRequest(BaseModel):
    snoozeMinutes: int = 5

