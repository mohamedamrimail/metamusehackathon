-- Jury §5: social networks are never fetched any more; links of those kinds are removed
-- (facts already learned from them stay, editable on My twin).
DELETE FROM "profile_links" WHERE "kind" IN ('linkedin', 'facebook', 'instagram', 'x');
