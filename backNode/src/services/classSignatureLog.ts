/**
 * Journal de preuve des signatures électroniques.
 *
 * Rôles de cette classe :
 *   1. Ajouter des événements au journal, chaînés entre eux par leur hash.
 *   2. Vérifier que la chaîne n'a pas été altérée.
 *   3. Figer le PDF signé final (stockage + empreinte) et le faire horodater par la TSA.
 *   4. Construire le dossier de preuve (ZIP) remis aux deux parties.
 *
 * Le code à usage unique (OTP) est géré à part, dans classSignatureOtp.ts.
 * Documentation complète : documentation/signature_journal.md
 */
import crypto from "crypto"
import fs from "fs/promises"
import path from "path"
import type { Request } from "express"
import { ZipArchive } from "archiver"
import { Prisma } from "@prisma/client"
import type { SignatureActorRole, SignatureEventType } from "@prisma/client"
import { prisma } from "../../prisma/singletonPrisma.js"
import { encryptBuffer, decryptBuffer } from "./encryption.js"
import { requestTimestamp } from "../infrastructure/timestamp/tsaClient.js"
import { generateSignatureCertificatePDF } from "../infrastructure/pdf/signatureCertificatePDF.js"
import { logger } from "../logger/logger.js"

/** Durée de validité d'une invitation à signer. */
export const INVITATION_VALIDITY_DAYS = 14

/** Dossier de stockage des PDF signés figés (à la racine de backNode). */
const CONTRACT_SIGNATURE_DIR = path.join(process.cwd(), "contractSignature")

/** Nombre de tentatives d'écriture si deux événements arrivent au même moment. */
const MAX_RECORD_ATTEMPTS = 3

// ─── Types ───────────────────────────────────────────────────────────────────

/** Contexte technique d'une action (récupéré depuis la requête HTTP). */
export type RequestContext = {
  ipAddress: string | null
  userAgent: string | null
}

/** Données d'un événement à ajouter au journal. */
export type NewSignatureEvent = {
  eventType: SignatureEventType
  actorRole: SignatureActorRole
  actorName?: string | null
  actorEmail?: string | null
  context?: RequestContext
  details?: Record<string, unknown> | null
  documentHash?: string | null
}

/** Événement tel qu'il est lu depuis la base (champs déjà déchiffrés). */
export type SignatureEventRecord = {
  externalId: string
  sequence: number
  eventType: SignatureEventType
  actorRole: SignatureActorRole
  actorName: string | null
  actorEmail: string | null
  ipAddress: string | null
  userAgent: string | null
  details: Record<string, unknown> | null
  occurredAt: Date
  documentHash: string | null
  previousHash: string | null
  eventHash: string
}

/** Résultat de la vérification de la chaîne. */
export type ChainVerification = {
  isValid: boolean
  eventCount: number
  /** Numéro du premier événement dont le hash ne correspond pas (null si tout est bon). */
  brokenAtSequence: number | null
}

// ─── Fonctions utilitaires ───────────────────────────────────────────────────

/** Empreinte SHA-256 (hexadécimal) d'un fichier ou d'un texte. */
export function sha256Hex(content: Buffer | string): string {
  return crypto.createHash("sha256").update(content).digest("hex")
}

/**
 * Récupère l'IP et l'appareil du visiteur.
 * `req.ip` donne la vraie IP grâce à `app.set("trust proxy", 1)` (index.ts) :
 * le proxy transmet l'IP du visiteur dans `x-forwarded-for`, et son
 * `user-agent` d'origine.
 */
export function getRequestContext(req: Request): RequestContext {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.headers["user-agent"] ?? null,
  }
}

/**
 * Calcule le hash d'un événement.
 * L'ordre des valeurs est fixe : le modifier rendrait invalides tous les
 * journaux existants. Le hash est calculé sur les valeurs EN CLAIR.
 */
