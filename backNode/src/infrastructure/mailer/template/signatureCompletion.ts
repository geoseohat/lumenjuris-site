/**
 * Contenu de l'email de confirmation envoyé aux deux parties une fois le
 * document signé. Renvoie les lignes `<tr>` injectées dans le gabarit brandé
 * de la classe Mailer (header/footer ajoutés par `createHtmlFullContent`).
 */
export const templateSignatureCompletion = (opts: {
  recipientName: string;
  documentName: string;
  /** Nom (ou e-mail à défaut) du titulaire du compte émetteur. */
  selfLabel: string;
  /** E-mail du titulaire du compte à l'origine de la procédure. */
  selfEmail?: string;
  counterpartyName: string;
  counterpartyEmail?: string;
  signedDate: string;
  hasPdf: boolean;
  hasEvidence?: boolean;
}) => {
  const {
    recipientName, documentName, selfLabel, selfEmail,
    counterpartyName, counterpartyEmail, signedDate, hasPdf, hasEvidence,
  } = opts;

  return `
    <tr>
      <td style="padding: 40px 40px 0;">
        <p style="margin:0 0 10px; font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
                   font-size:11px; font-weight:600; color:#059669; letter-spacing:1.5px; text-transform:uppercase;">
          Document signé
        </p>
        <h1 style="margin:0 0 20px; font-family:'Newsreader',Georgia,'Times New Roman',serif;
                    font-size:28px; font-weight:400; color:#0A2540; line-height:1.25;">
          Bonjour ${recipientName ? `<span style="color:#2C3A5E;">${recipientName}</span>` : ""}
        </h1>
        <p style="margin:0 0 24px; font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
                   font-size:15px; line-height:1.7; color:#374151;">
          Le document <strong>«&nbsp;${documentName}&nbsp;»</strong> a été signé par les deux parties
          le <strong>${signedDate}</strong>.
        </p>
      </td>
    </tr>

    <tr>
      <td style="padding: 0 40px 24px;">
        <table width="100%" cellpadding="0" cellspacing="0"
               style="background-color:#d1fae5; border:1px solid #a7f3d0; border-radius:8px;">
          <tr>
            <td style="padding:16px 20px;">
              <p style="margin:0 0 8px; font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
                         font-size:13px; font-weight:700; color:#065f46;">
                Signataires
              </p>
              <p style="margin:0; font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
                         font-size:13px; color:#065f46; line-height:1.7;">
                &bull; <strong>${selfLabel}</strong> (émetteur)${selfEmail ? ` &mdash; ${selfEmail}` : ""}<br>
                &bull; <strong>${counterpartyName}</strong> (cocontractant)${counterpartyEmail ? ` &mdash; ${counterpartyEmail}` : ""}
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
${hasPdf
      ? `
    <tr>
      <td style="padding: 0 40px 32px;">
        <table width="100%" cellpadding="0" cellspacing="0"
               style="background-color:#f4f6fa; border:1px solid #e5e7eb; border-radius:8px;">
          <tr>
            <td style="padding:14px 18px;">
              <p style="margin:0; font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
                         font-size:13px; color:#4b5563; line-height:1.6;">
                Le document signé est joint en pièce jointe (PDF). Conservez-le comme preuve de signature.${hasEvidence ? `<br>Le dossier de preuve (ZIP) est également joint : il contient le certificat de signature, le journal horodaté et le document original.` : ""}
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>`
      : ""}
  `;
};
