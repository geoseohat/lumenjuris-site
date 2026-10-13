import nodemailer, { type SendMailOptions } from "nodemailer";

import { templateVerifyAccount } from "./template/verifyAccount.js";
import { templateResetPassword } from "./template/resetPassword.js";
import { templateTwoFactor } from "./template/twoFactor.js";
import { templateVerifyAccountCode } from "./template/verifyAccountCode.js";
import { templateInvoiceEmail } from "./template/invoiceEmail.js";
import { templateWelcomeFreemium } from "./template/welcomeFreemium.js";
import { templateSignatureInvite } from "./template/signatureInvite.js";
import { templateSignatureCompletion } from "./template/signatureCompletion.js";
import { templateSignatureOtp } from "./template/signatureOtp.js";
import { templateExportData } from "./template/userData.js";
import { templateDeleteAccount } from "./template/deleteAccount.js";
import { templatePaymentFailed } from "./template/paymentFailed.js";

import { generateInvoicePDF, type InvoiceData } from "../pdf/invoicePDF.js";
import { logger } from "../../logger/logger.js";
import { templateWelcomeBetatesteur } from "./template/welcomeBetatesteur.js";


export type MailAttachment = {
  filename: string;
  content: Buffer;
  contentType: string;
};

export type MailExtraOptions = {
  cc?: string;
  replyTo?: string;
  attachments?: MailAttachment[];
};

export type MailResult = {
  success: boolean;
  message?: string;
  error?: unknown;
};


// Serveur d'envoi configurable. Valeurs par defaut : la messagerie o2switch,
// comportement inchange si rien n'est precise. Les rendre parametrables permet
// de basculer vers un service d'envoi dedie (reputation propre, journal de
// remise) sans toucher au code : trois lignes dans le .env suffisent.
const MAILER_HOST = process.env.MAILER_HOST || "mail.lumenjuris.com";
const MAILER_PORT = Number(process.env.MAILER_PORT || 465);

/** Adresse affichee comme expediteur. Doit appartenir au domaine authentifie. */
const MAILER_FROM = process.env.MAILER_FROM || '"Lumen Juris" <no-reply@lumenjuris.com>';

const transporter = nodemailer.createTransport({
  host: MAILER_HOST,
  port: MAILER_PORT,
  // 465 = canal chiffre des la connexion ; 587 = chiffrement negocie ensuite,
  // port standard des services d'envoi dedies.
  secure: MAILER_PORT === 465,

  pool: true,
  maxConnections: 5,
  maxMessages: Infinity,

  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 10_000,

  auth: {
    user: process.env.MAILER_USER_O2S,
    pass: process.env.MAILER_PASS_O2S,
  },
});



export class Mailer {
  private readonly email: string;

  constructor(email: string) {
    if (!process.env.MAILER_USER_O2S || !process.env.MAILER_PASS_O2S) {
      throw new Error("Configuration SMTP manquante");
    }

    this.email = email;
  }


  static async initTransporter(): Promise<void> {
    try {
      await transporter.verify();
      console.log("Transporteur envoi email SMTP prêt.");
      logger.info("Vérification du transporter SMTP");
    } catch (err) {
      // Un SMTP indisponible ne doit jamais empêcher le serveur de démarrer :
      // seules les fonctionnalités d'e-mail sont dégradées.
      console.error("Erreur lors de la vérification du transporteur SMTP, error:", err);
      logger.error("Erreur lors de la vérification du transporteur", err);
    }
  }

  /** Conservé pour compatibilité avec les appels existants. */
  async initTransporter(): Promise<void> {
    return Mailer.initTransporter();
  }

  private errorCatching(err: unknown): MailResult {
    console.error(`Une erreur est survenue lors de l'envoi d'un email : ${err}`);
    logger.error("Une erreur est survenue lors de l'envoi d'un email", err);

    return {
      success: false,
      message: "Une erreur serveur est survenue lors de l'envoi d'un e-mail.",
      error: err,
    };
  }


  private createOption(
    html: string,
    subject: string,
    extra: MailExtraOptions = {},
  ): SendMailOptions {
    const textBrutFallback = html.replace(/<[^>]*>/g, "");

    return {
      from: MAILER_FROM,
      to: this.email,
      ...(extra.cc ? { cc: extra.cc } : {}),
      ...(extra.replyTo ? { replyTo: extra.replyTo } : {}),
      subject,
      text: textBrutFallback,
      html,
      ...(extra.attachments?.length ? { attachments: extra.attachments } : {}),
    };
  }

