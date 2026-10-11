import { Router } from "express"
import { relayToNode } from "../relay.js"
import { proxyAuthMiddleware as auth } from "../middleware/authMiddleware.js"
import { relayJsonToPython, relayStreamToPython } from "../relay.js"

export const userUploadsRouter: Router = Router()



// Multipart (upload PDF) — stream direct, body non consommé par express.json
userUploadsRouter.post("/extract-document-text", auth, (req, res) => {
    relayStreamToPython(req, res, "/extract-document-text");
  },
);

// Même lecture, fichier envoyé en base64 dans du JSON : chez o2switch, un envoi
// multipart contenant un fichier est détourné avant d'atteindre le relais (404).
userUploadsRouter.post("/extract-document-text-json", auth, (req, res) => {
    relayJsonToPython(req, res, "/extract-document-text-json");
  },
);


userUploadsRouter.get("/", auth, (req, res) => {
    relayToNode(req, res, "/user-uploads");
});

userUploadsRouter.post("/upload", auth, (req, res) => {
    relayToNode(req, res, "/user-uploads/upload");

});


userUploadsRouter.put("/:filename", auth, (req, res) => {
    const filename = encodeURIComponent(req.params.filename as string);
    relayToNode(req, res, `/user-uploads/${filename}`);
});


userUploadsRouter.delete("/:filename", auth, (req, res) => {
    const filename = encodeURIComponent(req.params.filename as string);
    relayToNode(req, res, `/user-uploads/${filename}`);
});



//handleUserUploadsAsset
userUploadsRouter.get("/assets/:filename", auth, async(req, res) => {
    try {
        if (!res.locals.userId) {
            res.status(401).json({ success: false, message: "Non autorisé" });
            return;
        }
        const BACKNODE_URL = process.env.BACKEND_URL
        const filename = encodeURIComponent(req.params.filename as string);
        const r = await fetch(`${BACKNODE_URL}/userassets/${filename}`, {
            headers: {
                "x-internal-api-key": process.env.INTERNAL_API_KEY || "",
                ...(res.locals.userId !== undefined
                    ? {
                        "x-user-id": String(res.locals.userId),
                        "x-user-role": String(res.locals.role ?? "USER"),
                    }
                    : {}),
            }
        });
        if (!r.ok || !r.body) {
            res.status(r.status).end();
            return;
        }
        res.setHeader(
            "content-type",
            r.headers.get("content-type") || "image/webp",
        );
        const { Readable } = await import("stream");
        Readable.fromWeb(r.body as any).pipe(res);
    } catch {
        if (!res.headersSent) res.status(502).end();
    }
});