export function computeEventHash(event: Omit<SignatureEventRecord, "externalId" | "eventHash">): string {
  const orderedValues = [
    event.previousHash,
    event.sequence,
    event.eventType,
    event.actorRole,
    event.actorName,
    event.actorEmail,
    event.ipAddress,
    event.userAgent,
    event.details,
    event.occurredAt.toISOString(),
    event.documentHash,
  ]
  return sha256Hex(JSON.stringify(orderedValues))
}

/**
 * Les PDF sont chiffrés sur disque, sauf en développement pour pouvoir les
 * ouvrir directement pendant le debug. Lu à chaque appel (et non au chargement
 * du module) pour que la valeur du .env soit bien prise en compte.
 */
function shouldEncryptFiles(): boolean {
  return process.env.NODE_ENV != "dev"
}

// ─── Classe ──────────────────────────────────────────────────────────────────

export class SignatureLog {
  /**
   * Ajoute un événement à la fin du journal d'une enveloppe.
   *
   * On lit le dernier événement pour connaître son hash et son numéro, puis on
   * écrit le nouveau. Si un autre événement a été écrit entre-temps, la
   * contrainte unique (envelopeId, sequence) bloque l'écriture : on recommence.
   */
  async record(envelopeId: number, event: NewSignatureEvent): Promise<SignatureEventRecord> {
    for (let attempt = 1; attempt <= MAX_RECORD_ATTEMPTS; attempt++) {
      try {
        return await this.writeEvent(envelopeId, event)
      } catch (err) {
        const isSequenceConflict =
          err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
        if (!isSequenceConflict || attempt === MAX_RECORD_ATTEMPTS) throw err
      }
    }
    throw new Error("Impossible d'écrire l'événement dans le journal de signature")
  }

  private async writeEvent(envelopeId: number, event: NewSignatureEvent): Promise<SignatureEventRecord> {
    const lastEvent = await prisma.signatureAuditEvent.findFirst({
      where: { envelopeId },
      orderBy: { sequence: "desc" },
      select: { sequence: true, eventHash: true },
    })

    const newEvent = {
      sequence: (lastEvent?.sequence ?? 0) + 1,
      eventType: event.eventType,
      actorRole: event.actorRole,
      actorName: event.actorName ?? null,
      actorEmail: event.actorEmail ?? null,
      ipAddress: event.context?.ipAddress ?? null,
      userAgent: event.context?.userAgent ?? null,
      details: event.details ?? null,
      occurredAt: new Date(),
      documentHash: event.documentHash ?? null,
      previousHash: lastEvent?.eventHash ?? null,
    }
    const eventHash = computeEventHash(newEvent)
    const externalId = crypto.randomUUID()

    await prisma.signatureAuditEvent.create({
      data: {
        ...newEvent,
        details: newEvent.details === null ? Prisma.JsonNull : (newEvent.details as Prisma.InputJsonValue),
        externalId,
        eventHash,
        envelopeId,
      },
    })

    return { ...newEvent, externalId, eventHash }
  }

  /** Tous les événements d'une enveloppe, dans l'ordre, déchiffrés. */
  async getJournal(envelopeId: number): Promise<SignatureEventRecord[]> {
    const rows = await prisma.signatureAuditEvent.findMany({
      where: { envelopeId },
      orderBy: { sequence: "asc" },
    })

    return rows.map((row) => ({
      externalId: row.externalId,
      sequence: row.sequence,
      eventType: row.eventType,
      actorRole: row.actorRole,
      actorName: row.actorName,
      actorEmail: row.actorEmail,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      details: (row.details as Record<string, unknown> | null) ?? null,
      occurredAt: row.occurredAt,
      documentHash: row.documentHash,
      previousHash: row.previousHash,
      eventHash: row.eventHash,
    }))
  }

  /**
   * Vérifie la chaîne : chaque événement doit pointer vers le hash du précédent
   * et son propre hash doit correspondre à son contenu.
   */
  verifyChain(events: SignatureEventRecord[]): ChainVerification {
    let expectedPreviousHash: string | null = null

    for (const [index, event] of events.entries()) {
      const isInOrder = event.sequence === index + 1
      const isLinked = event.previousHash === expectedPreviousHash
      const isUntouched = computeEventHash(event) === event.eventHash

      if (!isInOrder || !isLinked || !isUntouched) {
        return { isValid: false, eventCount: events.length, brokenAtSequence: event.sequence }
      }
      expectedPreviousHash = event.eventHash
    }

    return { isValid: true, eventCount: events.length, brokenAtSequence: null }
  }

