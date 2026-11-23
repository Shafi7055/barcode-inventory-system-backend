const ROLE_PERMISSIONS = {
  Admin: ["*"],
  "Component Tracker": ["component-tracking", "components:read", "activity:tracked"],
  "Receive User": ["receipts", "products:read", "stock-points:receive", "activity:received"],
  "Delivery User": ["deliveries", "stock-points:delivery", "activity:delivered"],
  "Report Viewer": ["reports:read"],
};

function permissionsForRole(role) {
  return ROLE_PERMISSIONS[role] || [];
}

export { permissionsForRole };
