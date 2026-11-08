-- Older messages did not record who supplied references. Default to the narrower scope.
ALTER TABLE queued_messages ADD COLUMN profile_reference_reads INTEGER NOT NULL DEFAULT 0
    CHECK (profile_reference_reads IN (0, 1));
