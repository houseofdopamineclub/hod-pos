import { Router, type IRouter } from "express";
import healthRouter from "./health";
import previewRouter from "./preview";
import whatsappRouter from "./whatsapp";

const router: IRouter = Router();

router.use(healthRouter);
router.use(previewRouter);
router.use(whatsappRouter);

export default router;
