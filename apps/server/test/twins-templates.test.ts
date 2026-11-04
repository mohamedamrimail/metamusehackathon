import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WaSender } from '../src/channels/whatsapp-client.ts';
import { createDeps } from '../src/index.ts';
import { DemoLlm } from '../src/meta/demo-llm.ts';
import { reach, TWIN_TEMPLATES } from '../src/twins/notify.ts';
import { clearTwinSettingsCache, saveTwinSettings } from '../src/twins/settings.ts';
import { TWIN_WA_TEMPLATES, WA_TEMPLATE_LANGS } from '../src/twins/wa-templates.ts';
import { reset, testDb, testGeo } from './helpers.ts';
import { person } from './twins-helpers.ts';

const { db, pool } = testDb();
beforeEach(async () => { await reset(db); clearTwinSettingsCache(); });
afterAll(() => pool.end());

describe('§8 WhatsApp templates', () => {
  it('are defined in EN, FR, AR and DE, utility, with as many examples as placeholders', () => {
    expect(TWIN_WA_TEMPLATES.map((t) => t.name).sort()).toEqual(Object.values(TWIN_TEMPLATES).sort());
    for (const t of TWIN_WA_TEMPLATES) {
      expect(['UTILITY', 'MARKETING']).toContain(t.category);
      for (const l of WA_TEMPLATE_LANGS) expect(new Set(t.body[l].match(/\{\{\d\}\}/g)).size).toBe(t.example.length);
    }
  });

  it("follow Meta's rule: no body starts or ends with a variable", () => {
    for (const t of TWIN_WA_TEMPLATES) for (const l of WA_TEMPLATE_LANGS) {
      const body = t.body[l].trim();
      expect(body.startsWith('{{'), `${t.name} ${l}`).toBe(false);
      expect(body.endsWith('}}'), `${t.name} ${l}`).toBe(false);
    }
  });

  it('outside the 24 h window: template only once approved, else no WhatsApp (card + email fallback)', async () => {
    const outside = Object.assign(new Error('WhatsApp send failed: HTTP 400 {"error":{"code":131047}}'));
    const wa = { sendText: vi.fn().mockRejectedValue(outside), sendButtons: vi.fn().mockRejectedValue(outside), sendTemplate: vi.fn().mockResolvedValue(undefined), sendImage: vi.fn(), downloadMedia: vi.fn() } satisfies WaSender;
    const deps = createDeps(db, { geo: testGeo, llm: new DemoLlm(), stt: undefined, demoMode: true, wa });
    await saveTwinSettings(db, { waTemplatesApproved: false }, 'test'); // settings aren't reset between runs
    const { user } = await person(db, { name: 'Sami', phone: '+21655000111' });
    const msg = { text: 'Hana wants to connect', buttons: [{ id: 'ok:x', title: 'Accept' }], template: { name: TWIN_TEMPLATES.connect, params: ['Hana'] }, subject: 's' };
    expect(await reach(deps, user.id, msg)).toBe('card'); // no SMTP in tests
    expect(wa.sendTemplate).not.toHaveBeenCalled();
    await saveTwinSettings(db, { waTemplatesApproved: true }, 'test');
    expect(await reach(deps, user.id, msg)).toBe('template');
    expect(wa.sendTemplate).toHaveBeenCalledWith('21655000111', 'twin_connect_request', 'en', ['Hana']);
  });
});
