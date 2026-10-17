/** Échappe le texte saisi par l'utilisateur avant de l'insérer dans le HTML. */
const escapeHtml = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Code à usage unique demandé avant de signer un document. */
export const templateSignatureOtp = (opts: {
  code: string;
  documentName: string;
  validityMinutes: number;
  recipientName?: string;
}) => {
  return `
    <tr>
      <td style="padding: 40px 40px 0;">
        <p style="margin:0 0 10px; font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
                   font-size:11px; font-weight:600; color:#2C3A5E; letter-spacing:1.5px; text-transform:uppercase;">
          Signature électronique
        </p>
        <h1 style="margin:0 0 20px; font-family:'Newsreader',Georgia,'Times New Roman',serif;
                    font-size:28px; font-weight:400; color:#0A2540; line-height:1.25;">
          Votre code de signature
        </h1>
        <p style="margin:0 0 32px; font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
                   font-size:15px; line-height:1.7; color:#374151;">
          Bonjour${opts.recipientName ? ` <strong>${escapeHtml(opts.recipientName)}</strong>` : ""},<br>
          Saisissez le code ci-dessous pour confirmer votre identité et signer le document
          <strong>${escapeHtml(opts.documentName)}</strong>.
        </p>
      </td>
    </tr>

    <tr>
      <td style="padding: 0 40px 32px;">
        <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;">
          <tr>
            <td align="center"
                style="background-color:#eef1fa; border:1.5px solid #2C3A5E; border-radius:12px; padding: 28px 40px;">
              <p style="margin:0 0 8px; font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
                         font-size:11px; font-weight:600; color:#6b7280; letter-spacing:2px; text-transform:uppercase;">
                Code de signature
              </p>
              <span style="font-family:'Courier New','Lucida Console',monospace; font-size:42px;
                            font-weight:700; letter-spacing:12px; color:#0A2540; display:block;">
                ${opts.code}
              </span>
              <p style="margin:12px 0 0; font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
                         font-size:12px; color:#6b7280;">
                Valide pendant <strong style="color:#2C3A5E;">${opts.validityMinutes} minutes</strong>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <tr>
      <td style="padding: 0 40px 32px;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding:14px 18px; background-color:#fee2e2; border-left:3px solid #dc2626;
                        border-radius:0 6px 6px 0;">
              <p style="margin:0; font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
                         font-size:12px; color:#991b1b; line-height:1.6;">
                <strong>Ne communiquez jamais ce code.</strong> Il vaut signature de votre part.
                Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail : aucun document ne sera signé.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  `;
};
