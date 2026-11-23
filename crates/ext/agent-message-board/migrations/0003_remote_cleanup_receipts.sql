ALTER TABLE agent_board_remote_locations
ADD COLUMN cleaned INTEGER NOT NULL DEFAULT 0 CHECK (cleaned IN (0, 1));
