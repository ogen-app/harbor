-- Harbor baseline schema. Intentionally minimal: domain entities are added via
-- the ../ogen add-entity conventions (migration + model + repository + handler
-- + server wiring + tests). This table exercises the migration pipeline
-- end-to-end and gives the health check a concrete object to read.
CREATE TABLE IF NOT EXISTS app_meta
(
    key        TEXT        PRIMARY KEY,
    value      TEXT        NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO app_meta (key, value)
VALUES ('schema_version', '1')
ON CONFLICT (key) DO NOTHING;
