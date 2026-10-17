# Journal de signature et dossier de preuve

Ce document décrit le système de preuve de la signature électronique de LumenJuris :
le journal d'événements, l'OTP, l'horodatage, le PDF figé et le dossier de preuve.

---

## 1. Objectif et cadre eIDAS

Le règlement européen eIDAS (n° 910/2014) définit trois niveaux de signature :

| Niveau | Exigences | LumenJuris |
|---|---|---|
| **Simple (SES)** | Toute donnée électronique liée au document. Recevable, mais la fiabilité doit être prouvée par celui qui l'invoque. | Niveau de base |
| **Avancée (AES)** | 1. Liée au signataire de manière univoque 2. Permet de l'identifier 3. Créée sous son contrôle exclusif 4. Toute modification ultérieure est détectable | **Niveau visé** |
| **Qualifiée (QES)** | AES + certificat qualifié délivré par un prestataire qualifié (QTSP) + dispositif qualifié. Équivaut à la signature manuscrite. | Hors de portée sans QTSP |

Comment on couvre les 4 critères de l'AES :

| Critère | Mécanisme |
|---|---|
| Lien univoque | Chaque signataire a son propre parcours, journalisé avec son e-mail, son IP et son appareil |
| Identification | OTP envoyé sur l'e-mail du signataire, pour **les deux parties** |
| Contrôle exclusif | Le code OTP n'est connu que du titulaire de la boîte mail |
| Détection des modifications | Empreintes SHA-256 du document + journal chaîné + horodatage RFC 3161 |

> Limite à connaître : l'OTP par e-mail passe par le même canal que le lien de signature.
> C'est acceptable pour démarrer, mais un second canal (SMS, voir §8) renforce la preuve.

---

## 2. Modèle de données

### `SignatureEnvelope` (champs ajoutés)

| Champ | Rôle |
|---|---|
| `status = ARCHIVED` | Remplace la suppression définitive |
| `archivedAt` | Date d'archivage |
| `expiresAt` | Fin de validité de l'invitation : **envoi + 14 jours** |
| `originalDocumentHash` | SHA-256 du PDF source, calculé à l'envoi |
| `finalDocumentHash` | SHA-256 du PDF signé figé |
| `finalDocumentPath` | Chemin du PDF signé figé dans `backNode/contractSignature/` |
| `finalTimestampToken` | Jeton d'horodatage RFC 3161 brut (DER) |
| `finalTimestampedAt` | Date certifiée par la TSA |
| `userId` (nullable) | `onDelete: SetNull` : supprimer un compte ne supprime plus la preuve |

### `SignatureAuditEvent` (le journal)

On ajoute des lignes ; on ne les modifie ni ne les supprime jamais.

| Champ | Rôle | Chiffré |
|---|---|---|
| `externalId` | Identifiant public | non |
| `sequence` | Ordre dans l'enveloppe (1, 2, 3…) | non |
| `eventType` | Type d'événement (§3) | non |
| `actorRole` | `SENDER` / `COUNTERPARTY` / `SYSTEM` | non |
| `actorName`, `actorEmail` | Identité déclarée | **oui** |
| `ipAddress`, `userAgent` | Contexte technique | **oui** |
| `details` | Informations propres à l'événement (JSON) | **oui** |
| `occurredAt` | Heure du serveur (UTC) | non |
| `documentHash` | SHA-256 du document à cet instant | non |
| `previousHash` | `eventHash` de l'événement précédent | non |
| `eventHash` | SHA-256 de l'événement (voir §4) | non |

Relation vers l'enveloppe en `onDelete: Restrict` : on ne peut pas supprimer une enveloppe qui a un journal.

### `SignatureOtp`

| Champ | Rôle |
|---|---|
| `signerRole` | `SENDER` ou `COUNTERPARTY` |
| `codeHash` | SHA-256 du code (jamais le code en clair) |
| `attempts` | Essais ratés, bloqué à 5 |
| `expiresAt` | Création + 10 minutes |
| `usedAt` | Renseigné quand le code est validé |

