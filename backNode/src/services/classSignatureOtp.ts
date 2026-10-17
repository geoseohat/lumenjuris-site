/**
 * Code à usage unique (OTP) demandé avant de signer.
 *
 * Chaque signataire (émetteur ET cocontractant) reçoit un code à 6 chiffres par
 * e-mail. Le saisir prouve qu'au moment de signer, la personne contrôle la
 * boîte mail du signataire. Chaque étape est inscrite au journal de preuve.
 *
 * Voir documentation/signature_journal.md §5.
 */
import crypto from "crypto"
import type { SignatureActorRole } from "@prisma/client"
import { prisma } from "../../prisma/singletonPrisma.js"
import { hashToken } from "./encryption.js"
import { Mailer } from "../infrastructure/mailer/classMailer.js"
import { SignatureLog, type RequestContext } from "./classSignatureLog.js"

/** Durée de validité d'un code. */
const OTP_VALIDITY_MINUTES = 10
/** Nombre d'essais ratés avant que le code soit bloqué. */
const OTP_MAX_ATTEMPTS = 5
/** Délai minimal entre deux envois de code. */
const OTP_RESEND_DELAY_SECONDS = 60
/** Nombre maximal de codes envoyés par heure, pour un signataire et une enveloppe. */
const OTP_MAX_SENDS_PER_HOUR = 5

/** Le signataire concerné par le code. */
export type OtpSigner = {
  role: Extract<SignatureActorRole, "SENDER" | "COUNTERPARTY">
  name: string
  email: string
}

export type SendOtpResult =
  | { success: true }
  | { success: false; reason: "TOO_SOON" | "TOO_MANY_SENDS" | "MAIL_FAILED"; retryAfterSeconds?: number }

export type VerifyOtpResult =
  | { success: true }
  | { success: false; reason: "NO_CODE" | "EXPIRED" | "TOO_MANY_ATTEMPTS" | "WRONG_CODE"; attemptsLeft?: number }

export class SignatureOtp {
  private readonly signatureLog = new SignatureLog()

  /**
   * Génère un code, l'envoie par e-mail et l'inscrit au journal.
   * Les anciens codes non utilisés de ce signataire sont invalidés.
   */
  async send(
    envelope: { idEnvelope: number; documentName: string },
    signer: OtpSigner,
    context: RequestContext,
  ): Promise<SendOtpResult> {
    const limitReached = await this.checkSendLimits(envelope.idEnvelope, signer.role)
    if (limitReached) return limitReached

    // Aléatoire cryptographique (jamais Math.random), complété à 6 chiffres : 42 → "000042"
    const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0")
    const now = new Date()

    // Un seul code valable à la fois : les précédents sont expirés immédiatement
    await prisma.signatureOtp.updateMany({
      where: { envelopeId: envelope.idEnvelope, signerRole: signer.role, usedAt: null, expiresAt: { gt: now } },
      data: { expiresAt: now },
    })
    await prisma.signatureOtp.create({
      data: {
        envelopeId: envelope.idEnvelope,
        signerRole: signer.role,
        codeHash: hashToken(code),
        expiresAt: new Date(now.getTime() + OTP_VALIDITY_MINUTES * 60_000),
      },
    })

    const mail = await new Mailer(signer.email).sendSignatureOtp({
      code,
      documentName: envelope.documentName,
      validityMinutes: OTP_VALIDITY_MINUTES,
      recipientName: signer.name,
    })
    if (!mail.success) return { success: false, reason: "MAIL_FAILED" }

    await this.signatureLog.record(envelope.idEnvelope, {
      eventType: "OTP_SENT",
      actorRole: "SYSTEM",
      actorName: signer.name,
      actorEmail: signer.email,
      context,
      details: { channel: "email", signerRole: signer.role, validityMinutes: OTP_VALIDITY_MINUTES },
    })
    return { success: true }
  }

  /**
   * Vérifie le code saisi. Ordre des contrôles : existence, expiration,
   * nombre d'essais, puis comparaison des empreintes.
   */
  async verify(
    envelopeId: number,
    signer: OtpSigner,
    code: string,
    context: RequestContext,
  ): Promise<VerifyOtpResult> {
    const otp = await prisma.signatureOtp.findFirst({
      where: { envelopeId, signerRole: signer.role, usedAt: null },
      orderBy: { createdAt: "desc" },
    })
    if (!otp) return { success: false, reason: "NO_CODE" }
    if (otp.expiresAt <= new Date()) return { success: false, reason: "EXPIRED" }
    if (otp.attempts >= OTP_MAX_ATTEMPTS) return { success: false, reason: "TOO_MANY_ATTEMPTS" }

    const signerEvent = { actorRole: signer.role, actorName: signer.name, actorEmail: signer.email, context }

    if (!isSameHash(hashToken(code.trim()), otp.codeHash)) {
      const updated = await prisma.signatureOtp.update({
        where: { idOtp: otp.idOtp },
        data: { attempts: { increment: 1 } },
      })
      const attemptsLeft = Math.max(0, OTP_MAX_ATTEMPTS - updated.attempts)
      await this.signatureLog.record(envelopeId, {
        ...signerEvent,
        eventType: "OTP_FAILED",
        details: { attempt: updated.attempts, attemptsLeft },
      })
      return { success: false, reason: "WRONG_CODE", attemptsLeft }
    }

    await prisma.signatureOtp.update({
      where: { idOtp: otp.idOtp },
      data: { usedAt: new Date() },
    })
    await this.signatureLog.record(envelopeId, {
      ...signerEvent,
      eventType: "OTP_VERIFIED",
      details: { channel: "email" },
    })
    return { success: true }
  }

  /** Anti-abus : un envoi par minute et 5 par heure au maximum. */
  private async checkSendLimits(
    envelopeId: number,
    signerRole: OtpSigner["role"],
  ): Promise<SendOtpResult | null> {
    const oneHourAgo = new Date(Date.now() - 60 * 60_000)
    const recentOtps = await prisma.signatureOtp.findMany({
      where: { envelopeId, signerRole, createdAt: { gte: oneHourAgo } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    })

    const lastSend = recentOtps[0]
    if (lastSend) {
      const secondsSinceLastSend = (Date.now() - lastSend.createdAt.getTime()) / 1000
      if (secondsSinceLastSend < OTP_RESEND_DELAY_SECONDS) {
        return {
          success: false,
          reason: "TOO_SOON",
          retryAfterSeconds: Math.ceil(OTP_RESEND_DELAY_SECONDS - secondsSinceLastSend),
        }
      }
    }
    if (recentOtps.length >= OTP_MAX_SENDS_PER_HOUR) {
      return { success: false, reason: "TOO_MANY_SENDS" }
    }
    return null
  }
}

/**
 * Compare deux empreintes en temps constant : la durée de la comparaison ne
 * dépend pas du nombre de caractères identiques, donc ne laisse rien deviner.
 */
function isSameHash(hashA: string, hashB: string): boolean {
  const bufferA = Buffer.from(hashA, "hex")
  const bufferB = Buffer.from(hashB, "hex")
  return bufferA.length === bufferB.length && crypto.timingSafeEqual(bufferA, bufferB)
}
