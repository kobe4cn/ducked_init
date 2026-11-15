#!/usr/bin/env bash
# Create a throwaway read-only PostgreSQL database for the data-source scroll check.
# The login can SELECT the 25 tables in schema scroll and cannot INSERT.
# Usage: seed-readonly-postgres.sh <db-name>
# <db-name> matches ^crm_src_[a-z0-9]{1,24}$. Refuses crm_platform and any verify database.
set -euo pipefail

DB_NAME=${1:-}
PG_ADMIN_URL=${VERIFY_PG_ADMIN_URL:-postgres://crm:crm@127.0.0.1:5432/postgres}

if [[ ! $DB_NAME =~ ^crm_src_[a-z0-9]{1,24}$ ]]; then
  echo "usage: seed-readonly-postgres.sh crm_src_<token>" >&2
  echo "<token> is [a-z0-9]{1,24}" >&2
  exit 2
fi

command -v psql >/dev/null || { echo "psql is not on PATH" >&2; exit 1; }

ROLE=ro_${DB_NAME#crm_src_}
PASS=verify-reader-secret

psql "$PG_ADMIN_URL" -v ON_ERROR_STOP=1 -tA -c "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'" | grep -q 1 && {
  echo "database $DB_NAME already exists" >&2
  exit 1
}

psql "$PG_ADMIN_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$DB_NAME\" OWNER crm"
psql "$PG_ADMIN_URL" -v ON_ERROR_STOP=1 -c "CREATE ROLE \"$ROLE\" LOGIN PASSWORD '$PASS'"

# A connection URI plus -d makes this psql treat the URI as a username. Swap the database in the URI.
ADMIN_DB_URL=${PG_ADMIN_URL%/*}/$DB_NAME
psql "$ADMIN_DB_URL" -v ON_ERROR_STOP=1 <<SQL
CREATE SCHEMA scroll;
REVOKE CREATE ON SCHEMA scroll FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;

DO \$\$
DECLARE i int;
BEGIN
  FOR i IN 1..20 LOOP
    EXECUTE format(\$f\$
      CREATE TABLE scroll.pad_%s (
        id integer PRIMARY KEY,
        code text NOT NULL,
        updated_at timestamptz NOT NULL,
        is_deleted boolean NOT NULL DEFAULT false
      )
    \$f\$, lpad(i::text, 2, '0'));
    EXECUTE format(\$f\$
      INSERT INTO scroll.pad_%s (id, code, updated_at, is_deleted) VALUES
        (1, 'a', timestamptz '2026-11-01 00:00:00+00', false),
        (2, 'b', timestamptz '2026-11-02 00:00:00+00', false)
    \$f\$, lpad(i::text, 2, '0'));
  END LOOP;
  FOR i IN 1..4 LOOP
    EXECUTE format(\$f\$
      CREATE TABLE scroll.nokey_%s (
        code text NOT NULL,
        updated_at timestamptz NOT NULL,
        is_deleted boolean NOT NULL DEFAULT false
      )
    \$f\$, lpad(i::text, 2, '0'));
    EXECUTE format(\$f\$
      INSERT INTO scroll.nokey_%s (code, updated_at) VALUES
        ('a', timestamptz '2026-11-01 00:00:00+00'),
        ('b', timestamptz '2026-11-02 00:00:00+00')
    \$f\$, lpad(i::text, 2, '0'));
  END LOOP;
END \$\$;

CREATE TABLE scroll.dupkeys (
  code text NOT NULL,
  updated_at timestamptz NOT NULL,
  is_deleted boolean NOT NULL DEFAULT false
);
INSERT INTO scroll.dupkeys (code, updated_at) VALUES
  ('same', timestamptz '2026-11-01 00:00:00+00'),
  ('same', timestamptz '2026-11-02 00:00:00+00');

GRANT CONNECT ON DATABASE "$DB_NAME" TO "$ROLE";
GRANT USAGE ON SCHEMA scroll TO "$ROLE";
GRANT SELECT ON ALL TABLES IN SCHEMA scroll TO "$ROLE";
SQL

echo "host=127.0.0.1 port=5432 database=$DB_NAME schema=scroll user=$ROLE password=$PASS tables=25"