---

## 3. Types d'événements

| Événement | Acteur | Moment |
|---|---|---|
| `ENVELOPE_CREATED` | SENDER | Création de l'enveloppe |
| `DOCUMENT_HASHED` | SYSTEM | Calcul de `originalDocumentHash` |
| `INVITE_SENT` / `INVITE_RESENT` | SENDER | Envoi / renvoi du lien au cocontractant |
| `DOCUMENT_OPENED` | COUNTERPARTY | Ouverture du lien public |
| `DOCUMENT_VIEWED` | SENDER / COUNTERPARTY | Document affiché en entier |
| `CONSENT_ACCEPTED` | SENDER / COUNTERPARTY | Case « j'accepte de signer électroniquement » |
| `OTP_SENT` | SYSTEM | Envoi du code |
| `OTP_VERIFIED` / `OTP_FAILED` | SENDER / COUNTERPARTY | Saisie du code |
| `SIGNATURE_APPLIED` | SENDER / COUNTERPARTY | Un champ de signature rempli |
| `SIGNER_COMPLETED` | SENDER / COUNTERPARTY | Toutes les signatures d'une partie posées |
| `ENVELOPE_COMPLETED` | SYSTEM | Les deux parties ont signé |
| `SIGNED_DOCUMENT_SEALED` | SYSTEM | PDF final généré, figé et haché |
| `TIMESTAMP_OBTAINED` | SYSTEM | Jeton TSA reçu |
| `SIGNED_DOCUMENT_DOWNLOADED` | SENDER / COUNTERPARTY | Téléchargement du PDF signé |
| `EVIDENCE_EXPORTED` | SENDER | Téléchargement du dossier de preuve |
| `DECLINED` | COUNTERPARTY | Refus de signer |
| `EXPIRED` | SYSTEM | Invitation expirée (14 jours) |
| `ENVELOPE_ARCHIVED` | SENDER | Archivage |

---

## 4. Chaînage des événements

Chaque événement contient le hash du précédent, comme les maillons d'une chaîne :

```
eventHash = SHA-256(
  previousHash + sequence + eventType + actorRole + actorName + actorEmail
  + ipAddress + userAgent + details + occurredAt(ISO) + documentHash
)
```

- Le hash est calculé sur les valeurs **en clair**, avant le chiffrement par l'extension Prisma.
- Le premier événement a `previousHash = null`.
- **Vérification** : on relit les événements dans l'ordre et on recalcule chaque hash.
  Si une ligne a été modifiée ou supprimée, le hash ne correspond plus à partir de cette ligne.
- Le `eventHash` du dernier événement est horodaté par la TSA avec le PDF final :
  cela fige tout le journal à une date certaine.

---

## 5. L'OTP (code à usage unique)

### Principe

Avant de signer, chaque signataire (émetteur **et** cocontractant) reçoit par e-mail un code
à 6 chiffres qu'il doit saisir. Cela prouve qu'au moment de signer, la personne contrôle
la boîte mail du signataire.

### Règles

| Règle | Valeur |
|---|---|
| Longueur | 6 chiffres |
| Validité | 10 minutes |
| Essais | 5 maximum, puis il faut un nouveau code |
| Renvoi | 1 toutes les 60 secondes, 5 par heure maximum |
| Usage | Une seule fois |

### Déroulé technique

1. **Génération** : `crypto.randomInt(0, 1_000_000)` complété à 6 chiffres (aléatoire sûr, jamais `Math.random`).
2. **Stockage** : on enregistre `hashToken(code)`, jamais le code. Les anciens codes non utilisés sont invalidés.
3. **Envoi** : e-mail via `classMailer` (template `signatureOtp`). Événement `OTP_SENT`.
4. **Vérification**, dans cet ordre :
   - code expiré ? → refus
   - code déjà utilisé ? → refus
   - 5 essais atteints ? → refus
   - comparaison des hash avec `crypto.timingSafeEqual` (ne laisse pas deviner le code au temps de réponse)
   - échec → `attempts + 1`, événement `OTP_FAILED`
   - succès → `usedAt = now`, événement `OTP_VERIFIED`
