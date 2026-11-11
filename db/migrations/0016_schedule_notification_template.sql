ALTER TABLE schedules
  ADD COLUMN notification_template text NOT NULL
    DEFAULT '{{type}}: {{title}} — {{company}}',
  ADD CONSTRAINT schedules_notification_template_length_ck
    CHECK (char_length(notification_template) BETWEEN 1 AND 300);
