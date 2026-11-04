// Contacts, invites and twin-to-twin planning: shared vocabulary for server and web (docs/twin-to-twin.md).

export const DISCOVERABILITY = ['contacts', 'nobody'] as const;
export type Discoverability = (typeof DISCOVERABILITY)[number];
/** One sentence, shown in setup's consent step and on My twin → Privacy. Not part of the versioned consent text. */
export const DISCOVERABILITY_TEXT =
  'People who already have your verified email or WhatsApp number in their contacts can see that you have an i-person (only your twin’s name and picture); you can switch this off any time.';

/** Scopes each side grants for its own data. `plan` is on by default; the rest start off. */
export const TWIN_SCOPES = ['plan', 'availability', 'preferences', 'suggest'] as const;
export type TwinScope = (typeof TWIN_SCOPES)[number];
export const TWIN_SCOPE_LABELS: Record<TwinScope, { title: string; detail: string }> = {
  plan: { title: 'Planning requests', detail: 'Their twin may send my twin requests to plan something.' },
  availability: { title: 'Free/busy', detail: 'My twin may share free/busy slots. Never titles, places or who I meet.' },
  preferences: { title: 'Preferences', detail: 'My twin may share the preferences I tick below, nothing else.' },
  suggest: { title: 'Suggestions', detail: 'My twin may suggest plans with this person now and then.' },
};

export type ContactStatus = 'not_yet' | 'invited' | 'on_iperson' | 'requested' | 'incoming' | 'connected' | 'blocked';

export const RELATIONSHIP_GROUPS = [
  { id: 'family', label: 'Family' },
  { id: 'friend', label: 'Friends' },
  { id: 'colleague', label: 'Colleagues' },
  { id: 'client', label: 'Clients' },
  { id: 'other', label: 'Other' },
] as const;

export const PLAN_TYPES = ['meeting', 'coffee', 'dinner', 'lunch', 'sport', 'walk', 'custom'] as const;
export type PlanType = (typeof PLAN_TYPES)[number];
export const PLAN_TYPE_LABELS: Record<PlanType, string> = {
  meeting: 'Meeting', coffee: 'Coffee', dinner: 'Dinner', lunch: 'Lunch', sport: 'Sport', walk: 'Walk', custom: 'Custom',
};
/** Types that need a place found for them. */
export const PLACE_TYPES: readonly PlanType[] = ['coffee', 'dinner', 'lunch', 'sport', 'walk'];
export const TIMES_OF_DAY = ['any', 'morning', 'afternoon', 'evening'] as const;
export type TimeOfDay = (typeof TIMES_OF_DAY)[number];

export type PlanStatus = 'draft' | 'sent' | 'negotiating' | 'awaiting_confirmation' | 'booked' | 'declined' | 'expired' | 'cancelled';

export interface ContactView {
  id: string;
  name: string;
  initials: string;
  relationship: string | null;
  label: string | null;
  notes: string | null;
  status: ContactStatus;
  /** Only for contacts on i-persons: the other twin's name and a thumbnail served through the contact. */
  twin?: { name: string; avatar: string | null };
  connection_id?: string;
  invited?: { channel: 'email' | 'whatsapp'; at: string; can_remind: boolean };
  channels: { email: boolean; whatsapp: boolean };
}