  // ─── PDF signé figé ────────────────────────────────────────────────────────

  /**
   * Fige le PDF signé final : le stocke une seule fois sur disque, enregistre
   * son empreinte, puis demande l'horodatage.
   * Si l'enveloppe est déjà scellée, on ne refait rien.
   */
  async sealSignedDocument(envelopeId: number, signedPdf: Buffer): Promise<{ finalDocumentHash: string }> {
    const envelope = await prisma.signatureEnvelope.findUniqueOrThrow({
      where: { idEnvelope: envelopeId },
      select: { externalId: true, finalDocumentHash: true },
    })
    if (envelope.finalDocumentHash) {
      return { finalDocumentHash: envelope.finalDocumentHash }
    }

    const finalDocumentHash = sha256Hex(signedPdf)
    const finalDocumentPath = path.join(CONTRACT_SIGNATURE_DIR, `${envelope.externalId}_signe.pdf`)

    await fs.mkdir(CONTRACT_SIGNATURE_DIR, { recursive: true })
    await fs.writeFile(finalDocumentPath, shouldEncryptFiles() ? encryptBuffer(signedPdf) : signedPdf)

    await prisma.signatureEnvelope.update({
      where: { idEnvelope: envelopeId },
      data: { finalDocumentHash, finalDocumentPath },
    })
    await this.record(envelopeId, {
      eventType: "SIGNED_DOCUMENT_SEALED",
      actorRole: "SYSTEM",
      documentHash: finalDocumentHash,
    })

    // L'horodatage ne doit jamais bloquer la signature : en cas d'échec, on
    // pourra le relancer plus tard avec timestampEnvelope().
    try {
      await this.timestampEnvelope(envelopeId)
    } catch (err) {
      logger.error("[signature] Horodatage TSA impossible, à relancer", err)
    }

    return { finalDocumentHash }
  }

  /**
   * Fait horodater par la TSA le PDF final ET le journal à cet instant.
   *
   * On horodate une seule empreinte, le « sceau » :
   *   sealHash = SHA-256(finalDocumentHash + eventHash du dernier événement)
   * Comme chaque événement contient le hash du précédent, ce sceau fige tout le
   * journal jusque-là, en plus du document.
   */
  async timestampEnvelope(envelopeId: number): Promise<void> {
    const envelope = await prisma.signatureEnvelope.findUniqueOrThrow({
      where: { idEnvelope: envelopeId },
      select: { finalDocumentHash: true, finalTimestampedAt: true },
    })
    if (!envelope.finalDocumentHash) {
      throw new Error("Impossible d'horodater : le PDF final n'est pas encore scellé")
    }
    if (envelope.finalTimestampedAt) return

    const lastEvent = await prisma.signatureAuditEvent.findFirstOrThrow({
      where: { envelopeId },
      orderBy: { sequence: "desc" },
      select: { eventHash: true },
    })
    const sealHash = sha256Hex(envelope.finalDocumentHash + lastEvent.eventHash)

    const timestamp = await requestTimestamp(sealHash)

    await prisma.signatureEnvelope.update({
      where: { idEnvelope: envelopeId },
      data: {
        finalTimestampToken: new Uint8Array(timestamp.token),
        finalTimestampedAt: timestamp.timestampedAt,
      },
    })
    await this.record(envelopeId, {
      eventType: "TIMESTAMP_OBTAINED",
      actorRole: "SYSTEM",
      documentHash: envelope.finalDocumentHash,
      details: {
        tsaUrl: timestamp.tsaUrl,
        sealHash,
        timestampedEventHash: lastEvent.eventHash,
        timestampedAt: timestamp.timestampedAt.toISOString(),
      },
    })
  }

