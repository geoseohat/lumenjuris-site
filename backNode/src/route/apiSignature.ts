import express from "express"
import type { Request, Response, Router } from "express"
import fs from "fs/promises"
import path from "path"
import crypto from "crypto"
import { authMiddleware } from "../middleware/authMiddleware.js"
import {
    SignatureEnvelopeService,
    SignatureFlowError,
    sanitizeFileName,
} from "../services/classSignatureEnvelope.js"
import type { EnvelopeFieldsPayload, EnvelopeStatusValue } from "../services/classSignatureEnvelope.js"
import { getRequestContext, sha256Hex } from "../services/classSignatureLog.js"
import { prisma } from "../../prisma/singletonPrisma.js"
import { encryptBuffer, decryptBuffer } from "../services/encryption.js"
import { Credit } from "../services/classCredit.js"

const router: Router = express.Router()
const svc = new SignatureEnvelopeService()

const ENVELOPES_DIR = path.join(process.cwd(), "signatureenvelopes")

/**
 * Réponse d'erreur commune : une SignatureFlowError porte son code HTTP et son
 * message ; toute autre erreur est une erreur serveur.
 */
function sendError(res: Response, err: unknown, logLabel: string) {
    if (err instanceof SignatureFlowError) {
        return res.status(err.httpStatus).json({
            success: false,
            message: err.message,
            ...(err.code ? { code: err.code } : {}),
            ...(err.extra ?? {}),
        })
    }
    console.error(`[signature] ${logLabel} error:`, err)
    return res.status(500).json({ success: false, message: "Erreur serveur." })
}

/** Lit le code OTP et le consentement envoyés par le signataire. */
function readConfirmation(body: unknown) {
    const { code, consentAccepted } = (body ?? {}) as { code?: unknown; consentAccepted?: unknown }
    return {
        code: typeof code === "string" ? code : "",
        consentAccepted: consentAccepted === true,
    }
}

/** GET /signature-envelope/stats — agrégats pour le dashboard. */
router.get("/stats", authMiddleware, async (req: Request, res: Response) => {
    try {
        const userId = Number(req.idUser)
        const stats = await svc.stats(userId)
        return res.json({ success: true, data: stats })
    } catch (err) {
        return sendError(res, err, "stats")
    }
})

/**
 * GET /signature-envelope?status=DRAFT|SENT|...
 * Liste des enveloppes de l'utilisateur, optionnellement filtrées par statut.
 */
router.get("/", authMiddleware, async (req: Request, res: Response) => {
    try {
        const userId = Number(req.idUser)
        const statusRaw = req.query["status"] as string | undefined
        const status = isValidStatus(statusRaw) ? (statusRaw as EnvelopeStatusValue) : undefined
        const list = await svc.list(userId, status)
        return res.json({ success: true, data: list })
    } catch (err) {
        return sendError(res, err, "list")
    }
})

/**
 * POST /signature-envelope
 * Crée l'enveloppe en brouillon. Reçoit le PDF en base64 (sauvegardé sur
 * disque) + les champs/signatures (chiffrés en DB) + le cocontractant.
 *
 * Rien n'est envoyé au cocontractant à ce stade : l'émetteur doit d'abord
 * confirmer sa signature avec un code OTP (routes /:externalId/otp et /:externalId/sign).
 */
