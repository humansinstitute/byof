export type ActivityEvent = {
  type: 'commentary' | 'tools' | 'completed' | 'failed';
  turnId?: string;
  content?: string;
  timestamp?: string | null;
  receivedAt?: string | null;
};

export type CollapsedActivity = {
  type: ActivityEvent['type'];
  turnId: string;
  content?: string;
  instant: string | null;
};

export function newestInstant(...values: unknown[]): string | null;
export function activityInstant(event: ActivityEvent): string | null;
export function collapseActivity(events: ActivityEvent[] | null | undefined): CollapsedActivity[];
export function perthEventTime(value: unknown,label: string,reference?: Date | string): {
  datetime: string;
  text: string;
  ariaLabel: string;
} | null;