5. **Signature** : le code est envoyé **dans la même requête** que la validation de la signature (`code` + `consentAccepted`). Sans code valide, rien n'est signé.

---

## 6. Horodatage (TSA, RFC 3161)

À la clôture, on envoie à une **autorité d'horodatage** (TSA) le hash du PDF final et le
dernier `eventHash`. Elle renvoie un **jeton signé** prouvant que ces empreintes existaient
à cette date. Contrairement à l'heure de notre serveur, cette date ne peut pas être contestée.

- **Actuellement** : TSA gratuite **FreeTSA** (`https://freetsa.org/tsr`).
- L'URL de la TSA est lue dans le `.env` (`TSA_URL`) pour pouvoir changer de prestataire sans toucher au code.
- Si la TSA ne répond pas, la signature n'est pas bloquée : l'enveloppe est clôturée,
  et l'horodatage est retenté plus tard (l'absence de `finalTimestampedAt` le signale).

### FreeTSA en production ?

Pour démarrer, c'est **utilisable** : le jeton RFC 3161 est valide et vérifiable, et il apporte
une vraie preuve d'antériorité. Mais :

- FreeTSA **n'est pas un prestataire qualifié eIDAS** : son horodatage n'a pas la
  **présomption d'exactitude** de l'article 41 d'eIDAS. En cas de litige, c'est à nous
  d'en démontrer la fiabilité.
- Aucun engagement de disponibilité ni de pérennité (service bénévole).

→ OK pour le lancement, mais à remplacer par une TSA qualifiée dès que le volume ou les
clients (contrats à fort enjeu) le justifient.

---

## 7. PDF signé figé et dossier de preuve

### PDF figé

- Généré **une seule fois**, à la clôture (avant, il était reconstruit à chaque téléchargement
  et son hash changeait à chaque fois).
- Stocké dans `backNode/contractSignature/`.
- Chiffré sur disque **sauf en développement** (`process.env.NODE_ENV != "dev"`), pour pouvoir
  ouvrir les fichiers et vérifier visuellement pendant le debug.

### Dossier de preuve (ZIP)

1. `contrat_signe.pdf` : le PDF signé figé
2. `contrat_original.pdf` : le PDF source
3. `certificat_de_signature.pdf` : version lisible (parties, empreintes, chronologie, IP, appareils, horodatage)
4. `journal.json` : le journal brut avec la chaîne de hashes (vérifiable par un expert)
5. `horodatage.tsr` : le jeton TSA

### Diffusion

- En **pièce jointe** de l'e-mail de fin de signature envoyé **aux deux parties**.
- Re-téléchargeable par l'émetteur depuis la page signature (événement `EVIDENCE_EXPORTED`).

### Conservation

- Plus de suppression : archivage (`ARCHIVED`).
- Durée de conservation minimale : **5 ans** après la signature (prescription de droit commun, art. 2224 du Code civil).
- RGPD : IP, e-mails, noms et appareils sont chiffrés en base. Leur conservation est justifiée
  par la preuve du contrat (intérêt légitime / obligation légale).

---

## 8. Évolutions prévues

### Canaux OTP