  /**
   * Envoi centralisé : gestion du messageId manquant et des erreurs.
   */
  private async send(
    mailOptions: SendMailOptions,
    successMessage?: string,
  ): Promise<MailResult> {
    
    try {
      const debut = Date.now();
      console.log("Envoie d'email en cours, début le :", debut)
      const sending = await transporter.sendMail(mailOptions);
      if (!sending.messageId) {
        console.log("Echec lors de l'envoie de l'email, pas d'id dans le sendMail")
        throw new Error(
          `Échec lors de l'envoi de l'email "${mailOptions.subject}" : messageId indisponible.`,
        );
      }

      // Les envois partent en arrière-plan : sans trace du succès, un e-mail
      // qui n'arrive pas ne permet pas de distinguer un envoi jamais tenté d'un
      // message accepté par le serveur puis perdu en route (spam, file
      // d'attente de l'hébergeur). `accepted`/`rejected` viennent du serveur.
      logger.info("Email envoyé", {
        sujet: mailOptions.subject,
        destinataire: this.email,
        messageId: sending.messageId,
        accepte: sending.accepted,
        refuse: sending.rejected,
        reponseServeur: sending.response,
        dureeMs: Date.now() - debut,
      });

      const timeProcess = Date.now() - debut
      console.log(`Email envoyé avec succès à ${this.email}, durée du process : `, timeProcess)
      return { success: true, message: successMessage };
    } catch (err) {
      return this.errorCatching(err);
    }
  }


  private createHtmlHeader(): string {
    // Charte : navy profond + un filet doré discret comme signe de qualité.
    // Le filet or fin en haut de l'en-tête sombre est la signature « qualité »
    // de la marque, à utiliser avec parcimonie (jamais en aplat).
/*     <tr>
      <td style="height:4px; line-height:4px; font-size:0; background-color:#D6B266;">&nbsp;</td>
    </tr> */
    return `
      <tr>
        <td style="background-color:#0A2540; padding:26px 40px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td width="34" style="width:34px; padding-right:10px;" valign="middle">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="26" height="26" aria-label="Lumen Juris" role="img" style="display:block;">
                  <circle cx="16" cy="16" r="13" fill="none" stroke="#2563EB" stroke-width="2"></circle>
                  <circle cx="16" cy="16" r="4.5" fill="#2563EB"></circle>
                </svg>
              </td>
              <td valign="middle" style="font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif; font-size:20px; letter-spacing:-0.3px; white-space:nowrap;">
                <span style="font-weight:700; color:#FFFFFF;">Lumen</span><span style="font-weight:400; color:#8FA9CE;"> Juris</span>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    `;
  }

  private createHtmlFooter(): string {
    const year = new Date().getFullYear();

    return `
      <tr>
        <td style="padding:32px 40px 24px; font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
                   font-size:14px; line-height:1.6; color:#374151;">
          Cordialement,<br>
          <strong style="color:#111827;">L'équipe Lumen Juris</strong>
        </td>
      </tr>

      <tr>
        <td style="background-color:#f4f6fa; padding:24px 40px; border-top:1px solid #e5e7eb;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="text-align:center; padding-bottom:12px;">
                <a href="https://lumenjuris.com"
                   style="color:#2563EB; text-decoration:none; font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
                          font-size:13px; font-weight:600;">
                  lumenjuris.com
                </a>
                <span style="color:#c7ced9; font-size:13px; padding:0 10px;">&middot;</span>
                <a href="mailto:contact@lumenjuris.com"
                   style="color:#6b7280; text-decoration:none; font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
                          font-size:13px;">
                  contact@lumenjuris.com
                </a>
              </td>
            </tr>
            <tr>
              <td style="text-align:center;">
                <span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
                             font-size:11px; color:#9ca3af;">
                  &copy; ${year} Lumen Juris — Tous droits réservés.
                </span>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    `;
  }

  private createHtmlFullContent(htmlContent: string): string {
    // Polices de la charte : Inter (corps/UI) et Newsreader (titres éditoriaux).
    // Les clients mail modernes (Apple Mail, iOS) chargent ces polices Google ;
    // les autres retombent proprement sur Georgia (serif) et les polices système.
    return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Newsreader:wght@400;500&display=swap" rel="stylesheet">
</head>
<body style="margin:0; padding:0; background-color:#f4f6fa;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f6fa; padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0"
               style="max-width:600px; width:100%; background-color:#ffffff;
                      border-radius:16px; overflow:hidden;
                      box-shadow:0 18px 40px -28px rgba(16,24,40,0.35), 0 1px 3px rgba(16,24,40,0.06);">
          ${this.createHtmlHeader()}
          ${htmlContent}
          ${this.createHtmlFooter()}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }


