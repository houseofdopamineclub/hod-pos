import { Router, type IRouter } from "express";
import path from "node:path";
import fs from "node:fs";

const router: IRouter = Router();

const CANDIDATE_PATHS = [
  path.resolve(process.cwd(), "../../attached_assets/index-patched-may1.txt"),
  path.resolve(process.cwd(), "../../../attached_assets/index-patched-may1.txt"),
  path.resolve(process.cwd(), "attached_assets/index-patched-may1.txt"),
  "/home/runner/workspace/attached_assets/index-patched-may1.txt",
];

function findPatchedHtml(): string | null {
  for (const p of CANDIDATE_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

router.get("/download/index.html", (req, res) => {
  const filePath = findPatchedHtml();

  if (!filePath) {
    req.log.error(
      { cwd: process.cwd(), tried: CANDIDATE_PATHS },
      "Patched HTML not found",
    );
    res.status(404).send("Patched HTML not found");
    return;
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="index.html"',
  );
  res.sendFile(filePath);
});

// Inline preview — opens HOD live in browser (NOT a download)
router.get(["/preview", "/preview/", "/preview/index.html"], (req, res) => {
  const filePath = findPatchedHtml();
  if (!filePath) {
    res.status(404).send("HOD preview not found");
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(filePath);
});

const CF_CANDIDATE_PATHS = [
  path.resolve(process.cwd(), "../../attached_assets/hod-cloud-functions.tar.gz"),
  path.resolve(process.cwd(), "../../../attached_assets/hod-cloud-functions.tar.gz"),
  path.resolve(process.cwd(), "attached_assets/hod-cloud-functions.tar.gz"),
  "/home/runner/workspace/attached_assets/hod-cloud-functions.tar.gz",
];

router.get("/download/cloud-functions.tar.gz", (req, res) => {
  const filePath = CF_CANDIDATE_PATHS.find((p) => fs.existsSync(p));
  if (!filePath) {
    req.log.error({ tried: CF_CANDIDATE_PATHS }, "cloud-functions tarball not found");
    res.status(404).send("cloud-functions archive not found");
    return;
  }
  res.setHeader("Content-Type", "application/gzip");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="hod-cloud-functions.tar.gz"',
  );
  res.sendFile(filePath);
});

export default router;
