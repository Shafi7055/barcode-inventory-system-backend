import { Router } from "express";
import {
  createUser,
  listRoles,
  listUsers,
  updateUser,
} from "../controllers/users.controller.js";
import { requirePermission } from "../middleware/auth.js";

const usersRouter = Router();
const manageUsers = requirePermission("users:manage");

usersRouter.get("/", manageUsers, listUsers);
usersRouter.get("/roles", manageUsers, listRoles);
usersRouter.post("/", manageUsers, createUser);
usersRouter.patch("/:userId", manageUsers, updateUser);

export { usersRouter };
