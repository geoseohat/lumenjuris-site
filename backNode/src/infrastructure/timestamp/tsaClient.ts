/**
 * Client d'horodatage RFC 3161.
 *
 * On envoie à une autorité d'horodatage (TSA) l'empreinte SHA-256 d'un contenu.
 * Elle renvoie un « jeton » signé qui prouve que cette empreinte existait à une
 * date précise. On ne lui envoie jamais le document lui-même, seulement son hash.
 *
 * Le format d'échange est du DER (encodage binaire ASN.1). On construit la
 * requête à la main, car elle est toujours la même à part l'empreinte et le
 * nonce : cela évite d'ajouter une librairie cryptographique complète.
 *
 * Voir documentation/signature_journal.md §6.
 */
import crypto from "crypto"

/** FreeTSA par défaut ; à remplacer par une TSA qualifiée eIDAS via le .env. */
const DEFAULT_TSA_URL = "https://freetsa.org/tsr"

/** Délai maximal d'attente de la réponse de la TSA. */
const TSA_TIMEOUT_MS = 15_000

export type TimestampResult = {
  /** Jeton RFC 3161 brut (à stocker tel quel et à joindre au dossier de preuve). */
  token: Buffer
  /** Date certifiée par la TSA. */
  timestampedAt: Date
  /** URL de la TSA utilisée (tracée dans le journal). */
  tsaUrl: string
}

export function getTsaUrl(): string {
  return process.env.TSA_URL || DEFAULT_TSA_URL
}

/**
 * Demande un horodatage pour une empreinte SHA-256 (64 caractères hexadécimaux).
 * Lève une erreur si la TSA ne répond pas ou refuse la demande.
 */
export async function requestTimestamp(sha256Hex: string): Promise<TimestampResult> {
  const tsaUrl = getTsaUrl()
  const requestBody = buildTimestampRequest(Buffer.from(sha256Hex, "hex"))

  const response = await fetch(tsaUrl, {
    method: "POST",
    headers: { "Content-Type": "application/timestamp-query" },
    body: new Uint8Array(requestBody),
    signal: AbortSignal.timeout(TSA_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`La TSA a répondu ${response.status} ${response.statusText}`)
  }

  const responseBytes = Buffer.from(await response.arrayBuffer())
  return { ...parseTimestampResponse(responseBytes), tsaUrl }
}

// ─── Construction de la requête ──────────────────────────────────────────────
//
// TimeStampReq ::= SEQUENCE {
//   version         INTEGER (1),
//   messageImprint  SEQUENCE { hashAlgorithm (sha256), hashedMessage OCTET STRING },
//   nonce           INTEGER (nombre aléatoire, renvoyé par la TSA),
//   certReq         BOOLEAN (TRUE : la TSA joint son certificat au jeton)
// }

/** Identifiant de l'algorithme SHA-256 : SEQUENCE { OID 2.16.840.1.101.3.4.2.1, NULL }. */
const SHA256_ALGORITHM_IDENTIFIER = Buffer.from("300d06096086480165030402010500", "hex")

function buildTimestampRequest(sha256Digest: Buffer): Buffer {
  const version = derElement(0x02, Buffer.from([0x01]))
  const messageImprint = derElement(
    0x30,
    Buffer.concat([SHA256_ALGORITHM_IDENTIFIER, derElement(0x04, sha256Digest)]),
  )
  const nonce = derElement(0x02, randomPositiveInteger(8))
  const certReq = derElement(0x01, Buffer.from([0xff]))

  return derElement(0x30, Buffer.concat([version, messageImprint, nonce, certReq]))
}

/** Encode un élément DER : [type][longueur][contenu]. */
function derElement(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content])
}

/** Longueur DER : sur 1 octet si < 128, sinon 0x80 + nombre d'octets, puis la valeur. */
function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length])
  const bytes: number[] = []
  let remaining = length
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff)
    remaining = remaining >> 8
  }
  return Buffer.from([0x80 + bytes.length, ...bytes])
}

/** Entier aléatoire positif (le premier bit à 0, sinon DER le lirait comme négatif). */
function randomPositiveInteger(byteCount: number): Buffer {
  const bytes = crypto.randomBytes(byteCount)
  bytes[0] = bytes[0]! & 0x7f
  return bytes
}

// ─── Lecture de la réponse ───────────────────────────────────────────────────
//
// TimeStampResp ::= SEQUENCE {
//   status          SEQUENCE { status INTEGER, ... },   0 = accordé, 1 = accordé avec modifications
//   timeStampToken  le jeton signé (ce qu'on conserve)
// }

type DerElement = { tag: number; start: number; contentStart: number; end: number }

function parseTimestampResponse(bytes: Buffer): { token: Buffer; timestampedAt: Date } {
  const response = readDerElement(bytes, 0)
  const statusInfo = readDerElement(bytes, response.contentStart)
  const statusValue = readDerElement(bytes, statusInfo.contentStart)
  const status = bytes[statusValue.end - 1]

  if (status !== 0 && status !== 1) {
    throw new Error(`La TSA a refusé la demande d'horodatage (statut ${status})`)
  }
  if (statusInfo.end >= response.end) {
    throw new Error("Réponse de la TSA sans jeton d'horodatage")
  }

  const tokenElement = readDerElement(bytes, statusInfo.end)
  const token = bytes.subarray(tokenElement.start, tokenElement.end)
  return { token: Buffer.from(token), timestampedAt: findGenerationTime(token) }
}

/** Lit l'en-tête d'un élément DER à la position donnée. */
function readDerElement(bytes: Buffer, position: number): DerElement {
  const tag = bytes[position]!
  const firstLengthByte = bytes[position + 1]!
  let length = firstLengthByte
  let contentStart = position + 2

  if (firstLengthByte >= 0x80) {
    const lengthByteCount = firstLengthByte - 0x80
    length = 0
    for (let i = 0; i < lengthByteCount; i++) {
      length = length * 256 + bytes[position + 2 + i]!
    }
    contentStart += lengthByteCount
  }

  return { tag, start: position, contentStart, end: contentStart + length }
}

/**
 * Retrouve la date certifiée (`genTime`) dans le jeton.
 *
 * C'est le premier champ de type GeneralizedTime (tag 0x18) du jeton : les
 * dates des certificats et l'attribut signingTime utilisent un autre type
 * (UTCTime, tag 0x17). Format : "AAAAMMJJhhmmss[.fff]Z".
 */
function findGenerationTime(token: Buffer): Date {
  for (let i = 0; i < token.length - 2; i++) {
    if (token[i] !== 0x18) continue
    const length = token[i + 1]!
    if (length < 15 || length > 24) continue

    const text = token.subarray(i + 2, i + 2 + length).toString("ascii")
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d+)?Z$/.exec(text)
    if (!match) continue

    const [, year, month, day, hour, minute, second, fraction] = match
    return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${fraction ?? ""}Z`)
  }
  throw new Error("Date d'horodatage introuvable dans le jeton de la TSA")
}
