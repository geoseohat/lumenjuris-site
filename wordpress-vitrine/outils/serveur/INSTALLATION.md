# Publication des modèles par le serveur o2switch – installation (une seule fois)

But : la routine du matin écrit le modèle sur GitHub, puis le serveur o2switch va le chercher
et le publie lui-même. La protection anti-robots n'intervient plus, et le PC peut rester éteint.

Durée : environ 15 minutes. Trois étapes.

## Étape 1 – Jeton GitHub en lecture seule (sur github.com)

1. Connecté au compte qui possède le dépôt `geoseohat/lumenjuris-site`, ouvrez
   https://github.com/settings/personal-access-tokens/new
2. **Token name** : `publication o2switch`
3. **Expiration** : la durée la plus longue proposée (notez la date pour le renouveler).
4. **Resource owner** : `geoseohat`
5. **Repository access** : « Only select repositories » → choisissez `lumenjuris-site`.
6. **Permissions** → **Repository permissions** → **Contents** : `Read-only`
   (rien d'autre ; « Metadata : Read-only » se coche tout seul).
7. **Generate token**, puis copiez le jeton (il commence par `github_pat_`).
   Ne le collez nulle part ailleurs qu'à l'étape 2.

## Étape 2 – Deux fichiers sur le serveur (cPanel → Gestionnaire de fichiers)

1. Ouvrez le **Gestionnaire de fichiers**. Restez dans le dossier de base `/home/dxin1098`
   (surtout **pas** dans `public_html`).
2. **+ Dossier** → nom : `publication-lumenjuris` → ouvrez-le.
3. **+ Fichier** → nom : `publication-lumenjuris.php` → clic droit → **Edit** (Modifier) →
   collez tout le contenu de
   https://github.com/geoseohat/lumenjuris-site/blob/claude/modeles-contrat/wordpress-vitrine/outils/serveur/publication-lumenjuris.php
   (bouton « Copy raw file » en haut à droite du fichier) → **Save Changes**.
4. **+ Fichier** → nom : `reglages.php` → **Edit** → collez :

   ```php
   <?php
   return [
       'jeton_github' => 'COLLER_LE_JETON_ICI',
       'wordpress' => '',
   ];
   ```

   Remplacez `COLLER_LE_JETON_ICI` par le jeton de l'étape 1 (gardez les apostrophes) → **Save Changes**.
5. Clic droit sur `reglages.php` → **Change Permissions** → `600`.

## Étape 3 – Tâche programmée (cPanel → Tâches Cron / Cron Jobs)

1. **Paramètre commun** : « Toutes les 15 minutes » (`*/15 * * * *`).
2. **Commande** :

   ```
   /usr/local/bin/php /home/dxin1098/publication-lumenjuris/publication-lumenjuris.php >> /home/dxin1098/publication-lumenjuris/journal.txt 2>&1
   ```

3. **Ajouter une nouvelle tâche Cron**.

## Vérifier

Après 15 minutes, dans le dossier `publication-lumenjuris` :
- `dernier-passage.txt` doit dire « OK : GitHub lisible » ;
- `journal.txt` raconte ce qui a été publié (ou l'erreur).

Si `journal.txt` dit « wp-load.php introuvable », indiquez dans `reglages.php` le dossier
de WordPress, par exemple `'wordpress' => '/home/dxin1098/public_html',`.

## Ce que le serveur fait, et ne fait pas

- Il exécute seulement les ordres de `wordpress-vitrine/modeles-contrat/ordres/` :
  envoi des fichiers Word/PDF/image, pages modèles, bibliothèque, réglages Rank Math de ces pages.
- Avant de modifier une page, il la sauvegarde dans `publication-lumenjuris/sauvegardes/`.
- Le jeton GitHub ne permet que de lire le dépôt, rien d'autre.
- Pour tout arrêter : supprimer la tâche Cron.
