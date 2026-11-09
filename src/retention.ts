import type { MessageNotice } from './types.js';
/** Application visibility deadline, independent of leases and authorization expiry. */
export const HISTORY_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
export function retentionDeadline(message: Pick<MessageNotice, 'timestamp'>): number {
  return Date.parse(message.timestamp) + HISTORY_RETENTION_MS;
}
export function messageExpired(message: Pick<MessageNotice, 'timestamp'>, now: number): boolean {
  const deadline = retentionDeadline(message);
  return !Number.isFinite(deadline) || deadline <= now;
}
export function retentionTTL(message: Pick<MessageNotice, 'timestamp'>): number {
  return Math.ceil(retentionDeadline(message) / 1000);
}
/** Legacy messages retain their original claim address. New incarnations never share it. */
export function claimSortKey(message: Pick<MessageNotice, 'id' | 'generation'>): string {
  return `claim#${message.id}${message.generation ? `#${message.generation}` : ''}`;
}
