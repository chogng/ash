ALTER TABLE document_collaboration_rooms ADD COLUMN epoch TEXT NOT NULL DEFAULT '';
ALTER TABLE document_collaboration_rooms ADD COLUMN checkpoint_version INTEGER NOT NULL DEFAULT 0;
UPDATE document_collaboration_rooms SET epoch=lower(hex(randomblob(16))), checkpoint_version=version;
CREATE TABLE collaboration_receipts (
    room_id TEXT NOT NULL REFERENCES document_collaboration_rooms(room_id) ON DELETE CASCADE,
    client_id TEXT NOT NULL, sequence INTEGER NOT NULL, version INTEGER NOT NULL, digest TEXT NOT NULL,
    PRIMARY KEY(room_id,client_id,sequence)
);
CREATE TABLE collaboration_clients (
    room_id TEXT NOT NULL REFERENCES document_collaboration_rooms(room_id) ON DELETE CASCADE,
    client_id TEXT NOT NULL, expires INTEGER NOT NULL, last_sequence INTEGER NOT NULL,
    PRIMARY KEY(room_id,client_id)
);

CREATE INDEX collaboration_clients_expiry ON collaboration_clients(room_id, expires);
