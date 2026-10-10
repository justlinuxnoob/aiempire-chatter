-- Photos taken for one fan were picked up by the vault sync and resold. They're excluded
-- now (see syncVault); remove the ones already in the catalog.
DELETE FROM catalog WHERE media_uuid IN (SELECT media_uuid FROM generations WHERE media_uuid IS NOT NULL);
