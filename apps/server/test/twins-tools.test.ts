import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WaSender } from '../src/channels/whatsapp-client.ts';
import { actions, contacts, invites, twinConnections } from '../src/db/schema.ts';
import type { AppDeps } from '../src/http/deps.ts';
import { createDeps } from '../src/index.ts';
import { matchContacts } from '../src/twins/matching.ts';
import { call, FakeLlm, reset, say, testDb, testGeo } from './helpers.ts';
import { addContact, person } from './twins-helpers.ts';

const { db, pool } = testDb();
const wa = { sendText: vi.fn().mockResolvedValue(undefined), sendButtons: vi.fn().mockResolvedValue(undefined), sendTemplate: vi.fn(), sendImage: vi.fn(), downloadMedia: vi.fn() } satisfies WaSender;
let deps: AppDeps;
let llm: FakeLlm;

beforeEach(async () => {
  await reset(db);
  vi.clearAllMocks();
});
afterAll(() => pool.end());

function runtimeWith(steps: ReturnType<typeof say>[]) {
  llm = new FakeLlm(steps, say('[mood:happy] Done.'));
  deps = createDeps(db, { geo: testGeo, llm, stt: undefined, demoMode: true, wa });
  return deps.runtime;
}
async function turn(ipersonId: string, text: string) {
  const conversationId = await deps.runtime.conversationFor(ipersonId, 'web');
  return deps.runtime.handleUserMessage({ ipersonId, conversationId, text });
}
const toolResult = (i: number) => String(llm.calls[i]!.messages.findLast((m) => m.role === 'tool')?.content);

describe('§9 agent tools', () => {
  it('contacts_status: "who of my friends has an i-person?" (owner-only data, wrapped as outside content)', async () => {
    runtimeWith([call('contacts_status', { filter: 'on_iperson' }), say('[mood:happy] Sami has one.')]);
    const hana = await person(db, { name: 'Hana', phone: '+21655000001' });
    await person(db, { name: 'Sami', phone: '+21655000111' });
    await addContact(db, hana.user.id, { name: 'Sami A', phones: ['+21655000111'], relationship: 'friend' });
    await addContact(db, hana.user.id, { name: 'Lea', emails: ['lea@x.tn'], relationship: 'friend' });
    await matchContacts(db, hana.user.id);
    await turn(hana.iperson!.id, 'Who of my friends has an i-person?');
    const out = toolResult(1);
    expect(out).toMatch(/^<untrusted source="other i-persons"/);
    expect(out).toContain('"name":"Sami A"');
    expect(out).toContain('"twin":"i-Sami"');
    expect(out).not.toContain('Lea');
  });

  it('invite_contact: a proposal first; WhatsApp invites only send the user a wa.me link', async () => {
    runtimeWith([call('invite_contact', { contact: 'sister', channel: 'whatsapp' }), say('[mood:happy] Shall I?')]);
    const hana = await person(db, { name: 'Hana', phone: '+21655000001' });
    const sis = await addContact(db, hana.user.id, { name: 'Amel', phones: ['+21655000777'], relationship: 'family' });
    await db.update(contacts).set({ label: 'sister' }).where(eq(contacts.id, sis.id));
    const res = await turn(hana.iperson!.id, 'Invite my sister');
    expect(res.proposed[0]).toMatchObject({ tool: 'invite_contact', summary: 'Invite sister to i-persons via your WhatsApp', status: 'proposed' });
    expect(await db.select().from(invites)).toEqual([]);
    await deps.runtime.decide({ ipersonId: hana.iperson!.id, actionId: res.proposed[0]!.id, approve: true });
    expect(await db.select().from(invites)).toHaveLength(1);
    // Only the user's own number got a message: the link that opens THEIR WhatsApp with the invite.
    expect(wa.sendText).toHaveBeenCalledTimes(1);
    expect(wa.sendText.mock.calls[0]![0]).toBe('21655000001');
    expect(wa.sendText.mock.calls[0]![1]).toMatch(/https:\/\/wa\.me\/21655000777\?text=/);
    expect(wa.sendButtons).not.toHaveBeenCalled();
  });

  it('connect_twins: refused for someone not on i-persons; otherwise the other side gets a card after the yes', async () => {
    runtimeWith([call('connect_twins', { contact: 'Lea' }), say('[mood:sorry] Lea is not on i-persons.'), call('connect_twins', { contact: 'Sami' }), say('[mood:happy] Shall I?')]);
    const hana = await person(db, { name: 'Hana', phone: '+21655000001' });
    const sami = await person(db, { name: 'Sami', phone: '+21655000111' });
    await addContact(db, hana.user.id, { name: 'Sami A', phones: ['+21655000111'] });
    await addContact(db, hana.user.id, { name: 'Lea', emails: ['lea@x.tn'] });
    await matchContacts(db, hana.user.id);
    const first = await turn(hana.iperson!.id, 'Connect with Lea');
    expect(first.proposed).toEqual([]);
    expect(toolResult(1)).toContain("isn't on i-persons yet; you could invite them");
    const second = await turn(hana.iperson!.id, 'Connect with Sami');
    expect(await db.select().from(twinConnections)).toEqual([]);
    await deps.runtime.decide({ ipersonId: hana.iperson!.id, actionId: second.proposed[0]!.id, approve: true });
    expect(await db.select().from(twinConnections)).toEqual([expect.objectContaining({ status: 'pending', requesterId: hana.user.id })]);
    expect(await db.select().from(actions).where(and(eq(actions.ipersonId, sami.iperson!.id), eq(actions.status, 'proposed')))).toHaveLength(1);
    // The agent's own proposal doesn't count twice against the daily limit.
    const counted = await db.select().from(actions).where(and(eq(actions.ipersonId, hana.iperson!.id), eq(actions.tool, 'connect_twins')));
    expect(counted.filter((a) => 'connection_id' in (a.args as object))).toHaveLength(1);
  });

  it('find_places is read-only outside content; plan_with_contacts refuses unconnected people', async () => {
    runtimeWith([call('find_places', { type: 'coffee', area: 'Sfax' }), call('plan_with_contacts', { contacts: ['Sami'], type: 'coffee', date_from: '2027-03-01', date_to: '2027-03-03' }), say('[mood:sorry] Not connected yet.')]);
    const hana = await person(db, { name: 'Hana', phone: '+21655000001' });
    await person(db, { name: 'Sami', phone: '+21655000111' });
    await addContact(db, hana.user.id, { name: 'Sami A', phones: ['+21655000111'] });
    await matchContacts(db, hana.user.id);
    const res = await turn(hana.iperson!.id, 'Find a café and plan coffee with Sami');
    expect(toolResult(1)).toMatch(/^<untrusted source="web search"/);
    expect(res.proposed).toEqual([]);
    expect(toolResult(2)).toMatch(/cannot propose: Can't plan: your twins aren't connected with Sami A/);
  });
});
