import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { avatarAssets, ipersons } from '../db/schema.ts';

export interface RigVariant { url: string; cutout_url?: string; masks: Record<string, unknown> }

/** The living avatar's pose set for the current look (base + poses, with SAM cut-outs), as the renderers use it. */
export async function avatarRig(db: Db, ip: typeof ipersons.$inferSelect) {
  const variants: Record<string, RigVariant> = {};
  if (ip.avatarAssetId) {
    const rows = await db.select().from(avatarAssets).where(eq(avatarAssets.lookId, ip.avatarAssetId));
    if (rows.find((r) => r.variant === 'base')?.imageUrl === ip.avatarUrl) {
      for (const r of rows) {
        const { cutout_url, ...masks } = (r.masks ?? {}) as Record<string, unknown> & { cutout_url?: string };
        variants[r.variant] = { url: r.imageUrl, cutout_url, masks };
      }
    }
  }
  if (!variants.base && ip.avatarUrl) variants.base = { url: ip.avatarUrl, masks: { mouth: (ip.avatarMeta as { mouth?: unknown } | null)?.mouth } };
  return { variants, alive: Object.keys(variants).length > 1 || Boolean(variants.base?.cutout_url) };
}
