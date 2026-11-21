const MIGRATION_NAME = "import-public-inventory-v1";
const AUTH_MIGRATION_NAME = "import-public-auth-v1";
const LEGACY_TABLES = [
  "products",
  "components",
  "users",
  "points",
  "units",
  "inventory_history",
  "component_items",
];

async function findLegacyTables(client) {
  const result = await client.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       AND table_name = ANY($1::text[])`,
    [LEGACY_TABLES],
  );
  return new Set(result.rows.map((row) => row.table_name));
}

async function importLegacyData(client) {
  const tables = await findLegacyTables(client);
  if (tables.size === 0) return false;

  const missing = LEGACY_TABLES.filter((table) => !tables.has(table));
  if (missing.length) {
    throw new Error(`Legacy inventory schema is incomplete; missing public tables: ${missing.join(", ")}.`);
  }

  const applied = await client.query(
    "SELECT 1 FROM schema_migrations WHERE migration_name = $1",
    [MIGRATION_NAME],
  );
  if (applied.rowCount) return false;

  const historyBounds = await client.query(
    "SELECT MIN(id) AS minimum, MAX(id) AS maximum FROM public.inventory_history",
  );
  const minimum = Number(historyBounds.rows[0].minimum || 0);
  const maximum = Number(historyBounds.rows[0].maximum || 0);
  if (minimum < 0 || maximum > 2147483647) {
    throw new Error("Legacy inventory history IDs cannot be represented by the new API schema.");
  }

  const unsupportedEvents = await client.query(
    `SELECT DISTINCT event_type::text AS event_type
     FROM public.inventory_history
     WHERE event_type::text NOT IN ('COMPONENT_TRACKED', 'RECEIVED', 'DELIVERED', 'REVERSED')`,
  );
  if (unsupportedEvents.rowCount) {
    throw new Error(`Unsupported legacy inventory event: ${unsupportedEvents.rows[0].event_type}.`);
  }

  await client.query("BEGIN");
  try {
    const legacyUsers = await client.query(
      `SELECT id, full_name, created_at
       FROM public.users ORDER BY id`,
    );
    for (const legacyUser of legacyUsers.rows) {
      const user = await client.query(
        `INSERT INTO users (name, is_system, created_at)
         VALUES ($1, FALSE, $2) RETURNING user_id`,
        [legacyUser.full_name, legacyUser.created_at],
      );
      await client.query(
        "INSERT INTO legacy_user_map (legacy_user_id, user_id) VALUES ($1, $2)",
        [legacyUser.id, user.rows[0].user_id],
      );
    }

    await client.query(
      `INSERT INTO products
         (product_id, product_name, product_code, is_active)
       SELECT id, name, 'legacy-product-' || id::text, deleted_at IS NULL
       FROM public.products
       ORDER BY id`,
    );
    await client.query(
      `INSERT INTO stock_points (point_id, point_name, point_type, is_active)
       SELECT id, name, point_type::text, deleted_at IS NULL
       FROM public.points
       WHERE point_type::text IN ('RECEIVE', 'DELIVERY')
       ORDER BY id`,
    );
    await client.query(
      `INSERT INTO components (component_name, component_code, component_barcode, is_active)
       SELECT c.name, 'legacy-component-' || ci.component_barcode,
              ci.component_barcode, c.deleted_at IS NULL
       FROM public.component_items ci
       JOIN public.components c ON c.id = ci.component_id
       ORDER BY ci.component_barcode`,
    );
    await client.query(
      `INSERT INTO components (component_name, component_code, component_barcode, is_active)
       SELECT c.name, 'legacy-component-catalog-' || c.id::text,
              'legacy-component-catalog-' || c.id::text, FALSE
       FROM public.components c
       WHERE NOT EXISTS (
         SELECT 1 FROM public.component_items ci WHERE ci.component_id = c.id
       )
       ORDER BY c.id`,
    );
    await client.query(
      `INSERT INTO product_instances
         (product_id, barcode, status, receive_point_id, created_at)
       SELECT u.product_id, u.barcode,
              CASE WHEN s.status = 'DELIVERED' THEN 'DELIVERED' ELSE 'IN_STOCK' END,
              receive_point.point_id, u.registered_at
       FROM public.units u
       JOIN public.v_unit_status s ON s.unit_barcode = u.barcode
       LEFT JOIN LATERAL (
         SELECT h.point_id
         FROM public.inventory_history h
         WHERE h.unit_barcode = u.barcode AND h.event_type::text = 'RECEIVED'
         ORDER BY h.created_at DESC, h.id DESC
         LIMIT 1
       ) latest_receive ON TRUE
       LEFT JOIN stock_points receive_point ON receive_point.point_id = latest_receive.point_id
       ORDER BY u.registered_at, u.barcode`,
    );
    await client.query(
      `INSERT INTO inventory_transactions
         (transaction_id, unit_id, event_type, point_id, user_id, reason, transaction_time, original_transaction_id)
       SELECT h.id::integer, pi.unit_id,
              CASE h.event_type::text
                WHEN 'COMPONENT_TRACKED' THEN 'COMPONENT'
                ELSE h.event_type::text
              END,
              CASE WHEN h.event_type::text = 'COMPONENT_TRACKED' THEN NULL ELSE h.point_id END,
              COALESCE(user_map.user_id, operator_actor.user_id),
              h.reason, h.created_at, h.reverses_id::integer
       FROM public.inventory_history h
       JOIN product_instances pi ON pi.barcode = h.unit_barcode
       LEFT JOIN legacy_user_map user_map ON user_map.legacy_user_id = h.user_id
       CROSS JOIN LATERAL (
         SELECT user_id FROM users WHERE is_system = TRUE
       ) operator_actor
       ORDER BY h.id`,
    );
    await client.query(
      `INSERT INTO receipts (transaction_id, barcode, received_by)
       SELECT h.id::integer, h.unit_barcode,
              COALESCE(user_map.user_id, operator_actor.user_id)
       FROM public.inventory_history h
       LEFT JOIN legacy_user_map user_map ON user_map.legacy_user_id = h.user_id
       CROSS JOIN LATERAL (
         SELECT user_id FROM users WHERE is_system = TRUE
       ) operator_actor
       WHERE h.event_type::text = 'RECEIVED'`,
    );
    await client.query(
      `INSERT INTO deliveries (transaction_id, barcode, delivered_by)
       SELECT h.id::integer, h.unit_barcode,
              COALESCE(user_map.user_id, operator_actor.user_id)
       FROM public.inventory_history h
       LEFT JOIN legacy_user_map user_map ON user_map.legacy_user_id = h.user_id
       CROSS JOIN LATERAL (
         SELECT user_id FROM users WHERE is_system = TRUE
       ) operator_actor
       WHERE h.event_type::text = 'DELIVERED'`,
    );
    await client.query(
      `INSERT INTO product_instance_components (unit_id, component_id, created_at)
       SELECT pi.unit_id, c.component_id, ci.attached_at
       FROM public.component_items ci
       JOIN product_instances pi ON pi.barcode = ci.unit_barcode
       JOIN components c ON c.component_barcode = ci.component_barcode
       WHERE ci.unit_barcode IS NOT NULL
       ON CONFLICT (unit_id, component_id) DO NOTHING`,
    );

    const sourceAuditLogs = await client.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'audit_logs'
         AND table_type = 'BASE TABLE'`,
    );
    if (sourceAuditLogs.rowCount) {
      await client.query(
        `INSERT INTO audit_logs (user_id, action, table_name, old_value, new_value, created_at)
         SELECT COALESCE(user_map.user_id, operator_actor.user_id), a.action,
                COALESCE(a.entity_type, 'legacy'), a.old_values, a.new_values, a.created_at
         FROM public.audit_logs a
         LEFT JOIN legacy_user_map user_map ON user_map.legacy_user_id = a.user_id
         CROSS JOIN LATERAL (
           SELECT user_id FROM users WHERE is_system = TRUE
         ) operator_actor`,
      );
    }

    await client.query(
      `SELECT setval(
         pg_get_serial_sequence('barcode_inventory.products', 'product_id'),
         COALESCE(MAX(product_id), 1), MAX(product_id) IS NOT NULL
       ) FROM products`,
    );
    await client.query(
      `SELECT setval(
         pg_get_serial_sequence('barcode_inventory.stock_points', 'point_id'),
         COALESCE(MAX(point_id), 1), MAX(point_id) IS NOT NULL
       ) FROM stock_points`,
    );
    await client.query(
      `SELECT setval(
         pg_get_serial_sequence('barcode_inventory.inventory_transactions', 'transaction_id'),
         COALESCE(MAX(transaction_id), 1), MAX(transaction_id) IS NOT NULL
       ) FROM inventory_transactions`,
    );
    await client.query(
      "INSERT INTO schema_migrations (migration_name) VALUES ($1)",
      [MIGRATION_NAME],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function importLegacyAccounts(client) {
  const result = await client.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       AND table_name = ANY($1::text[])`,
    [["users", "roles"]],
  );
  const tables = new Set(result.rows.map((row) => row.table_name));
  if (!tables.size) return false;
  if (!tables.has("users") || !tables.has("roles")) {
    throw new Error("Legacy authentication schema is incomplete; public.users and public.roles are both required.");
  }

  const applied = await client.query(
    "SELECT 1 FROM schema_migrations WHERE migration_name = $1",
    [AUTH_MIGRATION_NAME],
  );
  if (applied.rowCount) return false;

  const invalidAccounts = await client.query(
    `SELECT COUNT(*)::integer AS total
     FROM public.users u
     LEFT JOIN legacy_user_map m ON m.legacy_user_id = u.id
     LEFT JOIN public.roles old_role ON old_role.id = u.role_id
     LEFT JOIN roles new_role ON LOWER(new_role.role_name) = LOWER(old_role.name)
     WHERE m.user_id IS NULL OR new_role.role_id IS NULL
        OR u.username IS NULL OR BTRIM(u.username) = ''
        OR LENGTH(BTRIM(u.username)) > 64 OR u.password_hash IS NULL`,
  );
  if (invalidAccounts.rows[0].total) {
    throw new Error("Legacy accounts contain missing mappings, usernames, password hashes, or unsupported roles.");
  }

  const duplicateUsernames = await client.query(
    `SELECT COUNT(*)::integer AS total
     FROM (
       SELECT LOWER(BTRIM(username))
       FROM public.users
       GROUP BY LOWER(BTRIM(username))
       HAVING COUNT(*) > 1
     ) duplicates`,
  );
  if (duplicateUsernames.rows[0].total) {
    throw new Error("Legacy accounts contain duplicate usernames and cannot be imported safely.");
  }

  await client.query("BEGIN");
  try {
    const imported = await client.query(
      `UPDATE users target
       SET username = LOWER(BTRIM(source.username)),
           password_hash = source.password_hash,
           role_id = new_role.role_id,
           is_active = source.is_active,
           updated_at = source.updated_at
       FROM legacy_user_map user_map
       JOIN public.users source ON source.id = user_map.legacy_user_id
       JOIN public.roles old_role ON old_role.id = source.role_id
       JOIN roles new_role ON LOWER(new_role.role_name) = LOWER(old_role.name)
       WHERE target.user_id = user_map.user_id`,
    );
    if (imported.rowCount !== Number((await client.query("SELECT COUNT(*) AS total FROM public.users")).rows[0].total)) {
      throw new Error("Not all legacy accounts could be imported.");
    }
    await client.query(
      "INSERT INTO schema_migrations (migration_name) VALUES ($1)",
      [AUTH_MIGRATION_NAME],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export { importLegacyAccounts, importLegacyData };