  /** Lit le PDF signé figé (déchiffré si besoin). Null s'il n'existe pas encore. */
  async readFinalDocument(envelopeId: number): Promise<Buffer | null> {
    const envelope = await prisma.signatureEnvelope.findUniqueOrThrow({
      where: { idEnvelope: envelopeId },
      select: { finalDocumentPath: true },
    })
    if (!envelope.finalDocumentPath) return null

    const storedFile = await fs.readFile(envelope.finalDocumentPath)
    return shouldEncryptFiles() ? decryptBuffer(storedFile) : storedFile
  }

  // ─── Dossier de preuve ─────────────────────────────────────────────────────

  /**
   * Construit le dossier de preuve (ZIP) :
   *   - contrat_signe.pdf          PDF signé figé
   *   - contrat_original.pdf       PDF source
   *   - certificat_de_signature.pdf  version lisible du journal
   *   - journal.json               journal brut avec la chaîne de hashes
   *   - horodatage.tsr             jeton TSA (s'il a été obtenu)
   *
   * L'enregistrement de l'événement EVIDENCE_EXPORTED est laissé à l'appelant,
   * qui connaît l'acteur et la requête.
   */
  async buildEvidencePackage(envelopeId: number): Promise<{ fileName: string; buffer: Buffer }> {
    const envelope = await prisma.signatureEnvelope.findUniqueOrThrow({
      where: { idEnvelope: envelopeId },
    })
    const events = await this.getJournal(envelopeId)
    const chain = this.verifyChain(events)

    const signedPdf = await this.readFinalDocument(envelopeId)
    if (!signedPdf) {
      throw new Error("Le dossier de preuve n'est disponible qu'une fois le document signé par les deux parties")
    }

    const evidence = {
      envelope: {
        externalId: envelope.externalId,
        documentName: envelope.documentName,
        status: envelope.status,
        sender: { name: envelope.selfName, email: envelope.selfEmail },
        counterparty: { name: envelope.counterpartyName, email: envelope.counterpartyEmail },
        sentAt: envelope.sentAt,
        senderSignedAt: envelope.selfSignedAt,
        counterpartySignedAt: envelope.counterpartySignedAt,
        completedAt: envelope.completedAt,
        originalDocumentHash: envelope.originalDocumentHash,
        finalDocumentHash: envelope.finalDocumentHash,
        timestampedAt: envelope.finalTimestampedAt,
      },
      chainVerification: chain,
      hashAlgorithm: "SHA-256",
      events,
    }

    const certificatePdf = await generateSignatureCertificatePDF({
      ...evidence.envelope,
      events,
      chain,
    })

    const zipEntries: { name: string; content: Buffer }[] = [
      { name: "contrat_signe.pdf", content: signedPdf },
      { name: "certificat_de_signature.pdf", content: certificatePdf },
      { name: "journal.json", content: Buffer.from(JSON.stringify(evidence, null, 2), "utf8") },
    ]
    if (envelope.documentFilePath) {
      // Le PDF source est toujours chiffré par le service d'enveloppes
      const originalPdf = decryptBuffer(await fs.readFile(envelope.documentFilePath))
      zipEntries.push({ name: "contrat_original.pdf", content: originalPdf })
    }
    if (envelope.finalTimestampToken) {
      zipEntries.push({ name: "horodatage.tsr", content: Buffer.from(envelope.finalTimestampToken) })
    }

    return {
      fileName: `dossier_de_preuve_${envelope.externalId}.zip`,
      buffer: await createZip(zipEntries),
    }
  }
}

/** Crée une archive ZIP en mémoire à partir d'une liste de fichiers. */
function createZip(entries: { name: string; content: Buffer }[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = new ZipArchive({ zlib: { level: 9 } })
    const chunks: Buffer[] = []

    archive.on("data", (chunk: Buffer) => chunks.push(chunk))
    archive.on("end", () => resolve(Buffer.concat(chunks)))
    archive.on("error", reject)

    for (const entry of entries) {
      archive.append(entry.content, { name: entry.name })
    }
    archive.finalize()
  })
}
