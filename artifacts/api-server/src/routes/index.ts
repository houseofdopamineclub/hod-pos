import { Router, type IRouter } from "express";
import healthRouter from "./health";
import previewRouter from "./preview";

const router: IRouter = Router();

router.use(healthRouter);
router.use(previewRouter);

export default router;
