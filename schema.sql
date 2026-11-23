CREATE SCHEMA IF NOT EXISTS barcode_inventory;
SET search_path TO barcode_inventory;

DO $$
BEGIN
  IF to_regclass('barcode_inventory.stock_points') IS NOT NULL
     AND to_regclass('barcode_inventory.points') IS NULL THEN
    ALTER TABLE stock_points RENAME TO points;
  END IF;

  IF to_regclass('barcode_inventory.product_instances') IS NOT NULL
     AND to_regclass('barcode_inventory.units') IS NULL THEN
    ALTER TABLE product_instances RENAME TO units;
  END IF;

  IF to_regclass('barcode_inventory.product_instance_components') IS NOT NULL
     AND to_regclass('barcode_inventory.unit_components') IS NULL THEN
    ALTER TABLE product_instance_components RENAME TO unit_components;
  END IF;

  IF to_regclass('barcode_inventory.inventory_transactions') IS NOT NULL
     AND to_regclass('barcode_inventory.inventory_history') IS NULL THEN
    ALTER TABLE inventory_transactions RENAME TO inventory_history;
  END IF;
END $$;

DROP TABLE IF EXISTS receipts;
DROP TABLE IF EXISTS deliveries;
DROP TABLE IF EXISTS auth_sessions;
DROP TABLE IF EXISTS idempotency_records;
DROP TABLE IF EXISTS legacy_user_map;
DROP TABLE IF EXISTS schema_migrations;

CREATE TABLE IF NOT EXISTS roles (
  role_id SERIAL PRIMARY KEY,
  role_name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO roles (role_name)
VALUES
  ('Admin'),
  ('Component Tracker'),
  ('Receive User'),
  ('Delivery User'),
  ('Report Viewer')
ON CONFLICT (role_name) DO NOTHING;

CREATE TABLE IF NOT EXISTS users (
  user_id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT,
  password_hash TEXT,
  role_id INTEGER REFERENCES roles(role_id),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role_id INTEGER REFERENCES roles(role_id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique
  ON users (LOWER(username))
  WHERE username IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_one_system_actor
  ON users(is_system)
  WHERE is_system = TRUE;

INSERT INTO users (name, is_system)
SELECT 'Local operator', TRUE
WHERE NOT EXISTS (SELECT 1 FROM users WHERE is_system = TRUE);

CREATE TABLE IF NOT EXISTS products (
  product_id SERIAL PRIMARY KEY,
  product_name TEXT NOT NULL,
  product_code TEXT NOT NULL UNIQUE,
  description TEXT,
  required_component_codes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS required_component_codes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE IF NOT EXISTS components (
  component_id SERIAL PRIMARY KEY,
  component_name TEXT NOT NULL,
  component_code TEXT NOT NULL UNIQUE,
  component_barcode TEXT NOT NULL UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS points (
  point_id SERIAL PRIMARY KEY,
  point_name TEXT NOT NULL,
  point_type TEXT NOT NULL CHECK (point_type IN ('RECEIVE', 'DELIVERY')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (point_name, point_type)
);

CREATE TABLE IF NOT EXISTS units (
  unit_id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(product_id),
  barcode TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'PENDING_RECEIPT'
    CHECK (status IN ('PENDING_RECEIPT', 'IN_STOCK', 'DELIVERED')),
  receive_point_id INTEGER REFERENCES points(point_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE units DROP CONSTRAINT IF EXISTS product_instances_status_check;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'barcode_inventory.units'::regclass
      AND conname = 'units_status_check'
  ) THEN
    ALTER TABLE units
      ADD CONSTRAINT units_status_check
      CHECK (status IN ('PENDING_RECEIPT', 'IN_STOCK', 'DELIVERED'));
  END IF;
END $$;
ALTER TABLE units ALTER COLUMN status SET DEFAULT 'PENDING_RECEIPT';

CREATE TABLE IF NOT EXISTS unit_components (
  id SERIAL PRIMARY KEY,
  unit_id INTEGER NOT NULL REFERENCES units(unit_id),
  component_id INTEGER NOT NULL REFERENCES components(component_id),
  received_at TIMESTAMPTZ,
  received_by INTEGER REFERENCES users(user_id),
  received_point_id INTEGER REFERENCES points(point_id),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (unit_id, component_id)
);

ALTER TABLE unit_components ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ;
ALTER TABLE unit_components ADD COLUMN IF NOT EXISTS received_by INTEGER REFERENCES users(user_id);
ALTER TABLE unit_components ADD COLUMN IF NOT EXISTS received_point_id INTEGER REFERENCES points(point_id);
ALTER TABLE unit_components ADD COLUMN IF NOT EXISTS component_barcode TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS unit_components_component_barcode_unique
  ON unit_components(component_barcode)
  WHERE component_barcode IS NOT NULL;

CREATE TABLE IF NOT EXISTS inventory_history (
  transaction_id SERIAL PRIMARY KEY,
  unit_id INTEGER NOT NULL REFERENCES units(unit_id),
  event_type TEXT NOT NULL CHECK (event_type IN ('COMPONENT', 'COMPONENT_RECEIVED', 'RECEIVED', 'DELIVERED', 'REVERSED')),
  component_id INTEGER REFERENCES components(component_id),
  point_id INTEGER REFERENCES points(point_id),
  user_id INTEGER NOT NULL REFERENCES users(user_id),
  reason TEXT,
  transaction_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  original_transaction_id INTEGER REFERENCES inventory_history(transaction_id)
);

ALTER TABLE inventory_history ADD COLUMN IF NOT EXISTS component_id INTEGER REFERENCES components(component_id);
DO $$
DECLARE
  event_constraint RECORD;
BEGIN
  FOR event_constraint IN
    SELECT conname, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid = 'barcode_inventory.inventory_history'::regclass
      AND contype = 'c'
  LOOP
    IF event_constraint.definition LIKE '%event_type%'
       AND event_constraint.definition NOT LIKE '%COMPONENT_RECEIVED%' THEN
      EXECUTE format('ALTER TABLE inventory_history DROP CONSTRAINT %I', event_constraint.conname);
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'barcode_inventory.inventory_history'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%COMPONENT_RECEIVED%'
  ) THEN
    ALTER TABLE inventory_history
      ADD CONSTRAINT inventory_history_event_type_check
      CHECK (event_type IN ('COMPONENT', 'COMPONENT_RECEIVED', 'RECEIVED', 'DELIVERED', 'REVERSED'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS inventory_history_one_reversal
  ON inventory_history(original_transaction_id)
  WHERE original_transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS inventory_history_unit_time
  ON inventory_history(unit_id, transaction_time DESC);

CREATE INDEX IF NOT EXISTS inventory_history_component
  ON inventory_history(component_id, transaction_time DESC)
  WHERE component_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS audit_logs (
  log_id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(user_id),
  action TEXT NOT NULL,
  table_name TEXT NOT NULL,
  old_value JSONB,
  new_value JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

