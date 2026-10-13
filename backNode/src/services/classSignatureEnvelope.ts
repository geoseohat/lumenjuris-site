import crypto from "crypto"
import fs from "fs/promises"
import { PDFDocument, StandardFonts, rgb } from "pdf-lib"
import type { PDFFont, PDFImage, PDFPage } from "pdf-lib"
import { Prisma } from "@prisma/client"
import { prisma } from "../../prisma/singletonPrisma.js"
import { hashToken, decryptBuffer } from "./encryption.js"

/**
 * Statuts possibles d'une enveloppe de signature (miroir du enum Prisma).
 */
export type EnvelopeStatusValue =
  | "DRAFT"
  | "SENT"
  | "PARTIALLY_SIGNED"
  | "SIGNED"
  | "DECLINED"
  | "EXPIRED"
  | "ARCHIVED";

/**
 * Données des champs (positions, signatures capturées) stockées chiffrées
 * dans `envelopeFields`. La structure reflète l'état du wizard frontend.
 */
export interface EnvelopeFieldsPayload {
  fields: Array<Record<string, unknown>>;
  // Réservé pour un futur usage (ex. signatures capturées séparées des champs)
  extra?: Record<string, unknown>;
}

/**
 * Un champ de signature tel que produit par le wizard frontend (voir
 * `front/.../signature/types.ts`). Les coordonnées sont exprimées en fraction
 * de la page (0..1), l'origine étant le coin HAUT-gauche (repère écran).
 */
interface SignatureFieldData {
    /** "signature" (datée) ou "initial" (paraphe, jamais daté). */
    type?: string
    /** Index de page 0-based. */
    page: number
    xPct: number
    yPct: number
    widthPct: number
    heightPct: number
    /** dataUrl PNG/JPEG de la signature apposée (absent tant que non signé). */
    value?: string
    /** Date de signature ISO — affichée en petit sous la signature. */
    signedAt?: string
    /** Si vrai, la signature est répliquée à la même position sur toutes les pages. */
    replicateAllPages?: boolean
}

