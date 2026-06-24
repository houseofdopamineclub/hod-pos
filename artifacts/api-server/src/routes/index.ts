import { Router, type IRouter } from "express";
import healthRouter from "./health";
import downloadRouter from "./download";
import whatsappRouter from "./whatsapp";

const router: IRouter = Router();

router.use(healthRouter);
router.use(downloadRouter);
router.use(whatsappRouter);

export default router;
