-- DropForeignKey
ALTER TABLE `signatureenvelope` DROP FOREIGN KEY `SignatureEnvelope_userId_fkey`;

-- AlterTable
ALTER TABLE `signatureenvelope` ADD COLUMN `archivedAt` DATETIME(3) NULL,
    ADD COLUMN `expiresAt` DATETIME(3) NULL,
    ADD COLUMN `finalDocumentHash` VARCHAR(191) NULL,
    ADD COLUMN `finalDocumentPath` VARCHAR(191) NULL,
    ADD COLUMN `finalTimestampToken` MEDIUMBLOB NULL,
    ADD COLUMN `finalTimestampedAt` DATETIME(3) NULL,
    ADD COLUMN `originalDocumentHash` VARCHAR(191) NULL,
    MODIFY `status` ENUM('DRAFT', 'SENT', 'PARTIALLY_SIGNED', 'SIGNED', 'DECLINED', 'EXPIRED', 'ARCHIVED') NOT NULL DEFAULT 'DRAFT',
    MODIFY `userId` INTEGER NULL;

-- CreateTable
CREATE TABLE `SignatureAuditEvent` (
    `idEvent` INTEGER NOT NULL AUTO_INCREMENT,
    `externalId` VARCHAR(191) NOT NULL,
    `sequence` INTEGER NOT NULL,
    `eventType` ENUM('ENVELOPE_CREATED', 'DOCUMENT_HASHED', 'INVITE_SENT', 'INVITE_RESENT', 'DOCUMENT_OPENED', 'DOCUMENT_VIEWED', 'CONSENT_ACCEPTED', 'OTP_SENT', 'OTP_VERIFIED', 'OTP_FAILED', 'SIGNATURE_APPLIED', 'SIGNER_COMPLETED', 'ENVELOPE_COMPLETED', 'SIGNED_DOCUMENT_SEALED', 'TIMESTAMP_OBTAINED', 'SIGNED_DOCUMENT_DOWNLOADED', 'EVIDENCE_EXPORTED', 'DECLINED', 'EXPIRED', 'ENVELOPE_ARCHIVED') NOT NULL,
    `actorRole` ENUM('SENDER', 'COUNTERPARTY', 'SYSTEM') NOT NULL,
    `actorName` TEXT NULL,
    `actorEmail` TEXT NULL,
    `ipAddress` TEXT NULL,
    `userAgent` TEXT NULL,
    `details` JSON NULL,
    `occurredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `documentHash` VARCHAR(191) NULL,
    `previousHash` VARCHAR(191) NULL,
    `eventHash` VARCHAR(191) NOT NULL,
    `envelopeId` INTEGER NOT NULL,

    UNIQUE INDEX `SignatureAuditEvent_externalId_key`(`externalId`),
    UNIQUE INDEX `SignatureAuditEvent_eventHash_key`(`eventHash`),
    INDEX `SignatureAuditEvent_envelopeId_idx`(`envelopeId`),
    UNIQUE INDEX `SignatureAuditEvent_envelopeId_sequence_key`(`envelopeId`, `sequence`),
    PRIMARY KEY (`idEvent`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SignatureOtp` (
    `idOtp` INTEGER NOT NULL AUTO_INCREMENT,
    `signerRole` ENUM('SENDER', 'COUNTERPARTY', 'SYSTEM') NOT NULL,
    `codeHash` VARCHAR(191) NOT NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `expiresAt` DATETIME(3) NOT NULL,
    `usedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `envelopeId` INTEGER NOT NULL,

    INDEX `SignatureOtp_envelopeId_signerRole_idx`(`envelopeId`, `signerRole`),
    PRIMARY KEY (`idOtp`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `SignatureEnvelope` ADD CONSTRAINT `SignatureEnvelope_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`idUser`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SignatureAuditEvent` ADD CONSTRAINT `SignatureAuditEvent_envelopeId_fkey` FOREIGN KEY (`envelopeId`) REFERENCES `SignatureEnvelope`(`idEnvelope`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SignatureOtp` ADD CONSTRAINT `SignatureOtp_envelopeId_fkey` FOREIGN KEY (`envelopeId`) REFERENCES `SignatureEnvelope`(`idEnvelope`) ON DELETE RESTRICT ON UPDATE CASCADE;
