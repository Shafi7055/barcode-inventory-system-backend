import { Router } from "express";
import {
  changePassword,
  currentUser,
  login,
  logout,
  registerViewer,
} from "../controllers/auth.controller.js";
import { requireAuth } from "../middleware/auth.js";

const authRouter = Router();

authRouter.post("/login", login);
authRouter.post("/register", registerViewer);
authRouter.post("/logout", logout);
authRouter.get("/me", requireAuth, currentUser);
authRouter.post("/password", requireAuth, changePassword);

export { authRouter };
