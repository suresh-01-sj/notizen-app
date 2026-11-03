from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from typing import Optional, Dict, Any


@dataclass
class Meeting:
    """Represents a scheduled meeting in Notizen."""
    id: Optional[int] = None
    title: str = ""
    personName: str = ""
    dateTimeMillis: int = 0
    reminderMinutesBefore: int = 30
    notes: str = ""
    category: str = "General"
    alarmAudio: str = "Default alarm sound"
    isCompleted: bool = False
    createdAt: int = 0

    @property
    def dt(self) -> datetime:
        """Returns localized or local datetime object from dateTimeMillis."""
        return datetime.fromtimestamp(self.dateTimeMillis / 1000.0)

    @property
    def trigger_time_millis(self) -> int:
        """Calculates exact timestamp when the reminder alarm should fire."""
        return self.dateTimeMillis - (self.reminderMinutesBefore * 60 * 1000)

    def to_dict(self) -> Dict[str, Any]:
        """Converts meeting to dictionary for JSON serialization."""
        d = asdict(self)
        d["dateTimeIso"] = self.dt.isoformat()
        d["triggerTimeMillis"] = self.trigger_time_millis
        return d

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Meeting":
        """Instantiates a Meeting from dictionary."""
        return cls(
            id=data.get("id"),
            title=data.get("title", ""),
            personName=data.get("personName", "") or data.get("person_name", ""),
            dateTimeMillis=int(data.get("dateTimeMillis", 0)),
            reminderMinutesBefore=int(data.get("reminderMinutesBefore", 30)),
            notes=data.get("notes", ""),
            category=data.get("category", "General"),
            alarmAudio=data.get("alarmAudio") or data.get("alarm_audio") or "Default alarm sound",
            isCompleted=bool(data.get("isCompleted", False)),
            createdAt=int(data.get("createdAt", 0)),
        )
