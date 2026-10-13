import { Router } from "express";
import { proxyAuthMiddleware as auth } from "../middleware/authMiddleware.js";
import { relayToNode, relayToNodeRaw } from "../relay.js";
import { trackFeature } from "../tracking.js";

// Monté sur "/api/signature-envelope" — chemins relatifs.
export const signatureRouter: Router = Router();

// Routes authentifiées
signatureRouter.get("/stats", auth, (req, res) =>
  relayToNode(req, res, "/signature-envelope/stats"),
);
signatureRouter.get("/", auth, (req, res) => {
  const qs = req.query["status"]
    ? `?status=${encodeURIComponent(req.query["status"] as string)}`
    : "";
  relayToNode(req, res, `/signature-envelope${qs}`);
});
signatureRouter.post("/", auth, (req, res) => {
  void trackFeature("esignature", res.locals.userId as number | undefined);
  relayToNode(req, res, "/signature-envelope");
});
signatureRouter.post("/resend", auth, (req, res) =>
  relayToNode(req, res, "/signature-envelope/resend"),
);
signatureRouter.get("/download/:externalId", auth, (req, res) =>
  // Réponse binaire (PDF) → passthrough raw, pas d'enveloppe JSON.
  relayToNodeRaw(
    req,
    res,
    `/signature-envelope/download/${encodeURIComponent(req.params.externalId as string)}`,
  ),
);
// Signature de l'émetteur : envoi du code OTP, puis validation avec le code
signatureRouter.post("/:externalId/otp", auth, (req, res) =>
  relayToNode(
    req,
    res,
    `/signature-envelope/${encodeURIComponent(req.params.externalId as string)}/otp`,
  ),
);
signatureRouter.post("/:externalId/sign", auth, (req, res) =>
  relayToNode(
    req,
    res,
    `/signature-envelope/${encodeURIComponent(req.params.externalId as string)}/sign`,
  ),
);
signatureRouter.get("/evidence/:externalId", auth, (req, res) =>
  // Réponse binaire (ZIP du dossier de preuve) → passthrough raw.
  relayToNodeRaw(
    req,
    res,
    `/signature-envelope/evidence/${encodeURIComponent(req.params.externalId as string)}`,
  ),
);
signatureRouter.delete("/:externalId", auth, (req, res) =>
  relayToNode(
    req,
    res,
    `/signature-envelope/${encodeURIComponent(req.params.externalId as string)}`,
  ),
);

// Routes PUBLIQUES — pas d'auth, token dans l'URL
signatureRouter.get("/public/:token/download", (req, res) =>
  // Réponse binaire (PDF signé) → passthrough raw, pas d'enveloppe JSON.
  relayToNodeRaw(
    req,
    res,
    `/signature-envelope/public/${encodeURIComponent(req.params.token as string)}/download`,
  ),
);
signatureRouter.get("/public/:token", (req, res) =>
  relayToNode(
    req,
    res,
    `/signature-envelope/public/${encodeURIComponent(req.params.token as string)}`,
  ),
);
signatureRouter.post("/public/:token", (req, res) =>
  relayToNode(
    req,
    res,
    `/signature-envelope/public/${encodeURIComponent(req.params.token as string)}`,
  ),
);
signatureRouter.post("/public/:token/otp", (req, res) =>
  relayToNode(
    req,
    res,
    `/signature-envelope/public/${encodeURIComponent(req.params.token as string)}/otp`,
  ),
);
signatureRouter.post("/public/:token/decline", (req, res) =>
  relayToNode(
    req,
    res,
    `/signature-envelope/public/${encodeURIComponent(req.params.token as string)}/decline`,
  ),
);
