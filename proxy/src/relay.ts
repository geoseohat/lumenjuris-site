import type { Request, Response } from "express";
import http from "http";
import { BACKEND_URL, BACKNODE_URL } from "./config.js";

// Réponse JSON du backend Python, avec la conso de tokens éventuelle.
export type OpenAiUsagePayload = {
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
};

export type PythonJsonResponse = Record<string, any> & {
  openai_tokens?: OpenAiUsagePayload;
};

// ---- Relay vers Python backend ------------------------------------------------

/** Relais streaming (multipart / body non parsé) vers le backend Python. */
export function relayStreamToPython(
  req: Request,
  res: Response,
  targetPath: string,
): void {
  const backendUrl = new URL(`${BACKEND_URL}${targetPath}`);
  const options: http.RequestOptions = {
    hostname: backendUrl.hostname,
    port: Number(backendUrl.port) || 80,
    path: backendUrl.pathname,
    method: req.method,
    headers: { ...req.headers, host: backendUrl.host },
  };
  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers as any);
    proxyRes.pipe(res, { end: true });
  });
  proxyReq.on("error", (e) => {
    console.error("relay Python error:", e.message);
    if (!res.headersSent) res.status(502).json({ error: "python_unreachable" });
  });
  req.pipe(proxyReq, { end: true });
}

/** Relais JSON vers le backend Python, avec un hook optionnel sur la réponse. */
export function relayJsonToPython(
  req: Request,
  res: Response,
  targetPath: string,
  handleData?: (data: PythonJsonResponse, userId?: number) => Promise<void>,
): void {
  fetch(`${BACKEND_URL}${targetPath}`, {
    method: req.method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req.body),
  })
    .then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (handleData)
        await handleData(data, res.locals.userId as number | undefined);
      res.status(r.status).json(data);
    })
    .catch((e: any) => {
      console.error("relay Python error:", e.message);
      if (!res.headersSent)
        res.status(502).json({ error: "python_unreachable" });
    });
}

// ---- Relay vers le serveur Node (backNode) ------------------------------------

/** Relais JSON vers backNode (propage cookie, clé interne et identité utilisateur). */
export function relayToNode(
  req: Request,
  res: Response,
  targetPath: string,
): void {
  // L'hébergeur (O2switch) bloque les requêtes PATCH : la connexion est coupée
  // avant d'atteindre backNode. On les envoie donc en POST, avec un en-tête qui
  // porte la vraie méthode ; backNode la rétablit avant son routage
  // (voir methodOverrideMiddleware côté backNode).
  const estUnPatch = req.method === "PATCH";

  fetch(`${BACKNODE_URL}${targetPath}`, {
    method: estUnPatch ? "POST" : req.method,
    headers: {
      "Content-Type": "application/json",
      ...(estUnPatch ? { "x-http-method-override": "PATCH" } : {}),
      cookie: req.headers.cookie || "",
      // IP reelle du visiteur : sans elle, backNode voit le proxy et applique
      // ses quotas (connexion, quota global) a tous les utilisateurs en commun.
      "x-forwarded-for": req.ip || "",
      // Navigateur d'origine : tracé dans le journal de preuve des signatures.
      "user-agent": req.headers["user-agent"] || "",
      "x-internal-api-key": process.env.INTERNAL_API_KEY || "",
      ...(res.locals.userId !== undefined
        ? {
          "x-user-id": String(res.locals.userId),
          "x-user-role": String(res.locals.role ?? "USER"),
        }
        : {}),
    },
    body: req.method === "GET" ? undefined : JSON.stringify(req.body),
  })
    .then(async (r) => {
      if (r.headers.has("x-auto-logged")) {
        res.setHeader("X-Auto-Logged", "true");
      }
      const setCookieHeader =
        typeof (r.headers as any).getSetCookie === "function"
          ? (r.headers as any).getSetCookie()
          : r.headers.get("set-cookie");

      if (
        setCookieHeader &&
        ((Array.isArray(setCookieHeader) && setCookieHeader.length > 0) ||
          !Array.isArray(setCookieHeader))
      ) {
        res.setHeader("set-cookie", setCookieHeader);
      }

      // 304 n'a pas de body — on le remonte en 200 vide pour ne pas bloquer le front
      if (r.status === 304) {
        res.status(200).json({ success: false, status: 304, raw: "" });
        return;
      }

      const contentType = r.headers.get("content-type") || "";

      if (contentType.includes("application/json")) {
        const data = await r.json().catch(() => ({}));
        res.status(r.status).json(data);
        return;
      }

      const text = await r.text().catch(() => "");
      res.status(r.status).json({
        success: r.ok,
        status: r.status,
        raw: text,
      });
    })
    .catch((e: any) => {
      console.error("relay Node error:", e.message);
      if (!res.headersSent)
        res.status(502).json({ error: "backnode_unreachable" });
    });
}

/**
 * Relais vers backNode en passthrough binaire : préserve le content-type et
 * le content-disposition de la réponse (PDF déchiffré, CSV d'export…). À utiliser
 * pour les endpoints qui ne renvoient PAS du JSON.
 */
export function relayToNodeRaw(
  req: Request,
  res: Response,
  targetPath: string,
): void {
  fetch(`${BACKNODE_URL}${targetPath}`, {
    method: req.method,
    headers: {
      cookie: req.headers.cookie || "",
      "x-forwarded-for": req.ip || "",
      "user-agent": req.headers["user-agent"] || "",
      "x-internal-api-key": process.env.INTERNAL_API_KEY || "",
      ...(res.locals.userId !== undefined
        ? {
          "x-user-id": String(res.locals.userId),
          "x-user-role": String(res.locals.role ?? "USER"),
        }
        : {}),
    },
  })
    .then(async (r) => {
      const ct = r.headers.get("content-type") || "application/octet-stream";
      const cd = r.headers.get("content-disposition");
      const buf = Buffer.from(await r.arrayBuffer());
      res.status(r.status);
      res.setHeader("content-type", ct);
      if (cd) res.setHeader("content-disposition", cd);
      res.send(buf);
    })
    .catch((e: any) => {
      console.error("relay Node raw error:", e.message);
      if (!res.headersSent)
        res.status(502).json({ error: "backnode_unreachable" });
    });
}

/** Construit un chemin backNode en propageant la query string entrante. */
export function withQuery(base: string, req: Request): string {
  const i = req.originalUrl.indexOf("?");
  return i >= 0 ? `${base}${req.originalUrl.slice(i)}` : base;
}
