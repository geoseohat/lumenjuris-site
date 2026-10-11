import { Request, Response, NextFunction } from "express";
import { prisma } from "../../prisma/singletonPrisma.js";
import { truncate } from "node:fs";



export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const rawUserId = req.headers["x-user-id"] as string | undefined;
  if (!rawUserId) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  const userId = Number(rawUserId);
  if (isNaN(userId)) {
    return res.status(400).json({success: false, message:"Invalid User ID"});
  }

  try {
    const user = await prisma.user.findUnique({
      where: { idUser: Number(userId) },
      select: { isBanned: true, idUser: true },
    });

    if (!user) {
      return res.status(401).json({success: false, message: "Utilisateur introuvable"});
    }

    if (user.isBanned) {
      return res.status(403).json({
        success: false,
        message: "Votre compte a été suspendu. Contactez l'administrateur.",
        banned: true,
      });
    }
   

    await prisma.user.update({
      where : { idUser : userId},
      data : {
        lastConnected : new Date()
      }
    })

    req.idUser = String(userId);
    req.role = (req.headers["x-user-role"] as string) || "USER";
  } catch (err) {
    console.error("[authMiddleware] ban check error:", err);
    return res.status(500).json({success: false, message: "Erreur serveur"});
  }
  next();
}

export function authMiddlewareAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  void authMiddleware(req, res, () => {
    if (req.role !== "ADMIN") {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    next();
  });
}
