import sys
import threading
import time
from typing import Optional

try:
    import winsound
except ImportError:
    winsound = None


class AlarmSoundManager:
    """
    Manages looping alarm sounds for meeting reminders.
    Automatically stops after 60 seconds (as per Developer Guide Section 7.4),
    or immediately when dismissed.
    """

    _instance: Optional["AlarmSoundManager"] = None
    _lock = threading.Lock()

    def __init__(self):
        self._is_playing = False
        self._current_meeting_id: Optional[int] = None
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None

    @classmethod
    def get_instance(cls) -> "AlarmSoundManager":
        with cls._lock:
            if cls._instance is None:
                cls._instance = cls()
            return cls._instance

    def play(self, meeting_id: int, duration_seconds: int = 60, tone: Optional[str] = "Default alarm sound"):
        """Starts looping alarm sound in background thread."""
        self.stop()  # Stop any active alarm first

        self._is_playing = True
        self._current_meeting_id = meeting_id
        self._active_tone = tone or "Default alarm sound"
        self._stop_event.clear()

        self._thread = threading.Thread(
            target=self._loop_sound,
            args=(duration_seconds, self._active_tone),
            daemon=True,
            name=f"AlarmSoundThread-{meeting_id}"
        )
        self._thread.start()

    def stop(self):
        """Stops the alarm sound immediately."""
        self._is_playing = False
        self._current_meeting_id = None
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=0.5)
        self._thread = None

    def is_playing(self) -> bool:
        return self._is_playing

    @property
    def active_meeting_id(self) -> Optional[int]:
        return self._current_meeting_id

    def _loop_sound(self, duration_seconds: int, tone: str = "Default alarm sound"):
        start_time = time.time()
        while not self._stop_event.is_set():
            if time.time() - start_time >= duration_seconds:
                break

            if winsound is not None and sys.platform.startswith("win"):
                try:
                    # Select frequency based on tone family
                    freq1, freq2, interval = 880, 1200, 0.3
                    if tone in ("Bell", "Ding", "Warm Night"):
                        freq1, freq2, interval = 523, 1046, 0.6
                    elif tone in ("Guitar", "Rainy Day", "Dreamer's Alarm"):
                        freq1, freq2, interval = 440, 659, 0.5
                    elif tone in ("Busy Marimba", "Kalimbells", "Sunrise"):
                        freq1, freq2, interval = 659, 987, 0.25
                    elif tone in ("Alarm", "Pulse Signal", "Beep"):
                        freq1, freq2, interval = 950, 1400, 0.15

                    winsound.Beep(freq1, 150)
                    if self._stop_event.is_set():
                        break
                    time.sleep(0.05)
                    winsound.Beep(freq2, 150)
                    if self._stop_event.is_set():
                        break
                    time.sleep(interval)
                except Exception:
                    # Fallback to system asterisk
                    try:
                        winsound.MessageBeep(winsound.MB_ICONEXCLAMATION)
                    except Exception:
                        pass
                    time.sleep(1.0)
            else:
                # Non-windows fallback beep
                sys.stdout.write('\a')
                sys.stdout.flush()
                time.sleep(1.0)

        self._is_playing = False
        self._current_meeting_id = None
