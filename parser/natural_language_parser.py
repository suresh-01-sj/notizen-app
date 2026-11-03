import re
import calendar
from dataclasses import dataclass
from datetime import datetime, date, time as dtime, timedelta
from typing import Optional, Tuple


@dataclass
class ParsedMeeting:
    title: str
    personName: str
    target_date: date
    target_time: dtime
    dateTimeMillis: int
    reminderMinutesBefore: int = 30
    raw_text: str = ""


class NaturalLanguageParser:
    """
    Parses natural language meeting phrases into structured meeting fields.
    Implements all rules from Developer Guide Section 8:
    - Person extraction ("with <name>", ignoring stop-words like 'me', 'the', weekdays)
    - Time extraction ("at 8", "at 6:15", "as 6:15", "8pm", "3:30 am", hours 1-7 default to PM)
    - Date extraction ("today", "tomorrow", "day after tomorrow", weekdays, "on 15th")
    - Leftover words -> title (fallback to 'Meeting with <Person>' if < 3 chars)
    """

    WEEKDAYS = {
        "monday": 0, "mon": 0,
        "tuesday": 1, "tue": 1, "tues": 1,
        "wednesday": 2, "wed": 2,
        "thursday": 3, "thu": 3, "thur": 3, "thurs": 3,
        "friday": 4, "fri": 4,
        "saturday": 5, "sat": 5,
        "sunday": 6, "sun": 6
    }

    STOP_WORDS = {"me", "the", "a", "an", "us", "them", "him", "her", "someone", "everyone", "team", "all"}

    @classmethod
    def parse(cls, text: str, reference_dt: Optional[datetime] = None) -> ParsedMeeting:
        if reference_dt is None:
            reference_dt = datetime.now()

        raw_input = text.strip()
        working_text = raw_input

        # 1. Extract Person (and strip 'with <person/stopword>')
        person, person_span = cls._extract_person(working_text)
        if person_span:
            working_text = cls._remove_span(working_text, person_span)

        # 2. Extract Time first (to avoid numbers like '3:30' being matched by date)
        extracted_time, time_span = cls._extract_time(working_text)
        if time_span:
            working_text = cls._remove_span(working_text, time_span)

        # 3. Extract Date
        extracted_date, date_span = cls._extract_date(working_text, reference_dt)
        if date_span:
            working_text = cls._remove_span(working_text, date_span)

        # 4. Handle default / fallback date & time
        final_time = extracted_time if extracted_time is not None else dtime(10, 0)

        if extracted_date is not None:
            final_date = extracted_date
        else:
            # Rule: time only, no date -> today, or tomorrow if that time has already passed today
            now_time = reference_dt.time()
            if extracted_time is not None and extracted_time <= now_time:
                final_date = reference_dt.date() + timedelta(days=1)
            else:
                final_date = reference_dt.date()

        # Combine into datetime & epoch millis
        target_datetime = datetime.combine(final_date, final_time)
        epoch_millis = int(target_datetime.timestamp() * 1000)

        # 5. Extract Title from leftover words
        title = cls._clean_leftover_title(working_text, person)

        return ParsedMeeting(
            title=title,
            personName=person,
            target_date=final_date,
            target_time=final_time,
            dateTimeMillis=epoch_millis,
            reminderMinutesBefore=30,
            raw_text=raw_input
        )

    @classmethod
    def _extract_person(cls, text: str) -> Tuple[str, Optional[Tuple[int, int]]]:
        """
        Extracts person after 'with', e.g. 'with rahul', 'with rahul sharma'.
        Ignores stop words such as 'me', 'the', and weekdays.
        Always removes the 'with <word>' span if matched.
        """
        match = re.search(r'\bwith\s+([A-Za-z]+(?:\s+[A-Za-z]+)*)', text, re.IGNORECASE)
        if not match:
            return "", None

        full_start = match.start()
        candidate = match.group(1).strip()
        words = candidate.split()
        valid_words = []
        consumed_words = []

        for word in words:
            w_lower = word.lower()
            if w_lower in {"at", "on", "as", "for", "in", "tomorrow", "today", "tonight"} or w_lower in cls.WEEKDAYS:
                break
            consumed_words.append(word)
            if w_lower not in cls.STOP_WORDS:
                valid_words.append(word)

        if not consumed_words:
            return "", None

        # Calculate exact span of 'with <consumed_words>'
        matched_str = "with " + " ".join(consumed_words)
        end_idx = full_start + len(matched_str)

        person_name = " ".join(valid_words).title() if valid_words else ""
        return person_name, (full_start, end_idx)

    @classmethod
    def _extract_time(cls, text: str) -> Tuple[Optional[dtime], Optional[Tuple[int, int]]]:
        """
        Extracts time according to Section 8 rules:
        - 'at 8', 'at 6:15', 'as 6:15'
        - '8pm', '3:30 am', '11:45 pm'
        - No am/pm with hour 1-7 -> PM (e.g. 'at 5' -> 17:00, 'at 1' -> 13:00)
        - No am/pm with hour 8-11 -> AM (e.g. 'at 8' -> 08:00)
        - No am/pm with hour 12 -> 12:00 PM
        """
        # Pattern 1: explicit am/pm (e.g. "at 3:30 pm", "8pm", "3:30am", "11:45 pm", "at 9 am")
        match = re.search(r'\b(?:(?:at|as)\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b', text, re.IGNORECASE)
        if match:
            hour = int(match.group(1))
            minute = int(match.group(2)) if match.group(2) else 0
            meridiem = match.group(3).lower()

            if meridiem == "pm" and hour != 12:
                hour += 12
            elif meridiem == "am" and hour == 12:
                hour = 0

            if 0 <= hour <= 23 and 0 <= minute <= 59:
                return dtime(hour, minute), match.span()

        # Pattern 2: "at <hour>:<minute>" or "as <hour>:<minute>" without am/pm
        match = re.search(r'\b(?:at|as)\s+(\d{1,2}):(\d{2})\b', text, re.IGNORECASE)
        if match:
            hour = int(match.group(1))
            minute = int(match.group(2))
            if 1 <= hour <= 7:
                hour += 12  # Rule: No am/pm with hour 1-7 -> PM
            if 0 <= hour <= 23 and 0 <= minute <= 59:
                return dtime(hour, minute), match.span()

        # Pattern 3: "at <hour>" or "as <hour>" without am/pm
        match = re.search(r'\b(?:at|as)\s+(\d{1,2})\b', text, re.IGNORECASE)
        if match:
            hour = int(match.group(1))
            minute = 0
            if 1 <= hour <= 7:
                hour += 12  # Rule: No am/pm with hour 1-7 -> PM
            if 0 <= hour <= 23:
                return dtime(hour, minute), match.span()

        return None, None

    @classmethod
    def _extract_date(cls, text: str, reference_dt: datetime) -> Tuple[Optional[date], Optional[Tuple[int, int]]]:
        """
        Extracts date: 'day after tomorrow', 'tomorrow', 'today', weekdays ('mon'..'sun'), 'on 15th'
        Fixes known quirk: checks 'day after tomorrow' before 'tomorrow'.
        """
        ref_date = reference_dt.date()

        # 1. Day after tomorrow
        match = re.search(r'\b(?:the\s+)?day\s+after\s+tomorrow\b', text, re.IGNORECASE)
        if match:
            return ref_date + timedelta(days=2), match.span()

        # 2. Tomorrow
        match = re.search(r'\btomorrow\b', text, re.IGNORECASE)
        if match:
            return ref_date + timedelta(days=1), match.span()

        # 3. Today / Tonight
        match = re.search(r'\b(today|tonight)\b', text, re.IGNORECASE)
        if match:
            return ref_date, match.span()

        # 4. Weekdays (e.g. 'on monday', 'friday', 'this wednesday', 'next tuesday')
        weekday_pattern = r'\b(?:(?:on|this|next)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues|tue|wed|thurs|thur|thu|fri|sat|sun)\b'
        match = re.search(weekday_pattern, text, re.IGNORECASE)
        if match:
            day_name = match.group(1).lower()
            target_weekday = cls.WEEKDAYS[day_name]
            current_weekday = ref_date.weekday()

            days_ahead = (target_weekday - current_weekday) % 7
            if days_ahead == 0:
                if "next" in match.group(0).lower():
                    days_ahead = 7
            return ref_date + timedelta(days=days_ahead), match.span()

        # 5. 'on 15', 'on 15th', or explicit '15th', '2nd', '3rd', '1st'
        date_num_match = re.search(r'\b(?:on\s+(\d{1,2})(?:st|nd|rd|th)?|(\d{1,2})(?:st|nd|rd|th))\b', text, re.IGNORECASE)
        if date_num_match:
            day_str = date_num_match.group(1) or date_num_match.group(2)
            day_num = int(day_str)
            if 1 <= day_num <= 31:
                year = ref_date.year
                month = ref_date.month
                max_days_this_month = calendar.monthrange(year, month)[1]

                if day_num <= max_days_this_month:
                    candidate = date(year, month, day_num)
                    if candidate < ref_date:
                        # Passed this month -> next month
                        if month == 12:
                            next_month = 1
                            next_year = year + 1
                        else:
                            next_month = month + 1
                            next_year = year
                        max_next = calendar.monthrange(next_year, next_month)[1]
                        candidate = date(next_year, next_month, min(day_num, max_next))
                    return candidate, date_num_match.span()

        return None, None

    @classmethod
    def _clean_leftover_title(cls, text: str, person: str) -> str:
        """
        Cleans remaining text to form the title.
        If fewer than 3 chars are left, title becomes 'Meeting with <Person>' or 'Meeting'.
        """
        cleaned = re.sub(r'\b(at|on|as|for|in|with)\b', ' ', text, flags=re.IGNORECASE)
        cleaned = re.sub(r'[,;.!?\-_/]', ' ', cleaned)
        cleaned = re.sub(r'\s+', ' ', cleaned).strip()

        if len(cleaned) < 3:
            if person:
                return f"Meeting with {person}"
            return "Meeting"

        return cleaned.strip().capitalize()

    @staticmethod
    def _remove_span(text: str, span: Tuple[int, int]) -> str:
        start, end = span
        return (text[:start] + " " + text[end:]).strip()