router.post("/", authMiddleware, async (req: Request, res: Response) => {
    try {
        const userId = Number(req.idUser)
        const body = req.body as {
            documentName?: string
            fileBase64?: string
            numPages?: number
            fields?: EnvelopeFieldsPayload
            counterpartyName?: string
            counterpartyEmail?: string
        }

        if (!body.documentName || !body.fileBase64 || !body.fields) {
            return res.status(400).json({ success: false, message: "documentName, fileBase64 et fields requis." })
        }
        if (!body.counterpartyName || !body.counterpartyEmail) {
            return res.status(400).json({ success: false, message: "Nom et e-mail du cocontractant requis." })
        }

        // Quota : 1 crédit "signature" par invitation envoyée. On vérifie dès
        // la création pour ne pas faire signer l'émetteur pour rien ; le
        // décompte se fait à l'envoi de l'invitation (route /:externalId/sign).
        const quota = await new Credit().hasFeatureQuota(userId, "signature")
        if (quota.success && quota.data?.allowed === false) {
            return res.status(402).json({
                success: false,
                code: "QUOTA_EXCEEDED",
                message: "Quota de signatures épuisé. Passez à un plan supérieur pour continuer.",
            })
        }

        // Sauvegarde le PDF chiffré sur le filesystem (pas en DB pour ne pas alourdir)
        const originalPdf = Buffer.from(body.fileBase64, "base64")
        await fs.mkdir(ENVELOPES_DIR, { recursive: true })
        const storedName = crypto.randomBytes(8).toString("hex") + ".pdf.enc"
        const filePath = path.join(ENVELOPES_DIR, storedName)
        await fs.writeFile(filePath, encryptBuffer(originalPdf))

        const user = await prisma.user.findUnique({
            where: { idUser: userId },
            select: { email: true, prenom: true, nom: true },
        })
        if (!user?.email) {
            throw new Error("L'e-mail de l'utilisateur est introuvable.")
        }
        const selfName = [user.prenom, user.nom].filter(Boolean).join(" ").trim()

        const dto = await svc.create(
            userId,
            {
                documentName: body.documentName,
                documentFilePath: filePath,
                originalDocumentHash: sha256Hex(originalPdf),
                numPages: body.numPages ?? 1,
                fields: body.fields,
                selfName,
                selfEmail: user.email,
                counterpartyName: body.counterpartyName.trim(),
                counterpartyEmail: body.counterpartyEmail.trim(),
            },
            getRequestContext(req),
        )

        return res.status(201).json({ success: true, data: dto })
    } catch (err) {
        return sendError(res, err, "create")
    }
})

/**
 * POST /signature-envelope/:externalId/otp
 * Envoie à l'émetteur le code qui confirmera sa signature.
 */
router.post("/:externalId/otp", authMiddleware, async (req: Request, res: Response) => {
    try {
        const userId = Number(req.idUser)
        await svc.requestSenderOtp(userId, req.params["externalId"] as string, getRequestContext(req))
        return res.json({ success: true })
    } catch (err) {
        return sendError(res, err, "sender otp")
    }
})

/**
 * POST /signature-envelope/:externalId/sign   body: { code, consentAccepted }
 * L'émetteur confirme sa signature avec le code reçu ; l'invitation part
 * alors chez le cocontractant.
 */
router.post("/:externalId/sign", authMiddleware, async (req: Request, res: Response) => {
    try {
        const userId = Number(req.idUser)
        const result = await svc.signAsSender(
            userId,
            req.params["externalId"] as string,
            readConfirmation(req.body),
            getRequestContext(req),
        )
        if (result.invitationSent) {
            await new Credit().consumeQuota(userId, "signature")
        }
        return res.json({ success: true, data: result.envelope, invitationSent: result.invitationSent })
    } catch (err) {
        return sendError(res, err, "sender sign")
    }
})

/**
 * GET /signature-envelope/evidence/:externalId
 * Dossier de preuve (ZIP), re-téléchargeable par l'émetteur.
 */
router.get("/evidence/:externalId", authMiddleware, async (req: Request, res: Response) => {
    try {
        const userId = Number(req.idUser)
        const evidence = await svc.exportEvidence(userId, req.params["externalId"] as string, getRequestContext(req))
        res.setHeader("Content-Type", "application/zip")
        res.setHeader("Content-Disposition", `attachment; filename="${evidence.fileName}"`)
        return res.send(evidence.buffer)
    } catch (err) {
        return sendError(res, err, "evidence")
    }
})

/**
 * DELETE /signature-envelope/:externalId
 * Archive l'enveloppe : la preuve est conservée, on ne supprime plus.
 */
router.delete("/:externalId", authMiddleware, async (req: Request, res: Response) => {
    try {
        const userId = Number(req.idUser)
        await svc.archive(userId, req.params["externalId"] as string, getRequestContext(req))
        return res.json({ success: true })
    } catch (err) {
        return sendError(res, err, "archive")
    }
})

/** Garde-fou : seuls les statuts attendus sont acceptés en filtre. */
function isValidStatus(s: string | undefined): boolean {
    return s === "DRAFT" || s === "SENT" || s === "PARTIALLY_SIGNED"
        || s === "SIGNED" || s === "DECLINED" || s === "EXPIRED" || s === "ARCHIVED"
}

// ─── Routes PUBLIQUES (sans auth) pour la page de signature cocontractant ──────

/**
 * GET /public/:token
 * Retourne les métadonnées de l'enveloppe + les champs (déchiffrés) + le PDF
 * en base64. Accessible sans cookie d'auth — le token est le secret.
 */
