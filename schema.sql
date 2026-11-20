CREATE SCHEMA IF NOT EXISTS barcode_inventory;
SET search_path TO barcode_inventory;

CREATE TABLE IF NOT EXISTS users (
  user_id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS components (
  component_id SERIAL PRIMARY KEY,
  component_name TEXT NOT NULL,
  component_code TEXT NOT NULL UNIQUE,
  component_barcode TEXT NOT NULL UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stock_points (
  point_id SERIAL PRIMARY KEY,
  point_name TEXT NOT NULL,
  point_type TEXT NOT NULL CHECK (point_type IN ('RECEIVE', 'DELIVERY')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (point_name, point_type)
);

CREATE TABLE IF NOT EXISTS product_instances (
  unit_id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(product_id),
  barcode TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'IN_STOCK' CHECK (status IN ('IN_STOCK', 'DELIVERED')),
  receive_point_id INTEGER REFERENCES stock_points(point_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS product_instance_components (
  id SERIAL PRIMARY KEY,
  unit_id INTEGER NOT NULL REFERENCES product_instances(unit_id),
  component_id INTEGER NOT NULL REFERENCES components(component_id),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (unit_id, component_id)
);

CREATE TABLE IF NOT EXISTS inventory_transactions (
  transaction_id SERIAL PRIMARY KEY,
  unit_id INTEGER NOT NULL REFERENCES product_instances(unit_id),
  event_type TEXT NOT NULL CHECK (event_type IN ('COMPONENT', 'RECEIVED', 'DELIVERED', 'REVERSED')),
  point_id INTEGER REFERENCES stock_points(point_id),
  user_id INTEGER NOT NULL REFERENCES users(user_id),
  reason TEXT,
  transaction_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  original_transaction_id INTEGER REFERENCES inventory_transactions(transaction_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS inventory_transactions_one_reversal
  ON inventory_transactions(original_transaction_id)
  WHERE original_transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS inventory_transactions_unit_time
  ON inventory_transactions(unit_id, transaction_time DESC);

CREATE TABLE IF NOT EXISTS receipts (
  receipt_id SERIAL PRIMARY KEY,
  transaction_id INTEGER NOT NULL UNIQUE REFERENCES inventory_transactions(transaction_id),
  barcode TEXT NOT NULL,
  received_by INTEGER NOT NULL REFERENCES users(user_id),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deliveries (
  delivery_id SERIAL PRIMARY KEY,
  transaction_id INTEGER NOT NULL UNIQUE REFERENCES inventory_transactions(transaction_id),
  barcode TEXT NOT NULL,
  delivered_by INTEGER NOT NULL REFERENCES users(user_id),
  delivered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  log_id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(user_id),
  action TEXT NOT NULL,
  table_name TEXT NOT NULL,
  old_value JSONB,
  new_value JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS idempotency_records (
  user_id INTEGER NOT NULL REFERENCES users(user_id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS legacy_user_map (
  legacy_user_id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(user_id)
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  migration_name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
