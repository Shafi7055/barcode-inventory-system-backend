const ROLE_PERMISSIONS = {
  Admin: ["*"],
  "Component Tracker": ["component-tracking", "components:read"],
  "Receive User": ["receipts", "products:read", "stock-points:receive"],
  "Delivery User": ["deliveries", "stock-points:delivery"],
  "Report Viewer": ["reports:read"],
};

function permissionsForRole(role) {
  return ROLE_PERMISSIONS[role] || [];
}

export { ROLE_PERMISSIONS, permissionsForRole };
