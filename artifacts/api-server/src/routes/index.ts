import { Router, type IRouter } from "express";
import healthRouter from "./health";
import nflRouter from "./nfl";

const router: IRouter = Router();

router.use(healthRouter);
router.use(nflRouter);

export default router;
