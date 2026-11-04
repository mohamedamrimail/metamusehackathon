import type { ServerEvent } from '@ipersons/shared';

type Listener = (event: ServerEvent) => void;

/** In-process pub/sub so REST confirmations and background jobs reach open voice sessions. */
export class EventBus {
  private listeners = new Map<string, Set<Listener>>();

  subscribe(ipersonId: string, fn: Listener): () => void {
    const set = this.listeners.get(ipersonId) ?? new Set();
    set.add(fn);
    this.listeners.set(ipersonId, set);
    return () => {
      set.delete(fn);
      if (!set.size) this.listeners.delete(ipersonId);
    };
  }

  publish(ipersonId: string, event: ServerEvent): void {
    for (const fn of this.listeners.get(ipersonId) ?? []) fn(event);
  }

  hasListeners(ipersonId: string): boolean {
    return (this.listeners.get(ipersonId)?.size ?? 0) > 0;
  }
}
