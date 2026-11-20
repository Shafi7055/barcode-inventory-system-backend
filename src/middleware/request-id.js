import { randomUUID } from "node:crypto";

function requestId(req, _res, next) {
  req.requestId = randomUUID();
  next();
}

export { requestId };