/** DTO exposé à l'API (sans la charge chiffrée des champs). */
export interface SignatureEnvelopeDTO {
  id: string;
  signingToken: string;
  documentName: string;
  numPages: number;
  status: EnvelopeStatusValue;
  selfName: string;
  selfEmail: string;
  counterpartyName: string;
  counterpartyEmail: string;
  sentAt: string | null;
  selfSignedAt: string | null;
  counterpartySignedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SignatureEnvelopeNoTokenDTO {
  id: string;
  documentName: string;
  numPages: number;
  status: EnvelopeStatusValue;
  selfName: string;
  selfEmail: string;
  counterpartyName: string;
  counterpartyEmail: string;
  sentAt: string | null;
  selfSignedAt: string | null;
  counterpartySignedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Agrégats pour le tableau de bord. */
export interface SignatureDashboardStats {
  total: number;
  draft: number;
  sent: number;
  partiallySigned: number;
  signed: number;
  other: number;
  recent: SignatureEnvelopeDTO[];
}

/**
 * Convertit une ligne Prisma en DTO sérialisable (dates en ISO).
 */
function toDTO(row: {
  externalId: string;
  signingToken: string;
  documentName: string;
  numPages: number;
  status: EnvelopeStatusValue;
  selfName: string;
  selfEmail: string;
  counterpartyName: string;
  counterpartyEmail: string;
  sentAt: Date | null;
  selfSignedAt: Date | null;
  counterpartySignedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): SignatureEnvelopeDTO {
  return {
    id: row.externalId,
    signingToken: row.signingToken,
    documentName: row.documentName,
    numPages: row.numPages,
    status: row.status,
    selfName: row.selfName,
    selfEmail: row.selfEmail,
    counterpartyName: row.counterpartyName,
    counterpartyEmail: row.counterpartyEmail,
    sentAt: row.sentAt?.toISOString() ?? null,
    selfSignedAt: row.selfSignedAt?.toISOString() ?? null,
    counterpartySignedAt: row.counterpartySignedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Service métier des enveloppes de signature :
 *   - création d'une enveloppe au moment du "Envoyer au cocontractant"
 *   - lecture (liste filtrée par statut + détail)
 *   - statistiques agrégées pour le dashboard
 *   - suppression
 *
 * Les champs (positions, signatures dataUrl) sont chiffrés AES-256-GCM
 * automatiquement par l'extension Prisma (prisma/encryptionExtension.ts).
 * Le fichier PDF lui-même est stocké sur le filesystem par la route (voir
 * `apiSignature.ts`), seul son chemin est référencé ici.
 */
export class SignatureEnvelopeService {
  /**
   * Liste les enveloppes de l'utilisateur, optionnellement filtrées par statut.
   * Triées par date de mise à jour (plus récent d'abord).
   */
  async list(
    userId: number,
    status?: EnvelopeStatusValue,
  ): Promise<SignatureEnvelopeDTO[]> {
    const rows = await prisma.signatureEnvelope.findMany({
      where: { userId, ...(status ? { status } : {}) },
      orderBy: { updatedAt: "desc" },
      take: 100,
      omit: { envelopeFields: true }, // inutile pour la liste : évite de déchiffrer les signatures
    });
    return rows.map(toDTO);
  }

  /**
   * Détail d'une enveloppe, incluant la charge déchiffrée des champs.
   */
  async get(
    userId: number,
    externalId: string,
  ): Promise<{
    meta: SignatureEnvelopeDTO;
    fields: EnvelopeFieldsPayload;
    documentFilePath: string | null;
  } | null> {
    const row = await prisma.signatureEnvelope.findFirst({
      where: { userId, externalId },
    });
    if (!row) return null;
    const fields = row.envelopeFields as unknown as EnvelopeFieldsPayload;
    return { meta: toDTO(row), fields, documentFilePath: row.documentFilePath };
  }

  /**
   * Crée une nouvelle enveloppe.
   * Statut initial : `SENT` (l'utilisateur a explicitement cliqué "Envoyer").
   * Si tous ses propres champs sont signés, `selfSignedAt` est positionné.
   */
  async create(
    userId: number,
    data: {
      documentName: string;
      documentFilePath?: string | null;
      numPages: number;
      fields: EnvelopeFieldsPayload;
      selfName: string;
      selfEmail: string;
      counterpartyName: string;
      counterpartyEmail: string;
      /** Marque comme déjà signé côté émetteur (au moins partiellement). */
      selfSigned: boolean;
    },
  ): Promise<SignatureEnvelopeDTO> {
    const now = new Date();
    const signingToken = crypto.randomBytes(32).toString("hex");
    const row = await prisma.signatureEnvelope.create({
      data: {
        externalId: crypto.randomUUID(),
        // Empreinte pour retrouver l'enveloppe + copie chiffrée (par l'extension) pour renvoyer le lien
        signingTokenHash: hashToken(signingToken),
        signingToken,
        documentName: data.documentName,
        documentFilePath: data.documentFilePath ?? null,
        numPages: data.numPages,
        envelopeFields: data.fields as unknown as Prisma.InputJsonValue,
        status: "SENT",
        selfName: data.selfName,
        selfEmail: data.selfEmail,
        counterpartyName: data.counterpartyName,
        counterpartyEmail: data.counterpartyEmail,
        sentAt: now,
        selfSignedAt: data.selfSigned ? now : null,
        userId,
      },
    });
    return toDTO(row);
  }

  /**
   * Récupère une enveloppe par son token public (sans authentification).
   * Utilisé par la page de signature du cocontractant.
   */
  async getByToken(signingToken: string): Promise<{
    meta: SignatureEnvelopeDTO;
    fields: EnvelopeFieldsPayload;
    documentFilePath: string | null;
  } | null> {
    const row = await prisma.signatureEnvelope.findUnique({
      where: { signingTokenHash: hashToken(signingToken) },
    });
    if (!row) return null;
    const fields = row.envelopeFields as unknown as EnvelopeFieldsPayload;
    return { meta: toDTO(row), fields, documentFilePath: row.documentFilePath };
  }

  /**
   * Enregistre les signatures du cocontractant et passe le statut à SIGNED.
   */
  async signByToken(
    signingToken: string,
    signedFields: EnvelopeFieldsPayload,
  ): Promise<SignatureEnvelopeDTO | null> {
    const row = await prisma.signatureEnvelope.findUnique({
      where: { signingTokenHash: hashToken(signingToken) },
    });
    if (!row) return null;

    if (row.status === "SIGNED" || row.completedAt !== null) {
      throw new Error("Enveloppe déjà signée et ne peut plus être modifiée.");
    }

    const now = new Date();
    const updated = await prisma.signatureEnvelope.update({
      where: { signingTokenHash: hashToken(signingToken) },
      data: {
        envelopeFields: signedFields as unknown as Prisma.InputJsonValue,
        status: "SIGNED",
        counterpartySignedAt: now,
        completedAt: now,
      },
    });
    return toDTO(updated);
  }

  /**
   * Génère à la volée le PDF « aplati » (PDF source + signatures incrustées)
   * d'une enveloppe appartenant à l'utilisateur.
   *
   * Renvoie `null` si l'enveloppe n'existe pas, si aucun fichier PDF n'est
   * référencé, ou si le fichier est introuvable sur le disque — la route
   * répond alors 404. Les signatures ne sont jamais stockées fusionnées :
   * le PDF est reconstruit à chaque téléchargement.
   */
  async generateSignedPdf(
    userId: number,
    externalId: string,
  ): Promise<{ documentName: string; buffer: Buffer } | null> {
    const envelope = await this.get(userId, externalId);
    if (!envelope || !envelope.documentFilePath) return null;
    return this.buildSignedPdf(
      envelope.meta.documentName,
      envelope.documentFilePath,
      envelope.fields,
    );
  }

  /**
   * Même génération, mais depuis le token public de signature : utilisée pour
   * la pièce jointe de l'e-mail de confirmation, envoyé juste après la
   * signature du cocontractant (aucun utilisateur authentifié à ce moment-là).
   */
  async generateSignedPdfByToken(
    signingToken: string,
  ): Promise<{ documentName: string; buffer: Buffer } | null> {
    const envelope = await this.getByToken(signingToken);
    if (!envelope || !envelope.documentFilePath) return null;
    return this.buildSignedPdf(
      envelope.meta.documentName,
      envelope.documentFilePath,
      envelope.fields,
    );
  }

  /** Lit le PDF source sur disque et y incruste les signatures. */
  private async buildSignedPdf(
    documentName: string,
    documentFilePath: string,
    fields: EnvelopeFieldsPayload,
  ): Promise<{ documentName: string; buffer: Buffer } | null> {
    let pdfBytes: Buffer;
    try {
      pdfBytes = decryptBuffer(await fs.readFile(documentFilePath));
    } catch (err) {
      console.warn("[signature] PDF source introuvable:", documentFilePath, err);
      return null;
    }

    const buffer = await flattenSignaturesIntoPdf(pdfBytes, fields);
    return { documentName, buffer };
  }

  /** Supprime définitivement une enveloppe. */
  async delete(userId: number, externalId: string): Promise<void> {
    await prisma.signatureEnvelope.deleteMany({
      where: { userId, externalId },
    });
  }

  /**
   * Statistiques agrégées pour la vue tableau de bord :
   *   - compteurs par statut
   *   - 5 enveloppes les plus récentes
   */
  async stats(userId: number): Promise<SignatureDashboardStats> {
    const [all, recentRows] = await Promise.all([
      prisma.signatureEnvelope.findMany({
        where: { userId },
        select: { status: true },
      }),
      prisma.signatureEnvelope.findMany({
        where: { userId },
        orderBy: { updatedAt: "desc" },
        take: 5,
        omit: { envelopeFields: true }, // inutile ici : évite de déchiffrer les signatures
      }),
    ]);
    const stats: SignatureDashboardStats = {
      total: all.length,
      draft: 0,
      sent: 0,
      partiallySigned: 0,
      signed: 0,
      other: 0,
      recent: recentRows.map(toDTO),
    };
    for (const row of all) {
      switch (row.status) {
        case "DRAFT":
          stats.draft++;
          break;
        case "SENT":
          stats.sent++;
          break;
        case "PARTIALLY_SIGNED":
          stats.partiallySigned++;
          break;
        case "SIGNED":
          stats.signed++;
          break;
        default:
          stats.other++;
          break;
      }
    }
    return stats;
  }
}

// ─── Fusion des signatures dans le PDF (aplatissement) ─────────────────────────

/**
 * Incruste chaque signature (`field.value`) dans le PDF source aux coordonnées
 * enregistrées, puis renvoie le PDF résultant.
 *
 * Conversion de repère : le front stocke `yPct` depuis le HAUT de la page,
 * pdf-lib place les éléments depuis le BAS. L'image est ajustée à la boîte en
 * `contain` (préserve le ratio) et, si `signedAt` est présent, la date est
 * écrite en petit sous la signature — comme dans l'aperçu front.
 */
async function flattenSignaturesIntoPdf(
    pdfBytes: Buffer,
    payload: EnvelopeFieldsPayload,
): Promise<Buffer> {
    const pdfDoc = await PDFDocument.load(pdfBytes)
    const pages = pdfDoc.getPages()
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica)

    // Une même signature (dataUrl identique) n'est embarquée qu'une seule fois.
    const imageCache = new Map<string, PDFImage | null>()

    for (const raw of payload.fields ?? []) {
        const field = raw as unknown as SignatureFieldData
        if (!field.value) continue // champ non signé → rien à incruster

        let img = imageCache.get(field.value)
        if (img === undefined) {
            img = await embedDataUrl(pdfDoc, field.value)
            imageCache.set(field.value, img)
        }
        if (!img) continue // dataUrl illisible → on ignore ce champ

        const targetPages = field.replicateAllPages
            ? pages.map((_, i) => i)
            : [field.page]

        for (const pageIndex of targetPages) {
            const page = pages[pageIndex]
            if (!page) continue
            drawSignatureOnPage(page, img, font, field)
        }
    }

    const out = await pdfDoc.save()
    return Buffer.from(out)
}

/**
 * Décode un dataUrl (`data:image/png;base64,...`) et l'embarque dans le
 * document. Supporte PNG et JPEG ; renvoie `null` si le format est illisible.
 */
async function embedDataUrl(pdfDoc: PDFDocument, dataUrl: string): Promise<PDFImage | null> {
    const match = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/s.exec(dataUrl)
    if (!match) return null
    const mime = match[1] as string
    const bytes = Buffer.from(match[2] as string, "base64")
    try {
        if (mime === "image/jpeg" || mime === "image/jpg") return await pdfDoc.embedJpg(bytes)
        return await pdfDoc.embedPng(bytes)
    } catch (err) {
        console.warn("[signature] image de signature illisible:", err)
        return null
    }
}

/**
 * Dessine une signature (image + éventuelle date) dans sa boîte sur une page.
 */
function drawSignatureOnPage(
    page: PDFPage,
    img: PDFImage,
    font: PDFFont,
    field: SignatureFieldData,
): void {
    const pw = page.getWidth()
    const ph = page.getHeight()

    const boxW = field.widthPct * pw
    const boxH = field.heightPct * ph
    const boxLeft = field.xPct * pw
    // yPct part du haut → on convertit vers le bas (origine pdf-lib).
    const boxBottom = ph - field.yPct * ph - boxH

    // Réserve un bandeau bas pour la date (comme l'aperçu front).
    // Un paraphe n'est jamais daté, même si une date lui était associée.
    const hasDate = field.type !== "initial"
        && typeof field.signedAt === "string" && field.signedAt.length > 0
    const dateFontSize = Math.max(5, Math.min(7, boxH * 0.18))
    const dateStripH = hasDate ? dateFontSize + 2 : 0

    // Zone image = boîte moins le bandeau date, avec un léger padding.
    const pad = Math.min(2, boxH * 0.05)
    const areaW = boxW - pad * 2
    const areaH = boxH - dateStripH - pad * 2
    const areaBottom = boxBottom + dateStripH + pad

    // Ajustement "contain" : on préserve le ratio natif de la signature.
    const scale = Math.min(areaW / img.width, areaH / img.height)
    const drawW = img.width * scale
    const drawH = img.height * scale
    const imgX = boxLeft + pad + (areaW - drawW) / 2
    const imgY = areaBottom + (areaH - drawH) / 2

    page.drawImage(img, { x: imgX, y: imgY, width: drawW, height: drawH })

    if (hasDate) {
        const text = `Signé le ${formatSignedDate(field.signedAt)}`
        const textW = font.widthOfTextAtSize(text, dateFontSize)
        page.drawText(text, {
            x: boxLeft + Math.max(0, (boxW - textW) / 2),
            y: boxBottom + 1,
            size: dateFontSize,
            font,
            color: rgb(0.42, 0.45, 0.5),
        })
    }
}

/** Formate une date ISO en "JJ/MM/AAAA" (miroir de `formatSignedDate` du front). */
function formatSignedDate(iso?: string): string {
    if (!iso) return ""
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ""
    const dd = String(d.getDate()).padStart(2, "0")
    const mm = String(d.getMonth() + 1).padStart(2, "0")
    return `${dd}/${mm}/${d.getFullYear()}`
}
