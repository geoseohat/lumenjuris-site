/**
 * Liste des champs chiffrés en base, par modèle Prisma.
 *
 * C'est le SEUL endroit à modifier pour chiffrer un nouveau champ : l'extension
 * Prisma (encryptionExtension.ts) chiffre ces champs à l'écriture et les
 * déchiffre à la lecture, partout dans l'application.
 *
 * Règles à respecter pour un champ chiffré :
 *   - type `String @db.Text` / `@db.LongText` (un VARCHAR(191) est trop court
 *     pour la valeur chiffrée) ou `Json` ;
 *   - on ne peut PAS filtrer (where), trier (orderBy) ni mettre de @unique
 *     dessus : la base ne voit que du texte chiffré. Filtrer/trier en mémoire
 *     après la lecture (voir ContractService.list pour un exemple).
 */
export const ENCRYPTED_FIELDS: Record<string, string[]> = {
    // ─── Contrathèque ───
    Contract: ["title", "counterpartyName", "responsibleName", "ocrText", "approvalNote"],
    ContractMetadataField: ["value"],
    Amendment: ["title", "summary"],
    ContractVersion: ["contentText", "note"],
    ContractComment: ["body"],
    AuditLog: ["payloadBefore", "payloadAfter"],
    ContractSummary: [
        "identification",
        "resume_executif",
        "parties",
        "dates",
        "objet",
        "obligations",
        "conditions_financieres",
        "responsabilite",
        "clauses_particulieres",
        "delais_importants",
        "annexes",
        "resiliation",
        "points_attention",
        "niveau_risque",
        "duree",
        "fileName",
        "rawText",
    ],

    // ─── Négociation ───
    NegotiationVersion: ["contentText", "structuredJson"],
    NegotiationField: ["value"],
    ClauseProposal: ["originalText", "proposedText"],
    NegotiationComment: ["body", "quote", "proposedText"],
    NegotiationAudit: ["payload"],

    // ─── Bibliothèque de clauses ───
    Clause: ["body", "notes"],

    // ─── Chat juridique ───
    ChatHistory: ["conversations"],

    // ─── Analyse, modèles, génération, signature ───
    ContractHistory: ["snapshot"],
    NegotiationPlaybookAnalysis: ["fileName", "snapshot"],
    ContractTemplate: ["structure"],
    GenerationLog: ["output"],
    SignatureEnvelope: [
        "envelopeFields",
        // Données personnelles des signataires
        "selfName",
        "selfEmail",
        "counterpartyName",
        "counterpartyEmail",
        // Copie chiffrée du lien de signature (la recherche se fait sur signingTokenHash)
        "signingToken",
    ],
    // Journal de preuve : identité et contexte technique du signataire
    SignatureAuditEvent: ["actorName", "actorEmail", "ipAddress", "userAgent", "details"],

    // ─── Données personnelles ───
    // User.email reste en clair : il sert à la connexion (where) et porte un @unique.
    User: ["nom", "prenom"],
    // `token` : copie chiffrée du lien invité (la recherche se fait sur tokenHash)
    GuestAccess: ["name", "email", "token"],
    NegotiationParticipant: ["name", "email"],
}
