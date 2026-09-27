-- Sweeps every stored `property.properties` row still using the pre-#393 single
-- `mortgage` shape into the current `mortgages` array, so `migrateLegacyMortgage`
-- can be deleted (#683): once this sweep has run, no row is left relying on it.
--
-- A property counts as legacy-shaped if it still has a `mortgage` key at all, null
-- or not — `json_type(..., '$.mortgage')` tells "the key is null" apart from "the
-- key was never there", the same distinction `migrateLegacyMortgage` itself checks
-- with `'mortgage' in property`.
UPDATE `settings`
SET `value_json` = json_set(
  `settings`.`value_json`,
  '$.properties',
  (
    SELECT json_group_array(
      CASE
        WHEN json_type(`property`.`value`, '$.mortgage') IS NULL THEN `property`.`value`
        WHEN json_type(`property`.`value`, '$.mortgage') = 'null'
          THEN json_set(json_remove(`property`.`value`, '$.mortgage'), '$.mortgages', json('[]'))
        ELSE json_set(
          json_remove(`property`.`value`, '$.mortgage'),
          '$.mortgages',
          json_array(json_extract(`property`.`value`, '$.mortgage'))
        )
      END
    )
    FROM json_each(`settings`.`value_json`, '$.properties') AS `property`
  )
)
WHERE `key` = 'property.properties'
  AND EXISTS (
    SELECT 1 FROM json_each(`settings`.`value_json`, '$.properties') AS `property`
    WHERE json_type(`property`.`value`, '$.mortgage') IS NOT NULL
  );
