export const DEFAULT_NOTIFICATION_TEMPLATE = '{{type}}: {{title}} — {{company}}';

const ALLOWED_FIELDS = new Set([
  'type', 'title', 'company', 'location', 'source', 'searchName', 'url',
]);

export type NotificationTemplateValues = Record<string, string>;

export function validateNotificationTemplate(value: string | undefined): string {
  const template = (value ?? DEFAULT_NOTIFICATION_TEMPLATE).trim();
  if (!template || template.length > 300) {
    throw new Error('Notification template must contain 1 to 300 characters.');
  }
  const placeholders = [...template.matchAll(/\{\{([^{}]+)\}\}/gu)];
  for (const match of placeholders) {
    if (!ALLOWED_FIELDS.has(match[1]!.trim())) {
      throw new Error(`Unknown notification template field: ${match[1]}`);
    }
  }
  const remainingTemplate = template.replace(/\{\{[^{}]+\}\}/gu, '');
  if (remainingTemplate.includes('{{') || remainingTemplate.includes('}}')) {
    throw new Error('Notification template contains a malformed placeholder.');
  }
  return template;
}

export function renderNotificationTemplate(
  template: string,
  values: NotificationTemplateValues,
): string {
  return template.replace(/\{\{([^{}]+)\}\}/gu, (_match, rawField: string) =>
    values[rawField.trim()] ?? '',
  ).replace(/\s{2,}/gu, ' ').trim();
}
