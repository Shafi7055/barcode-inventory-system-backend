import { Router } from "express";
import {
  createComponent,
  createProduct,
  createStockPoint,
  listComponents,
  listProducts,
  listStockPoints,
  setProductRequiredComponents,
} from "../controllers/catalog.controller.js";
import { getDashboard } from "../controllers/dashboard.controller.js";
import {
  deliveredProducts,
  receivedProducts,
  trackedProducts,
} from "../controllers/activity.controller.js";
import {
  deliverStock,
  receiveStock,
  reverseTransaction,
  trackComponent,
} from "../controllers/inventory.controller.js";
import {
  auditLogs,
  barcodeHistory,
  stockDetails,
  summary,
} from "../controllers/reports.controller.js";
import {
  requirePermission,
  requireStockPointRead,
} from "../middleware/auth.js";

const apiRouter = Router();

apiRouter.get("/dashboard", requirePermission("dashboard:read"), getDashboard);
apiRouter.get("/activity/tracked-products", requirePermission("activity:tracked"), trackedProducts);
apiRouter.get("/activity/received-products", requirePermission("activity:received"), receivedProducts);
apiRouter.get("/activity/delivered-products", requirePermission("activity:delivered"), deliveredProducts);
apiRouter.get("/products", requirePermission("products:read"), listProducts);
apiRouter.post("/products", requirePermission("master-data:write"), createProduct);
apiRouter.put("/products/:productId/required-components", requirePermission("master-data:write"), setProductRequiredComponents);
apiRouter.get("/components", requirePermission("components:read"), listComponents);
apiRouter.post("/components", requirePermission("master-data:write"), createComponent);
apiRouter.get("/stock-points", requireStockPointRead, listStockPoints);
apiRouter.post("/stock-points", requirePermission("master-data:write"), createStockPoint);
apiRouter.post("/component-tracking", requirePermission("component-tracking"), trackComponent);
apiRouter.post("/receipts", requirePermission("receipts"), receiveStock);
apiRouter.post("/deliveries", requirePermission("deliveries"), deliverStock);
apiRouter.post("/transactions/:transactionId/reversals", requirePermission("transactions:reverse"), reverseTransaction);
apiRouter.get("/reports/stock-details", requirePermission("reports:read"), stockDetails);
apiRouter.get("/reports/summary", requirePermission("reports:read"), summary);
apiRouter.get("/reports/barcode-history", requirePermission("reports:read"), barcodeHistory);
apiRouter.get("/audit-logs", requirePermission("audit:read"), auditLogs);

export { apiRouter };
