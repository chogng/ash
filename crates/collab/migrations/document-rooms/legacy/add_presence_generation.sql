ALTER TABLE document_collaboration_rooms
ADD COLUMN presence_generation INTEGER NOT NULL DEFAULT 0 CHECK(presence_generation >= 0);