  //Ancienne version d'activation vers url backend
  async sendVerifyAccount(
    verificationLink: string,
    username: string,
  ): Promise<MailResult> {
    const html = this.createHtmlFullContent(
      templateVerifyAccount(verificationLink, username),
    );

    return this.send(
      this.createOption(html, "Activez votre compte Lumen Juris"),
      `Un email a été envoyé à votre adresse ${this.email}, veuillez consulter votre boîte de réception pour valider votre inscription.`,
    );
  }


  //Verification de compte par code
  async sendVerifyAccountCode(
    code: string,
    username?: string,
  ): Promise<MailResult> {
    const html = this.createHtmlFullContent(
      templateVerifyAccountCode(code, username),
    );

    return this.send(
      this.createOption(html, "Votre code pour activer le compte Lumen Juris"),
      `Un code d'activation a été envoyé à ${this.email}. Il est valide 15 minutes.`,
    );
  }

  async sendResetPassword(
    resetLink: string,
    username?: string,
  ): Promise<MailResult> {
    const html = this.createHtmlFullContent(
      templateResetPassword(resetLink, username),
    );

    return this.send(
      this.createOption(
        html,
        "Réinitialisation de votre mot de passe Lumen Juris",
      ),
      `Un email a été envoyé à votre adresse ${this.email}, veuillez consulter votre boîte de réception pour réinitialiser votre mot de passe.`,
    );
  }

  async sendDeleteAccount(
    confirmationLink: string,
    username?: string,
  ): Promise<MailResult> {
    const html = this.createHtmlFullContent(
      templateDeleteAccount(confirmationLink, username),
    );

    return this.send(
      this.createOption(html, "Suppression de votre compte"),
      `Un email a été envoyé à votre adresse ${this.email}, veuillez consulter votre boîte de réception pour confirmer la suppression de votre compte.`,
    );
  }

  async sendTwoFactor(code: string, username?: string): Promise<MailResult> {
    const html = this.createHtmlFullContent(templateTwoFactor(code, username));

    return this.send(
      this.createOption(html, "Votre code de vérification Lumen Juris"),
      `Un code de vérification a été envoyé à ${this.email}. Il est valide 15 minutes.`,
    );
  }

  async sendWelcomeFreemium(username?: string): Promise<MailResult> {
    const html = this.createHtmlFullContent(templateWelcomeFreemium(username));

    return this.send(
      this.createOption(
        html,
        "Bienvenue sur Lumen Juris",
      ),
    );
  }

  async sendUserData(fullExport: unknown, username?: string): Promise<MailResult> {
    try {
      const html = this.createHtmlFullContent(templateExportData(username));
      const jsonString = JSON.stringify(fullExport, null, 2);

      const mailOptions = this.createOption(
        html,
        "Lumen Juris - Vos données utilisateurs",
        {
          attachments: [
            {
              filename: "export-data.json",
              content: Buffer.from(jsonString, "utf-8"),
              contentType: "application/json",
            },
          ],
        },
      );

      return this.send(
        mailOptions,
        `Vos données ont été envoyées à ${this.email}.`,
      );
    } catch (err) {
      return this.errorCatching(err);
    }
  }

  async sendInvoice(
    invoiceData: InvoiceData,
    username?: string,
  ): Promise<MailResult> {
    try {
      const pdfBuffer = await generateInvoicePDF(invoiceData);
      const html = this.createHtmlFullContent(
        templateInvoiceEmail(invoiceData, username),
      );

      const mailOptions = this.createOption(
        html,
        `Votre facture Lumen Juris — ${invoiceData.invoiceNumber}`,
        {
          attachments: [
            {
              filename: `facture-${invoiceData.invoiceNumber}.pdf`,
              content: pdfBuffer,
              contentType: "application/pdf",
            },
          ],
        },
      );

      return this.send(
        mailOptions,
        `La facture ${invoiceData.invoiceNumber} a été envoyée à ${this.email}.`,
      );
    } catch (err) {
      return this.errorCatching(err);
    }
  }

  /**
   * Informe l'utilisateur qu'un paiement d'abonnement a échoué. Stripe retente
   * automatiquement : l'email invite à vérifier le moyen de paiement pour éviter
   * une rétrogradation. `manageBillingUrl` pointe vers l'espace de gestion.
   */
  async sendPaymentFailed(opts: {
    username?: string;
    planName: string;
    amountCents: number;
    manageBillingUrl: string;
  }): Promise<MailResult> {
    const html = this.createHtmlFullContent(templatePaymentFailed(opts));

    return this.send(
      this.createOption(html, "Échec de paiement — action requise"),
      `Un email d'information sur l'échec de paiement a été envoyé à ${this.email}.`,
    );
  }

