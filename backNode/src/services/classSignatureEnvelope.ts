import crypto from "crypto"
import fs from "fs/promises"
import { PDFDocument, StandardFonts, rgb } from "pdf-lib"
import type { PDFFont, PDFImage, PDFPage } from "pdf-lib"
import { Prisma } from "@prisma/client"
import type { SignatureEnvelope } from "@prisma/client"
import { prisma } from "../../prisma/singletonPrisma.js"
import { hashToken, decryptBuffer } from "./encryption.js"
import { Mailer } from "../infrastructure/mailer/classMailer.js"
import { logger } from "../logger/logger.js"
import {
  SignatureLog,
  INVITATION_VALIDITY_DAYS,
  sha256Hex,
  type RequestContext,
} from "./classSignatureLog.js"
import { SignatureOtp, type OtpSigner } from "./classSignatureOtp.js"

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
  /** Vrai si le dossier de preuve existe (enveloppes signées avec le journal). */
  hasEvidence: boolean;
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
  finalDocumentHash: string | null;
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
    hasEvidence: row.finalDocumentHash !== null,
  };
}

/**
 * Erreur métier du parcours de signature : porte le code HTTP que la route
 * doit renvoyer, et éventuellement un code lisible par le front.
 */
export class SignatureFlowError extends Error {
  constructor(
    public readonly httpStatus: number,
    message: string,
    public readonly code?: string,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Ce que le signataire envoie pour valider sa signature. */
export type SigningConfirmation = {
  /** Code OTP reçu par e-mail. */
  code: string;
  /** Case « j'accepte de signer électroniquement » cochée. */
  consentAccepted: boolean;
};

type SignerRole = "self" | "counterparty";

const signatureLog = new SignatureLog();
const signatureOtp = new SignatureOtp();

/**
 * Service métier des enveloppes de signature.
 *
 * Parcours (voir documentation/signature_journal.md) :
 *   1. create            → enveloppe DRAFT, empreinte du PDF original
 *   2. requestSenderOtp  → code envoyé à l'émetteur
 *      signAsSender      → OTP vérifié, émetteur signé, invitation envoyée (SENT)
 *   3. openByToken       → le cocontractant ouvre le lien (expiration 14 jours)
 *   4. requestCounterpartyOtp / signByToken → OTP vérifié, cocontractant signé (SIGNED)
 *   5. finalize          → PDF figé + horodatage + e-mails avec dossier de preuve
 *
 * Chaque étape est inscrite au journal de preuve (classSignatureLog.ts).
 * Les champs (positions, signatures dataUrl) sont chiffrés automatiquement par
 * l'extension Prisma. Le PDF source est stocké sur disque par la route.
 */
export class SignatureEnvelopeService {
  /**
   * Liste les enveloppes de l'utilisateur, optionnellement filtrées par statut.
   * Les enveloppes archivées n'apparaissent que si on les demande explicitement.
   */
  async list(
    userId: number,
    status?: EnvelopeStatusValue,
  ): Promise<SignatureEnvelopeDTO[]> {
    const rows = await prisma.signatureEnvelope.findMany({
      where: { userId, status: status ?? { not: "ARCHIVED" } },
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

  // ─── 1. Création ───────────────────────────────────────────────────────────

  /**
   * Crée l'enveloppe en brouillon (DRAFT). Elle ne sera envoyée au
   * cocontractant qu'une fois l'émetteur identifié par OTP (signAsSender).
   */
  async create(
    userId: number,
    data: {
      documentName: string;
      documentFilePath: string;
      originalDocumentHash: string;
      numPages: number;
      fields: EnvelopeFieldsPayload;
      selfName: string;
      selfEmail: string;
      counterpartyName: string;
      counterpartyEmail: string;
    },
    context: RequestContext,
  ): Promise<SignatureEnvelopeDTO> {
    const signingToken = crypto.randomBytes(32).toString("hex");
    const row = await prisma.signatureEnvelope.create({
      data: {
        externalId: crypto.randomUUID(),
        // Empreinte pour retrouver l'enveloppe + copie chiffrée (par l'extension) pour renvoyer le lien
        signingTokenHash: hashToken(signingToken),
        signingToken,
        documentName: data.documentName,
        documentFilePath: data.documentFilePath,
        originalDocumentHash: data.originalDocumentHash,
        numPages: data.numPages,
        envelopeFields: data.fields as unknown as Prisma.InputJsonValue,
        status: "DRAFT",
        selfName: data.selfName,
        selfEmail: data.selfEmail,
        counterpartyName: data.counterpartyName,
        counterpartyEmail: data.counterpartyEmail,
        userId,
      },
    });

    await signatureLog.record(row.idEnvelope, {
      eventType: "ENVELOPE_CREATED",
      ...senderActor(row),
      context,
      details: {
        documentName: row.documentName,
        numPages: row.numPages,
        counterpartyName: row.counterpartyName,
        counterpartyEmail: row.counterpartyEmail,
      },
    });
    await signatureLog.record(row.idEnvelope, {
      eventType: "DOCUMENT_HASHED",
      actorRole: "SYSTEM",
      documentHash: data.originalDocumentHash,
    });

    return toDTO(row);
  }

  // ─── 2. Signature de l'émetteur ────────────────────────────────────────────

  /** Envoie le code OTP à l'émetteur (enveloppe encore en brouillon). */
  async requestSenderOtp(userId: number, externalId: string, context: RequestContext): Promise<void> {
    const row = await findOwnedEnvelope(userId, externalId);
    if (row.status !== "DRAFT") {
      throw new SignatureFlowError(409, "Vous avez déjà signé ce document.");
    }
    const sender = senderActor(row);
    await sendOtpOrThrow(row, { role: "SENDER", name: sender.actorName, email: sender.actorEmail }, context);
  }

  /**
   * L'émetteur valide sa signature avec le code reçu. Ses signatures (déjà
   * dessinées à la création) prennent effet, puis l'invitation part chez le
   * cocontractant.
   * Renvoie `invitationSent` pour que la route décompte le crédit.
   */
  async signAsSender(
    userId: number,
    externalId: string,
    confirmation: SigningConfirmation,
    context: RequestContext,
  ): Promise<{ envelope: SignatureEnvelopeDTO; invitationSent: boolean }> {
    const row = await findOwnedEnvelope(userId, externalId);
    if (row.status !== "DRAFT") {
      throw new SignatureFlowError(409, "Vous avez déjà signé ce document.");
    }
    assertConsent(confirmation);

    const fields = row.envelopeFields as unknown as EnvelopeFieldsPayload;
    const senderFields = fieldsOf(fields, "self");
    if (senderFields.length === 0 || senderFields.some((field) => !field["value"])) {
      throw new SignatureFlowError(400, "Toutes vos zones de signature doivent être remplies.");
    }

    const sender = senderActor(row);
    await verifyOtpOrThrow(row.idEnvelope, { role: "SENDER", name: sender.actorName, email: sender.actorEmail }, confirmation.code, context);
    await recordSignatureEvents(row.idEnvelope, sender, senderFields, context);

    const signed = await prisma.signatureEnvelope.update({
      where: { idEnvelope: row.idEnvelope },
      data: { selfSignedAt: new Date() },
    });
    const invitationSent = await this.sendInvitation(signed, context, false);

    const updated = await prisma.signatureEnvelope.findUniqueOrThrow({ where: { idEnvelope: row.idEnvelope } });
    return { envelope: toDTO(updated), invitationSent };
  }

  /**
   * Envoie (ou renvoie) l'invitation au cocontractant. Le lien est valable
   * 14 jours à partir de cet envoi.
   */
  private async sendInvitation(
    row: SignatureEnvelope,
    context: RequestContext,
    isReminder: boolean,
  ): Promise<boolean> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + INVITATION_VALIDITY_DAYS * 24 * 60 * 60_000);

    await prisma.signatureEnvelope.update({
      where: { idEnvelope: row.idEnvelope },
      data: { status: "SENT", sentAt: row.sentAt ?? now, expiresAt },
    });

    const frontUrl = process.env["HOST_FRONT"] ?? "http://localhost:5173";
    // `selfEmail`/`selfName` viennent du compte connecté : cette adresse est
    // mise en copie, affichée au cocontractant et utilisée comme adresse de réponse.
    const mail = await new Mailer(row.counterpartyEmail).sendSignatureInvite({
      counterpartyName: row.counterpartyName,
      documentName: row.documentName,
      signingLink: `${frontUrl}/signer/${row.signingToken}`,
      cc: row.selfEmail,
      senderName: row.selfName,
      senderEmail: row.selfEmail,
      ...(isReminder ? { isReminder: true } : {}),
    });

    await signatureLog.record(row.idEnvelope, {
      eventType: isReminder ? "INVITE_RESENT" : "INVITE_SENT",
      ...senderActor(row),
      context,
      details: {
        recipientEmail: row.counterpartyEmail,
        mailAccepted: mail.success,
        expiresAt: expiresAt.toISOString(),
      },
    });
    return mail.success;
  }

  /** Renvoie l'invitation (relance) et repousse l'expiration de 14 jours. */
  async resend(userId: number, externalId: string, context: RequestContext): Promise<void> {
    const row = await findOwnedEnvelope(userId, externalId);
    if (row.status !== "SENT" && row.status !== "EXPIRED") {
      throw new SignatureFlowError(409, "Cette invitation ne peut plus être renvoyée.");
    }
    await this.sendInvitation(row, context, true);
  }

  // ─── 3-4. Parcours du cocontractant (lien public) ──────────────────────────

  /**
   * Le cocontractant ouvre le lien de signature. Inscrit l'ouverture au
   * journal et passe l'enveloppe en EXPIRED si les 14 jours sont dépassés.
   */
  async openByToken(signingToken: string, context: RequestContext): Promise<{
    meta: SignatureEnvelopeDTO;
    fields: EnvelopeFieldsPayload;
    documentFilePath: string | null;
  }> {
    let row = await findEnvelopeByToken(signingToken);
    row = await expireIfOutdated(row);

    if (row.status === "SENT") {
      await signatureLog.record(row.idEnvelope, {
        eventType: "DOCUMENT_OPENED",
        ...counterpartyActor(row),
        context,
      });
    }

    const fields = row.envelopeFields as unknown as EnvelopeFieldsPayload;
    return { meta: toDTO(row), fields, documentFilePath: row.documentFilePath };
  }

  /** Envoie le code OTP au cocontractant. */
  async requestCounterpartyOtp(signingToken: string, context: RequestContext): Promise<void> {
    const row = await findSignableEnvelope(signingToken);
    const counterparty = counterpartyActor(row);
    await sendOtpOrThrow(
      row,
      { role: "COUNTERPARTY", name: counterparty.actorName, email: counterparty.actorEmail },
      context,
    );
  }

  /**
   * Le cocontractant valide ses signatures avec le code reçu. L'enveloppe
   * passe en SIGNED, puis la clôture (PDF figé, horodatage, e-mails) se fait
   * en arrière-plan pour répondre vite.
   *
   * Seules les valeurs des champs du cocontractant sont reprises de la
   * requête : il ne peut ni modifier la signature de l'émetteur, ni déplacer
   * les zones.
   */
  async signByToken(
    signingToken: string,
    submittedFields: EnvelopeFieldsPayload,
    confirmation: SigningConfirmation,
    context: RequestContext,
  ): Promise<SignatureEnvelopeDTO> {
    const row = await findSignableEnvelope(signingToken);
    assertConsent(confirmation);

    const storedFields = row.envelopeFields as unknown as EnvelopeFieldsPayload;
    const mergedFields = mergeCounterpartyValues(storedFields, submittedFields);
    const counterpartyFields = fieldsOf(mergedFields, "counterparty");
    if (counterpartyFields.some((field) => !field["value"])) {
      throw new SignatureFlowError(400, "Toutes vos zones de signature doivent être remplies.");
    }

    const counterparty = counterpartyActor(row);
    await verifyOtpOrThrow(
      row.idEnvelope,
      { role: "COUNTERPARTY", name: counterparty.actorName, email: counterparty.actorEmail },
      confirmation.code,
      context,
    );

    // `status: "SENT"` dans le where : si deux envois arrivent en même temps,
    // un seul passe (l'autre ne trouve plus d'enveloppe à l'état SENT).
    const now = new Date();
    const { count } = await prisma.signatureEnvelope.updateMany({
      where: { idEnvelope: row.idEnvelope, status: "SENT" },
      data: {
        envelopeFields: mergedFields as unknown as Prisma.InputJsonValue,
        status: "SIGNED",
        counterpartySignedAt: now,
        completedAt: now,
      },
    });
    if (count === 0) {
      throw new SignatureFlowError(409, "Ce document a déjà été signé.");
    }
    await recordSignatureEvents(row.idEnvelope, counterparty, counterpartyFields, context);

    this.finalize(row.idEnvelope).catch((err: unknown) => {
      logger.error("[signature] Échec de la clôture de l'enveloppe", err);
    });

    const updated = await prisma.signatureEnvelope.findUniqueOrThrow({ where: { idEnvelope: row.idEnvelope } });
    return toDTO(updated);
  }

  /** Le cocontractant refuse de signer. */
  async declineByToken(signingToken: string, reason: string | undefined, context: RequestContext): Promise<void> {
    const row = await findSignableEnvelope(signingToken);
    await prisma.signatureEnvelope.update({
      where: { idEnvelope: row.idEnvelope },
      data: { status: "DECLINED" },
    });
    await signatureLog.record(row.idEnvelope, {
      eventType: "DECLINED",
      ...counterpartyActor(row),
      context,
      details: { reason: reason?.trim().slice(0, 1000) || null },
    });
  }

  // ─── 5. Clôture ────────────────────────────────────────────────────────────

  /**
   * Les deux parties ont signé : on fige le PDF signé, on le fait horodater,
   * puis on envoie à chacun le PDF signé + le dossier de preuve.
   */
  private async finalize(idEnvelope: number): Promise<void> {
    await signatureLog.record(idEnvelope, { eventType: "ENVELOPE_COMPLETED", actorRole: "SYSTEM" });

    const row = await prisma.signatureEnvelope.findUniqueOrThrow({ where: { idEnvelope } });
    const signedPdf = await this.buildSignedPdf(
      row.documentName,
      row.documentFilePath,
      row.envelopeFields as unknown as EnvelopeFieldsPayload,
    );
    if (!signedPdf) {
      logger.error("[signature] PDF source introuvable, clôture impossible", { idEnvelope });
      return;
    }

    await signatureLog.sealSignedDocument(idEnvelope, signedPdf.buffer);
    const evidence = await signatureLog.buildEvidencePackage(idEnvelope);

    const baseName = sanitizeFileName(row.documentName);
    const selfLabel = row.selfName || row.selfEmail;
    const common = {
      documentName: row.documentName,
      selfLabel,
      selfEmail: row.selfEmail,
      counterpartyName: row.counterpartyName,
      counterpartyEmail: row.counterpartyEmail,
      signedDate: row.completedAt ?? new Date(),
      pdf: { filename: `${baseName}_signe.pdf`, content: signedPdf.buffer },
      evidence: { filename: `${baseName}_dossier_de_preuve.zip`, content: evidence.buffer },
    };

    await Promise.all([
      new Mailer(row.selfEmail).sendSignatureCompletion({ recipientName: selfLabel, ...common }),
      new Mailer(row.counterpartyEmail).sendSignatureCompletion({ recipientName: row.counterpartyName, ...common }),
    ]);
  }

  // ─── Téléchargements ───────────────────────────────────────────────────────

  /** PDF signé, téléchargé par l'émetteur depuis son dashboard. */
  async downloadSignedPdfAsOwner(
    userId: number,
    externalId: string,
    context: RequestContext,
  ): Promise<{ documentName: string; buffer: Buffer } | null> {
    const row = await prisma.signatureEnvelope.findFirst({ where: { userId, externalId } });
    if (!row) return null;
    return this.getSignedDocument(row, senderActor(row), context);
  }

  /** PDF signé, téléchargé par le cocontractant depuis la page publique. */
  async downloadSignedPdfByToken(
    signingToken: string,
    context: RequestContext,
  ): Promise<{ documentName: string; buffer: Buffer } | null> {
    const row = await findEnvelopeByToken(signingToken);
    if (row.status !== "SIGNED") {
      throw new SignatureFlowError(409, "Ce document n'est pas encore signé par les deux parties.");
    }
    return this.getSignedDocument(row, counterpartyActor(row), context);
  }

  /**
   * Renvoie le PDF signé figé s'il existe. Les enveloppes signées avant la mise
   * en place du journal n'en ont pas : on reconstruit alors le PDF à la volée.
   */
  private async getSignedDocument(
    row: SignatureEnvelope,
    actor: EventActor,
    context: RequestContext,
  ): Promise<{ documentName: string; buffer: Buffer } | null> {
    const frozenPdf = await signatureLog.readFinalDocument(row.idEnvelope);
    if (!frozenPdf) {
      return this.buildSignedPdf(
        row.documentName,
        row.documentFilePath,
        row.envelopeFields as unknown as EnvelopeFieldsPayload,
      );
    }

    await signatureLog.record(row.idEnvelope, {
      eventType: "SIGNED_DOCUMENT_DOWNLOADED",
      ...actor,
      context,
      documentHash: row.finalDocumentHash,
    });
    return { documentName: row.documentName, buffer: frozenPdf };
  }

  /** Dossier de preuve (ZIP), re-téléchargeable par l'émetteur. */
  async exportEvidence(
    userId: number,
    externalId: string,
    context: RequestContext,
  ): Promise<{ fileName: string; buffer: Buffer }> {
    const row = await findOwnedEnvelope(userId, externalId);
    if (!row.finalDocumentHash) {
      throw new SignatureFlowError(
        409,
        "Le dossier de preuve n'est disponible que pour les documents signés par les deux parties avec le journal de signature.",
      );
    }

    const evidence = await signatureLog.buildEvidencePackage(row.idEnvelope);
    await signatureLog.record(row.idEnvelope, {
      eventType: "EVIDENCE_EXPORTED",
      ...senderActor(row),
      context,
    });
    return { fileName: `${sanitizeFileName(row.documentName)}_dossier_de_preuve.zip`, buffer: evidence.buffer };
  }

  /** Lit le PDF source sur disque et y incruste les signatures. */
  private async buildSignedPdf(
    documentName: string,
    documentFilePath: string | null,
    fields: EnvelopeFieldsPayload,
  ): Promise<{ documentName: string; buffer: Buffer } | null> {
    if (!documentFilePath) return null;
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

  // ─── Archivage ─────────────────────────────────────────────────────────────

  /**
   * Archive une enveloppe (remplace l'ancienne suppression définitive) :
   * la preuve doit être conservée au moins 5 ans.
   */
  async archive(userId: number, externalId: string, context: RequestContext): Promise<void> {
    const row = await findOwnedEnvelope(userId, externalId);
    if (row.status === "ARCHIVED") return;

    await prisma.signatureEnvelope.update({
      where: { idEnvelope: row.idEnvelope },
      data: { status: "ARCHIVED", archivedAt: new Date() },
    });
    await signatureLog.record(row.idEnvelope, {
      eventType: "ENVELOPE_ARCHIVED",
      ...senderActor(row),
      context,
      details: { previousStatus: row.status },
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
        where: { userId, status: { not: "ARCHIVED" } },
        select: { status: true },
      }),
      prisma.signatureEnvelope.findMany({
        where: { userId, status: { not: "ARCHIVED" } },
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

// ─── Fonctions utilitaires du parcours ─────────────────────────────────────────

/** Acteur d'un événement du journal (rôle + identité). */
type EventActor = {
  actorRole: "SENDER" | "COUNTERPARTY";
  actorName: string;
  actorEmail: string;
};

function senderActor(row: SignatureEnvelope): EventActor {
  return { actorRole: "SENDER", actorName: row.selfName || row.selfEmail, actorEmail: row.selfEmail };
}

function counterpartyActor(row: SignatureEnvelope): EventActor {
  return { actorRole: "COUNTERPARTY", actorName: row.counterpartyName, actorEmail: row.counterpartyEmail };
}

/** Enveloppe appartenant à l'utilisateur connecté, sinon 404. */
async function findOwnedEnvelope(userId: number, externalId: string): Promise<SignatureEnvelope> {
  const row = await prisma.signatureEnvelope.findFirst({ where: { userId, externalId } });
  if (!row) throw new SignatureFlowError(404, "Enveloppe introuvable.");
  return row;
}

/** Enveloppe retrouvée par le token du lien public, sinon 404. */
async function findEnvelopeByToken(signingToken: string): Promise<SignatureEnvelope> {
  const row = await prisma.signatureEnvelope.findUnique({
    where: { signingTokenHash: hashToken(signingToken) },
  });
  if (!row) throw new SignatureFlowError(404, "Lien invalide ou expiré.");
  return row;
}

/** Enveloppe que le cocontractant peut encore signer (envoyée, non expirée). */
async function findSignableEnvelope(signingToken: string): Promise<SignatureEnvelope> {
  const row = await expireIfOutdated(await findEnvelopeByToken(signingToken));
  if (row.status === "EXPIRED") {
    throw new SignatureFlowError(410, "Ce lien de signature a expiré. Demandez un nouvel envoi à l'émetteur.", "EXPIRED");
  }
  if (row.status !== "SENT") {
    throw new SignatureFlowError(409, "Ce document ne peut plus être signé.");
  }
  return row;
}

/** Passe l'enveloppe en EXPIRED si l'invitation a dépassé ses 14 jours. */
async function expireIfOutdated(row: SignatureEnvelope): Promise<SignatureEnvelope> {
  const isOutdated = row.status === "SENT" && row.expiresAt !== null && row.expiresAt <= new Date();
  if (!isOutdated) return row;

  const expired = await prisma.signatureEnvelope.update({
    where: { idEnvelope: row.idEnvelope },
    data: { status: "EXPIRED" },
  });
  await signatureLog.record(row.idEnvelope, {
    eventType: "EXPIRED",
    actorRole: "SYSTEM",
    details: { expiresAt: row.expiresAt?.toISOString() },
  });
  return expired;
}

function assertConsent(confirmation: SigningConfirmation): void {
  if (!confirmation.consentAccepted) {
    throw new SignatureFlowError(400, "Vous devez accepter de signer électroniquement.", "CONSENT_REQUIRED");
  }
  if (!confirmation.code) {
    throw new SignatureFlowError(400, "Le code de vérification est requis.", "OTP_REQUIRED");
  }
}

/** Champs appartenant à un signataire ("self" = émetteur). */
function fieldsOf(payload: EnvelopeFieldsPayload, signer: SignerRole): Array<Record<string, unknown>> {
  return (payload.fields ?? []).filter((field) => field["signer"] === signer);
}

/**
 * Repart des champs enregistrés et n'y copie que la signature (`value`) et sa
 * date (`signedAt`) des champs du cocontractant envoyés par le navigateur.
 */
function mergeCounterpartyValues(
  stored: EnvelopeFieldsPayload,
  submitted: EnvelopeFieldsPayload,
): EnvelopeFieldsPayload {
  const submittedById = new Map((submitted.fields ?? []).map((field) => [field["id"], field]));

  const fields = (stored.fields ?? []).map((field) => {
    if (field["signer"] !== "counterparty") return field;
    const submittedField = submittedById.get(field["id"]);
    if (!submittedField) return field;
    return { ...field, value: submittedField["value"], signedAt: submittedField["signedAt"] };
  });
  return { ...stored, fields };
}

/**
 * Inscrit au journal la signature d'une partie : consentement, chaque zone
 * signée, puis la fin de sa signature.
 */
async function recordSignatureEvents(
  idEnvelope: number,
  actor: EventActor,
  signedFields: Array<Record<string, unknown>>,
  context: RequestContext,
): Promise<void> {
  await signatureLog.record(idEnvelope, { eventType: "CONSENT_ACCEPTED", ...actor, context });

  for (const field of signedFields) {
    await signatureLog.record(idEnvelope, {
      eventType: "SIGNATURE_APPLIED",
      ...actor,
      context,
      details: {
        fieldId: field["id"],
        fieldType: field["type"],
        page: Number(field["page"]) + 1, // numéro de page lisible (1, 2, 3…)
        signatureImageHash: sha256Hex(String(field["value"])),
      },
    });
  }

  await signatureLog.record(idEnvelope, {
    eventType: "SIGNER_COMPLETED",
    ...actor,
    context,
    details: { signedFieldCount: signedFields.length },
  });
}

async function sendOtpOrThrow(row: SignatureEnvelope, signer: OtpSigner, context: RequestContext): Promise<void> {
  const result = await signatureOtp.send(row, signer, context);
  if (result.success) return;

  if (result.reason === "TOO_SOON") {
    throw new SignatureFlowError(429, `Patientez ${result.retryAfterSeconds} secondes avant de demander un nouveau code.`, result.reason, {
      retryAfterSeconds: result.retryAfterSeconds,
    });
  }
  if (result.reason === "TOO_MANY_SENDS") {
    throw new SignatureFlowError(429, "Trop de codes demandés. Réessayez dans une heure.", result.reason);
  }
  throw new SignatureFlowError(502, "L'e-mail contenant le code n'a pas pu être envoyé.", result.reason);
}

async function verifyOtpOrThrow(
  idEnvelope: number,
  signer: OtpSigner,
  code: string,
  context: RequestContext,
): Promise<void> {
  const result = await signatureOtp.verify(idEnvelope, signer, code, context);
  if (result.success) return;

  const messages = {
    NO_CODE: "Aucun code en cours : demandez un nouveau code.",
    EXPIRED: "Ce code a expiré : demandez un nouveau code.",
    TOO_MANY_ATTEMPTS: "Trop d'essais : demandez un nouveau code.",
    WRONG_CODE: "Code incorrect.",
  };
  throw new SignatureFlowError(400, messages[result.reason], `OTP_${result.reason}`, {
    attemptsLeft: result.attemptsLeft,
  });
}

/**
 * Nom de fichier propre pour une pièce jointe ou un téléchargement : on retire
 * l'extension .pdf et les caractères gênants pour un en-tête HTTP / un client
 * mail.
 */
export function sanitizeFileName(documentName: string): string {
  return documentName.replace(/\.pdf$/i, "").replace(/[^\w.\- ]+/g, "_").trim() || "document";
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
