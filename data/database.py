import os
import time
from datetime import datetime
from typing import List, Optional
from pymongo import MongoClient, ReturnDocument
from data.models import Meeting


class MeetingDatabase:
    """MongoDB manager replacing SQLite MeetingDatabase matching MongoDB Compass."""

    def __init__(
        self,
        uri: Optional[str] = None,
        db_name: str = "notizen",
        collection_name: str = "notizen_shchedule"
    ):
        mongo_uri = uri or os.getenv("MONGO_URI", "mongodb://localhost:27017/")
        self.client = MongoClient(mongo_uri)
        self.db = self.client[db_name]
        self.collection = self.db[collection_name]
        self.counters = self.db["counters"]

        # Ensure performance indexes
        self.collection.create_index("id", unique=True)
        self.collection.create_index("dateTimeMillis")
        self.collection.create_index("isCompleted")

    def _get_next_id(self) -> int:
        """Atomic auto-incrementing integer ID generator."""
        doc = self.counters.find_one_and_update(
            {"_id": "meeting_id"},
            {"$inc": {"seq": 1}},
            upsert=True,
            return_document=ReturnDocument.AFTER
        )
        return doc["seq"]

    def _doc_to_meeting(self, doc: dict) -> Meeting:
        """Helper to convert MongoDB document to Meeting object."""
        return Meeting(
            id=doc.get("id"),
            title=doc.get("title", ""),
            personName=doc.get("personName", ""),
            dateTimeMillis=doc.get("dateTimeMillis", 0),
            reminderMinutesBefore=doc.get("reminderMinutesBefore", 30),
            notes=doc.get("notes", ""),
            category=doc.get("category", "General"),
            alarmAudio=doc.get("alarmAudio", "Default alarm sound"),
            isCompleted=bool(doc.get("isCompleted", False)),
            createdAt=doc.get("createdAt", 0)
        )

    def insert(self, meeting: Meeting) -> int:
        """Inserts a new meeting into MongoDB collection and returns its generated ID."""
        meeting_id = self._get_next_id()
        meeting.id = meeting_id
        if not meeting.createdAt:
            meeting.createdAt = int(time.time() * 1000)

        data = meeting.to_dict()
        data["id"] = meeting_id
        self.collection.insert_one(data)
        return meeting_id

    def update(self, meeting: Meeting) -> bool:
        """Updates an existing meeting in MongoDB."""
        if meeting.id is None:
            return False
        data = meeting.to_dict()
        data.pop("_id", None)
        res = self.collection.update_one(
            {"id": meeting.id},
            {"$set": data}
        )
        return res.modified_count > 0 or res.matched_count > 0

    def delete(self, meeting_id: int) -> bool:
        """Deletes a meeting by ID from MongoDB."""
        res = self.collection.delete_one({"id": meeting_id})
        return res.deleted_count > 0

    def mark_completed(self, meeting_id: int, is_completed: bool = True) -> bool:
        """Marks a meeting completed or uncompleted."""
        res = self.collection.update_one(
            {"id": meeting_id},
            {"$set": {"isCompleted": is_completed}}
        )
        return res.modified_count > 0 or res.matched_count > 0

    def get_by_id(self, meeting_id: int) -> Optional[Meeting]:
        """Gets a single meeting by its ID."""
        doc = self.collection.find_one({"id": meeting_id})
        return self._doc_to_meeting(doc) if doc else None

    def get_upcoming_meetings(self, lookback_millis: int = 3600000) -> List[Meeting]:
        """
        Returns active, uncompleted meetings from 1 hour ago into future,
        ordered by dateTimeMillis ASC.
        """
        cutoff = int(time.time() * 1000) - lookback_millis
        cursor = self.collection.find({
            "isCompleted": False,
            "dateTimeMillis": {"$gte": cutoff}
        }).sort("dateTimeMillis", 1)
        return [self._doc_to_meeting(doc) for doc in cursor]

    def get_today_meetings(self) -> List[Meeting]:
        """Returns meetings occurring today (local midnight to midnight)."""
        now = datetime.now()
        start_of_day = datetime(now.year, now.month, now.day, 0, 0, 0)
        end_of_day = datetime(now.year, now.month, now.day, 23, 59, 59, 999999)
        start_ms = int(start_of_day.timestamp() * 1000)
        end_ms = int(end_of_day.timestamp() * 1000)

        cursor = self.collection.find({
            "dateTimeMillis": {"$gte": start_ms, "$lte": end_ms}
        }).sort("dateTimeMillis", 1)
        return [self._doc_to_meeting(doc) for doc in cursor]

    def get_completed_meetings(self) -> List[Meeting]:
        """Returns meetings marked completed."""
        cursor = self.collection.find({"isCompleted": True}).sort("dateTimeMillis", -1)
        return [self._doc_to_meeting(doc) for doc in cursor]

    def get_past_meetings(self) -> List[Meeting]:
        """Returns past or completed meetings."""
        now_ms = int(time.time() * 1000)
        cursor = self.collection.find({
            "$or": [
                {"isCompleted": True},
                {"dateTimeMillis": {"$lt": now_ms}}
            ]
        }).sort("dateTimeMillis", -1)
        return [self._doc_to_meeting(doc) for doc in cursor]

    def get_all_meetings(self) -> List[Meeting]:
        """Returns all meetings sorted by date descending."""
        cursor = self.collection.find().sort("dateTimeMillis", -1)
        return [self._doc_to_meeting(doc) for doc in cursor]

    def search(self, query: str) -> List[Meeting]:
        """Searches meetings by title, personName, notes, or category."""
        term = query.strip()
        if not term:
            return self.get_all_meetings()

        regex = {"$regex": term, "$options": "i"}
        cursor = self.collection.find({
            "$or": [
                {"title": regex},
                {"personName": regex},
                {"notes": regex},
                {"category": regex}
            ]
        }).sort("dateTimeMillis", 1)
        return [self._doc_to_meeting(doc) for doc in cursor]
