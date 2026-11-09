-- 0008_answer_bank_versions.sql
-- Human-readable question text and optimistic version for the answer bank.

ALTER TABLE answer_bank
  ADD COLUMN question_text text NOT NULL DEFAULT '',
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);

UPDATE answer_bank
   SET question_text = question_key
 WHERE question_text = '';