| Canal | Intérêt | À prévoir |
|---|---|---|
| **SMS** | Second canal distinct de l'e-mail : renforce nettement l'AES | Fournisseur (Twilio, Vonage, Brevo SMS, OVH SMS) + saisie du numéro du cocontractant par l'émetteur |
| **Application d'authentification (TOTP)** | Pour l'émetteur déjà inscrit, réutilise la 2FA existante | Lier la 2FA du compte au parcours de signature |
| **Vérification d'identité (pièce d'identité + selfie)** | Identification forte, nécessaire pour viser la QES | Prestataire de vérification (Ubble, Onfido, IDnow) |
| **France Connect / identité numérique** | Identification forte et gratuite pour les particuliers en France | Habilitation France Connect |

### TSA payantes qualifiées eIDAS

Une TSA qualifiée figure sur la **liste de confiance européenne** (EU Trusted List).
Son horodatage bénéficie de la présomption d'exactitude de la date.

| Prestataire | Pays | Remarques |
|---|---|---|
| **Certigna** | France | QTSP français, offres d'horodatage à l'unité ou au forfait |
| **Universign** | France | Horodatage + signature qualifiée, API simple |
| **ChamberSign** | France | Lié aux CCI |
| **DigiCert / QuoVadis** | International | Offres eIDAS qualifiées |
| **GlobalSign** | International | TSA qualifiée eIDAS |
| **Sectigo** | International | TSA qualifiée eIDAS |

