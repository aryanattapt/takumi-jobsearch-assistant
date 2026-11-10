ALTER TABLE saved_searches
  ADD COLUMN name text;

UPDATE saved_searches
   SET name = 'Pencarian ' || left(id::text, 8)
 WHERE name IS NULL;

ALTER TABLE saved_searches
  ALTER COLUMN name SET DEFAULT 'Pencarian tersimpan',
  ALTER COLUMN name SET NOT NULL,
  ADD CONSTRAINT saved_searches_name_length_check
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 100);

CREATE INDEX saved_searches_owner_updated_idx
  ON saved_searches (owner_id, updated_at DESC);
