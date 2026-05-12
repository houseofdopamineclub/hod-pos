import { Router, type IRouter } from "express";
import { readFile } from "node:fs/promises";
import path from "node:path";

const router: IRouter = Router();

const PREVIEW_FILE = path.resolve(
  process.cwd(),
  "../../attached_assets/hod-wallet-v3-PREVIEW.html",
);

router.get("/preview", async (_req, res, next) => {
  try {
    const html = await readFile(PREVIEW_FILE, "utf8");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(html);
  } catch (err) {
    next(err);
  }
});

export default router;