  /**
   * Invitation à signer un document (envoyée au cocontractant).
   * `cc` permet de mettre l'émetteur en copie.
   */
  async sendSignatureInvite(opts: {
    counterpartyName: string;
    documentName: string;
    signingLink: string;
    cc?: string;
    /** Nom du titulaire du compte à l'origine de la procédure. */
    senderName?: string;
    /**
     * E-mail du titulaire du compte à l'origine de la procédure. Affiché dans
     * l'e-mail et utilisé comme adresse de réponse : le cocontractant
     * s'adresse à l'utilisateur réel, jamais à une adresse d'administration.
     */
    senderEmail?: string;
    /** Vrai quand il s'agit d'une relance et non du premier envoi. */
    isReminder?: boolean;
  }): Promise<MailResult> {
    const html = this.createHtmlFullContent(
      templateSignatureInvite({
        counterpartyName: opts.counterpartyName,
        documentName: opts.documentName,
        signingLink: opts.signingLink,
        ...(opts.senderName ? { senderName: opts.senderName } : {}),
        ...(opts.senderEmail ? { senderEmail: opts.senderEmail } : {}),
        ...(opts.isReminder ? { isReminder: true } : {}),
      }),
    );

    const subject = opts.isReminder
      ? `Rappel — document à signer : ${opts.documentName}`
      : `Document à signer — ${opts.documentName}`;

    return this.send(
      this.createOption(html, subject, {
        ...(opts.cc ? { cc: opts.cc } : {}),
        ...(opts.senderEmail ? { replyTo: opts.senderEmail } : {}),
      }),
      `Une invitation à signer a été envoyée à ${this.email}.`,
    );
  }


  // Envoyé quand un admin passe un utilisateur au plan Betatesteur (monitoring)
  async sendNewBetaTesteur(username?: string, expiresAt?: Date): Promise<MailResult> {
    const html = this.createHtmlFullContent(
      templateWelcomeBetatesteur(username, expiresAt),
    );

    return this.send(
      this.createOption(
        html,
        "Lumen Juris - Votre accès bêta-testeur est activé",
      ),
    );
  }

  /**
   * Code à usage unique demandé avant de signer (émetteur comme cocontractant).
   */
  async sendSignatureOtp(opts: {
    code: string;
    documentName: string;
    validityMinutes: number;
    recipientName?: string;
  }): Promise<MailResult> {
    const html = this.createHtmlFullContent(templateSignatureOtp(opts));

    return this.send(
      this.createOption(html, `Votre code de signature — ${opts.documentName}`),
      `Un code de signature a été envoyé à ${this.email}.`,
    );
  }

  /**
   * Confirmation envoyée à une partie une fois le document signé par les deux
   * parties. Le PDF signé peut être joint (`pdf`).
   */
  async sendSignatureCompletion(opts: {
    recipientName: string;
    documentName: string;
    selfLabel: string;
    /** E-mail du titulaire du compte émetteur (affiché dans le récapitulatif). */
    selfEmail?: string;
    counterpartyName: string;
    counterpartyEmail?: string;
    signedDate?: Date;
    pdf?: { filename: string; content: Buffer };
  }): Promise<MailResult> {
    const dateStr = (opts.signedDate ?? new Date()).toLocaleDateString("fr-FR", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });

    const html = this.createHtmlFullContent(
      templateSignatureCompletion({
        recipientName: opts.recipientName,
        documentName: opts.documentName,
        selfLabel: opts.selfLabel,
        ...(opts.selfEmail ? { selfEmail: opts.selfEmail } : {}),
        counterpartyName: opts.counterpartyName,
        ...(opts.counterpartyEmail ? { counterpartyEmail: opts.counterpartyEmail } : {}),
        signedDate: dateStr,
        hasPdf: !!opts.pdf,
      }),
    );

    const attachments: MailAttachment[] | undefined = opts.pdf
      ? [
          {
            filename: opts.pdf.filename,
            content: opts.pdf.content,
            contentType: "application/pdf",
          },
        ]
      : undefined;

    return this.send(
      this.createOption(html, `Document signé — ${opts.documentName}`, {
        ...(attachments ? { attachments } : {}),
        ...(opts.selfEmail ? { replyTo: opts.selfEmail } : {}),
      }),
      `La confirmation de signature a été envoyée à ${this.email}.`,
    );
  }
}