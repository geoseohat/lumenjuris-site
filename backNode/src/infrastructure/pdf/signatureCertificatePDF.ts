/**
 * Certificat de signature : version lisible du journal de preuve, jointe au
 * dossier de preuve. Il reprend les parties, les empreintes du document,
 * l'horodatage et la chronologie complète des événements.
 */
import PDFDocument from "pdfkit"
import type { SignatureEventType } from "@prisma/client"
import type { ChainVerification, SignatureEventRecord } from "../../services/classSignatureLog.js"

type PdfDoc = InstanceType<typeof PDFDocument>

export type SignatureCertificateData = {
  externalId: string
  documentName: string
  sender: { name: string; email: string }
  counterparty: { name: string; email: string }
  sentAt: Date | null
  senderSignedAt: Date | null
  counterpartySignedAt: Date | null
  completedAt: Date | null
  originalDocumentHash: string | null
  finalDocumentHash: string | null
  timestampedAt: Date | null
  events: SignatureEventRecord[]
  chain: ChainVerification
}

/** Libellés français des événements affichés dans la chronologie. */
const EVENT_LABELS: Record<SignatureEventType, string> = {
  ENVELOPE_CREATED: "Création de l'enveloppe",
  DOCUMENT_HASHED: "Empreinte du document original calculée",
  INVITE_SENT: "Invitation à signer envoyée",
  INVITE_RESENT: "Invitation à signer renvoyée",
  DOCUMENT_OPENED: "Lien de signature ouvert",
  DOCUMENT_VIEWED: "Document consulté",
  CONSENT_ACCEPTED: "Consentement à la signature électronique",
  OTP_SENT: "Code de vérification envoyé par e-mail",
  OTP_VERIFIED: "Code de vérification validé",
  OTP_FAILED: "Code de vérification erroné",
  SIGNATURE_APPLIED: "Signature apposée",
  SIGNER_COMPLETED: "Signataire a terminé de signer",
  ENVELOPE_COMPLETED: "Document signé par les deux parties",
  SIGNED_DOCUMENT_SEALED: "Document signé figé et empreinte calculée",
  TIMESTAMP_OBTAINED: "Horodatage obtenu auprès d'une autorité tierce (RFC 3161)",
  SIGNED_DOCUMENT_DOWNLOADED: "Document signé téléchargé",
  EVIDENCE_EXPORTED: "Dossier de preuve téléchargé",
  DECLINED: "Signature refusée",
  EXPIRED: "Invitation expirée",
  ENVELOPE_ARCHIVED: "Enveloppe archivée",
}

const ACTOR_LABELS = { SENDER: "Émetteur", COUNTERPARTY: "Cocontractant", SYSTEM: "Système" }

const COLOR_TITLE = "#0A2540"
const COLOR_TEXT = "#374151"
const COLOR_MUTED = "#6b7280"

/** Date lisible en heure de Paris, avec l'heure UTC exacte entre parenthèses. */
function formatDate(date: Date | null): string {
  if (!date) return "—"
  const parisTime = date.toLocaleString("fr-FR", { timeZone: "Europe/Paris" })
  return `${parisTime} (${date.toISOString()})`
}

export function generateSignatureCertificatePDF(data: SignatureCertificateData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc: PdfDoc = new PDFDocument({ size: "A4", margin: 50 })
    const chunks: Buffer[] = []
    doc.on("data", (chunk: Buffer) => chunks.push(chunk))
    doc.on("end", () => resolve(Buffer.concat(chunks)))
    doc.on("error", reject)

    // ── En-tête ──
    doc.fillColor(COLOR_TITLE).font("Helvetica-Bold").fontSize(20).text("Certificat de signature électronique")
    doc.moveDown(0.3)
    doc.fillColor(COLOR_MUTED).font("Helvetica").fontSize(9)
      .text(`Généré par Lumen Juris le ${formatDate(new Date())}`)
      .text(`Référence de l'enveloppe : ${data.externalId}`)
    doc.moveDown(1)

    // ── Document ──
    writeSectionTitle(doc, "Document")
    writeLine(doc, "Nom", data.documentName)
    writeLine(doc, "Empreinte SHA-256 du document original", data.originalDocumentHash ?? "—")
    writeLine(doc, "Empreinte SHA-256 du document signé", data.finalDocumentHash ?? "—")
    writeLine(doc, "Horodatage TSA (RFC 3161)", formatDate(data.timestampedAt))

    // ── Parties ──
    writeSectionTitle(doc, "Signataires")
    writeLine(doc, "Émetteur", `${data.sender.name} <${data.sender.email}>`)
    writeLine(doc, "Signé le", formatDate(data.senderSignedAt))
    writeLine(doc, "Cocontractant", `${data.counterparty.name} <${data.counterparty.email}>`)
    writeLine(doc, "Signé le", formatDate(data.counterpartySignedAt))
    writeLine(doc, "Identification", "Code à usage unique envoyé par e-mail à chaque signataire")

    // ── Intégrité du journal ──
    writeSectionTitle(doc, "Intégrité du journal")
    writeLine(
      doc,
      "Chaîne de hashes",
      data.chain.isValid
        ? `Intègre (${data.chain.eventCount} événements vérifiés)`
        : `ALTÉRÉE à partir de l'événement n°${data.chain.brokenAtSequence}`,
    )

    // ── Chronologie ──
    writeSectionTitle(doc, "Chronologie")
    for (const event of data.events) {
      if (doc.y > doc.page.height - 120) doc.addPage()

      doc.fillColor(COLOR_TITLE).font("Helvetica-Bold").fontSize(9)
        .text(`${event.sequence}. ${EVENT_LABELS[event.eventType]}`)
      doc.fillColor(COLOR_TEXT).font("Helvetica").fontSize(8)
        .text(`${formatDate(event.occurredAt)} — ${ACTOR_LABELS[event.actorRole]}`)

      const actor = [event.actorName, event.actorEmail ? `<${event.actorEmail}>` : null].filter(Boolean).join(" ")
      if (actor) doc.text(`Acteur : ${actor}`)
      if (event.ipAddress) doc.text(`IP : ${event.ipAddress}`)
      if (event.userAgent) doc.text(`Appareil : ${event.userAgent}`)

      doc.fillColor(COLOR_MUTED).fontSize(7).text(`Hash : ${event.eventHash}`)
      doc.moveDown(0.5)
    }

    // ── Méthode de vérification ──
    if (doc.y > doc.page.height - 160) doc.addPage()
    writeSectionTitle(doc, "Vérification")
    doc.fillColor(COLOR_TEXT).font("Helvetica").fontSize(8).text(
      "Chaque événement contient l'empreinte de l'événement précédent : toute modification ou " +
        "suppression d'un événement rend la chaîne invalide. Le fichier journal.json permet de " +
        "recalculer ces empreintes. L'empreinte du document signé, combinée à celle du dernier " +
        "événement au moment de la clôture, a été horodatée par une autorité tierce (fichier " +
        "horodatage.tsr, vérifiable avec : openssl ts -verify).",
    )

    doc.end()
  })
}

function writeSectionTitle(doc: PdfDoc, title: string) {
  doc.moveDown(0.6)
  doc.fillColor(COLOR_TITLE).font("Helvetica-Bold").fontSize(12).text(title)
  doc.moveDown(0.3)
}

function writeLine(doc: PdfDoc, label: string, value: string) {
  doc.fillColor(COLOR_MUTED).font("Helvetica").fontSize(8).text(label)
  doc.fillColor(COLOR_TEXT).font("Helvetica").fontSize(9).text(value)
  doc.moveDown(0.3)
}
