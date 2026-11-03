import logging
import threading
import time
from typing import Callable, Dict, List, Optional
from data.models import Meeting
from data.database import MeetingDatabase
from sound.alarm_sound import AlarmSoundManager

logger = logging.getLogger("NotizenAlarm")


class AlarmScheduler:
    """
    Exact alarm scheduler matching NotificationHelper and AlarmReceiver.
    Manages timers per meeting ID, handles 5-second fallback for past trigger times,
    and invokes registered callbacks when an alarm fires.
    """

    def __init__(self, db: MeetingDatabase, sound_manager: Optional[AlarmSoundManager] = None):
        self.db = db
        self.sound_manager = sound_manager or AlarmSoundManager.get_instance()
        self._timers: Dict[int, threading.Timer] = {}
        self._lock = threading.Lock()
        self._callbacks: List[Callable[[Meeting], None]] = []

    def register_trigger_callback(self, callback: Callable[[Meeting], None]):
        """Register a callback function to be called when an alarm fires."""
        with self._lock:
            if callback not in self._callbacks:
                self._callbacks.append(callback)

    def unregister_trigger_callback(self, callback: Callable[[Meeting], None]):
        with self._lock:
            if callback in self._callbacks:
                self._callbacks.remove(callback)

    def schedule_reminder(self, meeting: Meeting):
        """
        Schedules an exact reminder for the given meeting according to Section 7.3:
        - If meeting is in past, skip.
        - If trigger time is in past, fire in 5 seconds.
        - Otherwise fire at exact trigger time.
        """
        if meeting.id is None or meeting.isCompleted:
            return

        now_ms = int(time.time() * 1000)

        # Skip meetings that are already completely in the past
        if meeting.dateTimeMillis < now_ms:
            logger.info(f"Skipping past meeting id={meeting.id} '{meeting.title}'")
            return

        # Cancel any existing alarm for this meeting id
        self.cancel_reminder(meeting.id)

        trigger_time_ms = meeting.trigger_time_millis
        if trigger_time_ms <= now_ms:
            # Trigger time has already passed -> fire 5 seconds from now
            delay_seconds = 5.0
            logger.info(f"Trigger time passed for meeting id={meeting.id}; firing in 5s")
        else:
            delay_seconds = min(max(0.1, (trigger_time_ms - now_ms) / 1000.0), 2592000.0)
            logger.info(f"Scheduled reminder for meeting id={meeting.id} in {delay_seconds:.1f}s")

        timer = threading.Timer(delay_seconds, self._on_alarm_fired, args=(meeting.id,))
        timer.daemon = True

        with self._lock:
            self._timers[meeting.id] = timer
            timer.start()

    def cancel_reminder(self, meeting_id: int):
        """Cancels any pending reminder for meeting ID (Section 7.3)."""
        with self._lock:
            if meeting_id in self._timers:
                timer = self._timers.pop(meeting_id)
                timer.cancel()
                logger.info(f"Cancelled reminder for meeting id={meeting_id}")

    def reschedule_all(self):
        """
        Re-schedules alarms for all upcoming uncompleted meetings (Section 7.6 BootReceiver).
        """
        upcoming = self.db.get_upcoming_meetings()
        logger.info(f"Rescheduling {len(upcoming)} upcoming meetings...")
        for meeting in upcoming:
            self.schedule_reminder(meeting)

    def dismiss_alarm(self, meeting_id: Optional[int] = None):
        """
        Dismisses the active alarm, stopping sound (Section 7.4 DismissReceiver).
        """
        self.sound_manager.stop()
        logger.info(f"Dismissed alarm for meeting id={meeting_id}")

    def snooze_alarm(self, meeting_id: int, snooze_minutes: int = 5):
        """
        Snoozes an alarm by scheduling it to fire in snooze_minutes.
        """
        self.dismiss_alarm(meeting_id)
        meeting = self.db.get_by_id(meeting_id)
        if not meeting:
            return

        delay_seconds = snooze_minutes * 60
        timer = threading.Timer(delay_seconds, self._on_alarm_fired, args=(meeting.id,))
        timer.daemon = True

        with self._lock:
            self._timers[meeting.id] = timer
            timer.start()
        logger.info(f"Snoozed alarm for meeting id={meeting.id} for {snooze_minutes} minutes")

    def trigger_now(self, meeting_id: int):
        """Forces an alarm to fire immediately (useful for testing)."""
        self._on_alarm_fired(meeting_id)

    def _on_alarm_fired(self, meeting_id: int):
        """Called when an alarm timer expires (Section 7.4 AlarmReceiver)."""
        with self._lock:
            self._timers.pop(meeting_id, None)

        meeting = self.db.get_by_id(meeting_id)
        if not meeting or meeting.isCompleted:
            return

        logger.info(f"ALARM FIRED! Meeting id={meeting.id} '{meeting.title}' with {meeting.personName}")

        # Start looping alarm sound (max 60 seconds)
        self.sound_manager.play(meeting.id, duration_seconds=60, tone=meeting.alarmAudio)

        # Notify callbacks
        with self._lock:
            callbacks = list(self._callbacks)

        for cb in callbacks:
            try:
                cb(meeting)
            except Exception as e:
                logger.error(f"Error in alarm callback: {e}")
