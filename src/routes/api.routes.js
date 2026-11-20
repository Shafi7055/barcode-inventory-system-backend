import { Router } from "express";
import {
  createComponent,
  createProduct,
  createStockPoint,
  listComponents,
  listProducts,
  listStockPoints,
} from "../controllers/catalog.controller.js";
import { getDashboard } from "../controllers/dashboard.controller.js";
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

const apiRouter = Router();

apiRouter.get("/dashboard", getDashboard);
apiRouter.get("/products", listProducts);
apiRouter.post("/products", createProduct);
apiRouter.get("/components", listComponents);
apiRouter.post("/components", createComponent);
apiRouter.get("/stock-points", listStockPoints);
apiRouter.post("/stock-points", createStockPoint);
apiRouter.post("/component-tracking", trackComponent);
apiRouter.post("/receipts", receiveStock);
apiRouter.post("/deliveries", deliverStock);
apiRouter.post("/transactions/:transactionId/reversals", reverseTransaction);
apiRouter.get("/reports/stock-details", stockDetails);
apiRouter.get("/reports/summary", summary);
apiRouter.get("/reports/barcode-history", barcodeHistory);
apiRouter.get("/audit-logs", auditLogs);

export { apiRouter };