router.get("/public/:token", async (req: Request, res: Response) => {
    try {
        const result = await svc.openByToken(req.params["token"] as string, getRequestContext(req))

        // Charge le PDF en base64 si le fichier existe
        let fileBase64: string | null = null
        if (result.documentFilePath) {
            try {
                const buf = decryptBuffer(await fs.readFile(result.documentFilePath))
                fileBase64 = buf.toString("base64")
            } catch { /* fichier absent → null */ }
        }

        return res.json({ success: true, data: { meta: result.meta, fields: result.fields, fileBase64 } })
    } catch (err) {
        return sendError(res, err, "public get")
    }
})

/**
 * POST /public/:token/otp
 * Envoie au cocontractant le code qui confirmera sa signature.
 */
router.post("/public/:token/otp", async (req: Request, res: Response) => {
    try {
        await svc.requestCounterpartyOtp(req.params["token"] as string, getRequestContext(req))
        return res.json({ success: true })
    } catch (err) {
        return sendError(res, err, "public otp")
    }
})

/**
 * POST /public/:token   body: { fields, code, consentAccepted }
 * Le cocontractant soumet ses signatures avec le code reçu. L'enveloppe passe
 * en SIGNED ; le PDF figé, l'horodatage et les e-mails (PDF signé + dossier de
 * preuve aux deux parties) sont traités en arrière-plan.
 */
router.post("/public/:token", async (req: Request, res: Response) => {
    try {
        const { fields } = req.body as { fields?: EnvelopeFieldsPayload }
        if (!fields) return res.status(400).json({ success: false, message: "fields requis." })

        const dto = await svc.signByToken(
            req.params["token"] as string,
            fields,
            readConfirmation(req.body),
            getRequestContext(req),
        )
        return res.json({ success: true, data: dto })
    } catch (err) {
        return sendError(res, err, "public sign")
    }
})

/**
 * POST /public/:token/decline   body: { reason? }
 * Le cocontractant refuse de signer.
 */
router.post("/public/:token/decline", async (req: Request, res: Response) => {
    try {
        const { reason } = req.body as { reason?: string }
        await svc.declineByToken(req.params["token"] as string, reason, getRequestContext(req))
        return res.json({ success: true })
    } catch (err) {
        return sendError(res, err, "public decline")
    }
})

/**
 * GET /public/:token/download
 * Téléchargement du contrat signé par le cocontractant, depuis la page
 * publique de signature. Réservé aux enveloppes signées par les deux parties.
 */
router.get("/public/:token/download", async (req: Request, res: Response) => {
    try {
        const result = await svc.downloadSignedPdfByToken(req.params["token"] as string, getRequestContext(req))
        if (!result) {
            return res.status(404).json({ success: false, message: "Document introuvable." })
        }

        res.setHeader("Content-Type", "application/pdf")
        res.setHeader("Content-Disposition", `attachment; filename="${sanitizeFileName(result.documentName)}_signe.pdf"`)
        return res.send(result.buffer)
    } catch (err) {
        return sendError(res, err, "public download")
    }
})

/**
 * GET /download/:externalId
 * Contrat signé, téléchargé par l'émetteur : le PDF figé à la clôture, ou
 * reconstruit à la volée pour les enveloppes antérieures au journal.
 */
router.get("/download/:externalId", authMiddleware, async (req: Request, res: Response) => {
    try {
        const userId = Number(req.idUser)
        const result = await svc.downloadSignedPdfAsOwner(userId, req.params["externalId"] as string, getRequestContext(req))
        if (!result) {
            return res.status(404).json({ success: false, message: "Enveloppe introuvable ou document manquant." })
        }

        res.setHeader("Content-Type", "application/pdf")
        res.setHeader("Content-Disposition", `attachment; filename="${sanitizeFileName(result.documentName)}_signe.pdf"`)
        return res.send(result.buffer)
    } catch (err) {
        return sendError(res, err, "download")
    }
})

/**
 * POST /resend
 * Renvoie l'invitation au cocontractant et repousse l'expiration de 14 jours.
 */
router.post("/resend", authMiddleware, async (req: Request, res: Response) => {
    try {
        const userId = Number(req.idUser)
        const { externalId } = req.body as { externalId?: string }
        if (!externalId) {
            return res.status(400).json({ success: false, message: "externalId requis." })
        }

        await svc.resend(userId, externalId, getRequestContext(req))
        return res.json({ success: true })
    } catch (err) {
        return sendError(res, err, "resend")
    }
})
export default router
