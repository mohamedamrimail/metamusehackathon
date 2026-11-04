import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ipersons, users } from '../src/db/schema.ts';
import { twinPageHtml } from '../src/http/seo.ts';
import { makeIperson, reset, testDb } from './helpers.ts';

// Link previews: a public twin's page shows that twin; anything else keeps the site's default card.

const { db, pool } = testDb();
let dist: string;
beforeEach(async () => {
  await reset(db);
  dist = await mkdtemp(join(tmpdir(), 'web-'));
  await writeFile(join(dist, 'index.html'), '<head><!--seo--><title>i-persons</title><meta property="og:title" content="default" /><!--/seo--></head>');
});
afterAll(() => pool.end());

describe('twin link previews', () => {
  it('a public twin gets its own title, description, image and url; a private one keeps the default', async () => {
    const { user, iperson } = await makeIperson(db);
    await db.update(users).set({ phoneE164: '+21655000111', name: 'Merry Smith' }).where(eq(users.id, user.id));
    await db.update(ipersons).set({ handle: 'merry', publicBio: 'Designer in Tunis & coffee lover', avatarUrl: `/api/media/${iperson.id}-avatar-x.jpg` }).where(eq(ipersons.id, iperson.id));
    expect(await twinPageHtml({ db }, dist, '/@merry')).toBeUndefined(); // not public yet
    await db.update(ipersons).set({ publicEnabled: true }).where(eq(ipersons.id, iperson.id));
    const html = (await twinPageHtml({ db }, dist, '/@merry?x=1'))!;
    expect(html).toContain('<title>Mimi, Merry&#39;s i-person · i-persons</title>');
    expect(html).toContain('content="Designer in Tunis &#38; coffee lover"');
    expect(html).toContain(`/api/public/merry/media/${iperson.id}-avatar-x.jpg`);
    expect(html).toMatch(/og:url" content="https?:\/\/[^"]+\/@merry"/);
    expect(html).not.toContain('content="default"');
    expect(await twinPageHtml({ db }, dist, '/talk')).toBeUndefined();
    expect(await twinPageHtml({ db }, dist, '/@nobody')).toBeUndefined();
  });
});