Changer de TSA = modifier `TSA_URL` (et ajouter l'authentification si le prestataire en demande une).

### Aller vers la QES

Passer par un QTSP (Universign, Yousign, Docusign EU…) pour délivrer un certificat qualifié
à chaque signataire. Le journal et le dossier de preuve restent utiles en complément.

---

## 9. Fichiers du back

| Fichier | Contenu |
|---|---|
| `src/services/classSignatureLog.ts` | `SignatureLog` : `record`, `getJournal`, `verifyChain`, `sealSignedDocument`, `timestampEnvelope`, `readFinalDocument`, `buildEvidencePackage` ; helpers `getRequestContext`, `sha256Hex`, `computeEventHash`, constante `INVITATION_VALIDITY_DAYS` |
| `src/services/classSignatureOtp.ts` | `SignatureOtp` : `send`, `verify` |
| `src/services/classSignatureEnvelope.ts` | Parcours complet (`create`, `signAsSender`, `openByToken`, `signByToken`, `finalize`, `archive`…) et `SignatureFlowError` |
| `src/route/apiSignature.ts` | Routes HTTP (voir §11) |
| `src/infrastructure/timestamp/tsaClient.ts` | Requête / réponse RFC 3161 (`requestTimestamp`) |
| `src/infrastructure/pdf/signatureCertificatePDF.ts` | Certificat de signature lisible (pdfkit) |
| `src/infrastructure/mailer/template/signatureOtp.ts` | E-mail du code + `Mailer.sendSignatureOtp` |

Variable d'environnement facultative : `TSA_URL` (FreeTSA par défaut).

### Ce qui est horodaté

`sealHash = SHA-256(finalDocumentHash + eventHash du dernier événement avant l'horodatage)`.
Ces valeurs figurent dans les `details` de l'événement `TIMESTAMP_OBTAINED`. Pour vérifier :
recalculer `sealHash`, puis `openssl ts -verify -digest <sealHash> -in horodatage.tsr -token_in -CAfile cacert.pem`
(certificat racine de la TSA).

## 10. Parcours de signature

```
Émetteur (connecté)                         Cocontractant (lien public)
───────────────────                         ───────────────────────────
POST /                → DRAFT
POST /:id/otp         → code par e-mail
POST /:id/sign        → émetteur signé,
  { code, consentAccepted }  invitation envoyée → SENT (expire à J+14)
                                            GET  /public/:token        → DOCUMENT_OPENED
                                            POST /public/:token/otp    → code par e-mail
                                            POST /public/:token        → SIGNED
                                              { fields, code, consentAccepted }
                                            (ou POST /public/:token/decline → DECLINED)
Clôture en arrière-plan : PDF figé → horodatage TSA → e-mail aux deux parties
(PDF signé + dossier de preuve ZIP)
GET /evidence/:id     → dossier de preuve (re-téléchargement)
DELETE /:id           → ARCHIVED (plus de suppression)
```

Règles de sécurité appliquées :
- Le cocontractant ne peut modifier **que la valeur** de ses propres champs : la signature
  de l'émetteur et la position des zones sont reprises de la base.
- Double envoi simultané : un seul passe (mise à jour conditionnée au statut `SENT`).
- Le crédit « signature » est vérifié à la création et décompté à l'envoi de l'invitation.
- Les enveloppes signées avant le journal n'ont ni PDF figé ni dossier de preuve
  (le PDF signé reste reconstruit à la volée pour elles).

## 11. Routes

| Méthode | Route (backNode, préfixe `/signature-envelope`) | Auth | Rôle |
|---|---|---|---|
| POST | `/` | oui | Crée l'enveloppe (DRAFT) |
| POST | `/:externalId/otp` | oui | Code OTP à l'émetteur |
| POST | `/:externalId/sign` | oui | Signature émetteur + envoi de l'invitation |
| GET | `/evidence/:externalId` | oui | Dossier de preuve (ZIP) |
| GET | `/download/:externalId` | oui | PDF signé |
| POST | `/resend` | oui | Relance (+14 jours) |
| DELETE | `/:externalId` | oui | Archivage |
| GET | `/public/:token` | non | Ouverture du lien |
| POST | `/public/:token/otp` | non | Code OTP au cocontractant |
| POST | `/public/:token` | non | Signature du cocontractant |
| POST | `/public/:token/decline` | non | Refus |
| GET | `/public/:token/download` | non | PDF signé |

Codes d'erreur renvoyés au front (`code`) : `CONSENT_REQUIRED`, `OTP_REQUIRED`,
`OTP_WRONG_CODE` (+ `attemptsLeft`), `OTP_EXPIRED`, `OTP_TOO_MANY_ATTEMPTS`, `OTP_NO_CODE`,
`TOO_SOON` (+ `retryAfterSeconds`), `TOO_MANY_SENDS`, `MAIL_FAILED`, `EXPIRED`, `QUOTA_EXCEEDED`.

Le proxy relaie ces routes et transmet le `user-agent` d'origine à backNode.

## 12. Front

| Fichier | Rôle |
|---|---|
| `front/.../signature/SigningOtpModal.tsx` | Modale commune : code reçu par e-mail + consentement + bouton « Signer » (renvoi du code après 60 s) |
| `front/.../signature/signingApi.ts` | `postSigningRequest` : appel POST JSON → `{ success, message, code, attemptsLeft, … }` |
| `front/.../signature/SignatureWizard.tsx` | « Envoyer » crée le brouillon puis ouvre la modale ; l'invitation part après le code |
| `front/.../signature/SignatureDashboard.tsx` + `EnvelopeTable.tsx` | Actions : confirmer ma signature (brouillon), télécharger le contrat signé, télécharger le dossier de preuve, archiver ; filtres Refusés / Expirés / Archivés |
| `front/src/page/SignerPage.tsx` | Page du cocontractant : modale de code, bouton « Refuser de signer », écrans « Lien expiré » / « Signature refusée » |

Remarque : en développement, React (StrictMode) charge la page deux fois, d'où deux
événements `DOCUMENT_OPENED` à l'ouverture. Ce n'est pas le cas en production.

## 13. Avancement

| Étape | État |
|---|---|
| 1. Recherche des données | ✅ |
| 2. Validation des propositions | ✅ |
| 3. Tables en base (`SignatureAuditEvent`, `SignatureOtp`, champs enveloppe) | ✅ |
| 4. Logique métier (`classSignatureLog`, `classSignatureOtp`, TSA, certificat) | ✅ |
| 5. Câblage au service signature | ✅ (testé de bout en bout sur la BDD de dev) |
| 6. Front | ✅ |
