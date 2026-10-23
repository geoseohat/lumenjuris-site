---
name: publier-modele-contrat
description: Créer et publier une page « Modèle de contrat » sur le site vitrine www.lumenjuris.com (WordPress) à partir d'un mot-clé — texte du contrat, contenu SEO avec tableau, FAQ, micro-données complètes, fichiers Word et PDF gratuits, bouton « Personnaliser » vers le formulaire de l'application, bibliothèque « Modèles juridiques gratuits » et modèles associés mis à jour automatiquement. À utiliser dès que Geoff donne un mot-clé ou un type de contrat (« fais la page modèle CGV », « modèle statuts SAS », « publie le pacte d'associés », « ajoute un modèle de contrat »), ou veut mettre en ligne, modifier ou retirer une page modèle. Pas pour mettre en ligne l'application app.lumenjuris.com (compétence mise-en-ligne-beta).
---

# Pages « Modèle de contrat » – www.lumenjuris.com

Projet : dossier `wordpress-vitrine/` du dépôt (sur le PC : `C:\Users\geoff\Documents\LumenJuris\Nouveau - 06-06-2026\wordpress-vitrine\`).
Outil : `outils/modeles_contrat.py` (utilise `outils/wp_api.py`). Accès WordPress : `config.txt` à la racine du dépôt sur le PC ; dans la routine cloud, variables `WP_USER` et `WP_APP_PASSWORD`.
Modèles : `modeles-contrat/<slug>/` — **référence à copier : `modeles-contrat/pacte-d-associes/`**.

## Organisation des pages (décidée par Geoff le 25 sept 2026)
- Bibliothèque « Modèles juridiques gratuits » (page 2930) rangée sous « Outil génération contrat IA » (page 2630) :
  `https://www.lumenjuris.com/outil-generation-contrat-ia/modele-contrat/` puis
  `https://www.lumenjuris.com/outil-generation-contrat-ia/modele-contrat/<slug>/`.
- Fil d'Ariane = celui de **Rank Math**, jamais un fil maison : **Générateur de contrat IA › Modèles juridiques gratuits › <Nom>**.
  Le lien d'accueil est masqué dans Rank Math pour tout le site, la page 2630 a le nom court « Générateur de contrat IA », et chaque modèle reçoit son nom court (`rank_math_breadcrumb_title` = `nom` de la fiche, réglé par l'outil).

## Bouton « Personnaliser »
Lien de la forme : `https://app.lumenjuris.com/contrat-generation?section=scratch&titre=<titre>&de=hub` (ex. `titre=prestation+de+service`).
- `<titre>` = nom court sans « contrat de/d' » en tête, calculé par l'outil ; le forcer dans `fiche.json` → `"personnaliser": {"titre": "…"}` si besoin.
- Les deux boutons (Personnaliser / Télécharger) ont la même taille et le même style.

## Mise en page validée par Geoff
Titre (affiché par le thème) → « Mis à jour le … » → fil d'Ariane → chapeau → sommaire → titre « Le modèle de … » → encadré du modèle avec en tête **« Personnaliser » à gauche** et **« Télécharger » à droite** (petit picto, menu Word / PDF) → contenu → « Comment remplir le modèle en 5 étapes » → FAQ → encart auteur → sources → « Modèles associés ».
- Pas d'encadré « Pour qui / Quand / Format / Prix », pas de bloc « Pas le temps de tout remplir », pas de lien « Voir tous les modèles ».
- **Au moins un tableau obligatoire** dans `article.html` (l'outil refuse sinon).
- Encart auteur : **« L'équipe juridique de Lumen Juris »**, icône balance, **ni photo ni nom de personne**. Ne jamais écrire « avocats » (voir `REFERENTIEL-LEGAL.md`). Le texte de l'encart n'annonce une relecture que si `relecture.valide` est vrai (commande `valider <slug>`, à lancer seulement quand la juriste a réellement relu) ; sinon il dit seulement que le modèle est rédigé à partir des textes en vigueur (23 oct. 2026 : l'ancien texte « rédigés et relus par notre équipe juridique » était inexact sur les pages non relues).
- Police 15 px, colonne de lecture centrée de 760 px (titre compris), espace de 72 px avant le pied de page.
- Page la plus rapide possible : pas d'Elementor, un seul bloc HTML, aucun JavaScript, style compacté dans la page (≈ 1 Ko compressé : plus rapide qu'un fichier séparé).
- **Utiliser ce que le site fournit déjà, ne rien doubler** : vérifier d'abord si Rank Math, le thème ou WordPress proposent l'élément.

## Micro-données (générées automatiquement)
WebPage, DigitalDocument (offre gratuite, fichiers Word/PDF, actions Télécharger et Personnaliser, lois citées), Article, HowTo (5 étapes), FAQPage, auteur « équipe juridique » (Organization rattachée à Lumen Juris), ImageObject. Rank Math ajoute Organization, WebSite et BreadcrumbList ; son « Article » est désactivé sur ces pages. Bibliothèque : CollectionPage + ItemList.
Image de partage 1200 x 630 générée et posée en « image à la une ».
Pas d'étoiles d'avis ni de fiche « produit » (interdit ou trompeur pour Google).

## Méthode pour un nouveau mot-clé
**Chemin court (recommandé, routine comprise)** : suivre la compétence `routine-modele-contrat` (`preparer` → rédaction → `controler` → `publier` → `terminer`). La méthode détaillée ci-dessous reste valable pour un travail à la main. Dans tous les cas, `publier` refuse une page qui ne passe pas le contrôle qualité (`python outils/modeles_contrat.py controler <slug>`).

1. **Slug** en minuscules sans accents (`conditions-generales-de-vente`). Vérifier qu'il n'existe pas : `python outils/modeles_contrat.py liste`.
2. **Créer `modeles-contrat/<slug>/`** avec 3 fichiers, sur le modèle du pacte d'associés :
   - `fiche.json` : mêmes champs. `mot_cle` = requête principale (« modèle … »), `titre_seo` ≈ 60 caractères, `meta_description` ≤ 160, 5 étapes, 6 à 8 questions de FAQ réellement posées, sources = articles de loi précis avec lien vers le code entier sur Légifrance (liens `LEGITEXT` ; ne jamais inventer un identifiant d'article). `relecture.valide` = **false** au départ.
   - `modele.txt` : contrat en droit français en vigueur. Syntaxe : `# ` titre, `## ` article, `### ` sous-article, `- ` liste, `> ` note de rédaction/option, `[champ à compléter]`.
   - `article.html` : sections `<h2 id="…">` (définition, **tableau comparatif**, clauses clés, cas particuliers, erreurs fréquentes, quand faire relire). Pas de chiffre invérifiable.
3. **Construire et regarder** : `python outils/modeles_contrat.py construire <slug>` → Word, PDF, image, `sortie/apercu.html`. Aperçu local : serveur « Aperçus modèles de contrat (statique) » (port 8124), puis `http://localhost:8124/<slug>/sortie/apercu.html`. L'en-tête du site et les images peuvent manquer dans les captures automatiques (protection anti-robots o2switch, erreur 429) : normal.
4. **Brouillon sur le site** : `python outils/modeles_contrat.py publier <slug>`. Sauvegarde l'ancienne version dans `modeles-contrat/_sauvegardes/`, envoie Word/PDF/image seulement s'ils ont changé, règle titre, description et nom court dans Rank Math. Donner à Geoff le lien d'aperçu (visible s'il est connecté à WordPress) et lui envoyer le PDF.
5. **Mise en ligne, seulement avec le feu vert explicite de Geoff** et après validation juridique interne : dans `fiche.json`, `relecture.valide: true` et `date_validation: "AAAA-MM-JJ"`, puis `python outils/modeles_contrat.py publier <slug> --en-ligne`. Publie aussi la bibliothèque, met à jour les « modèles associés » des autres pages et vérifie la page en ligne.
6. **Retour arrière** (à donner à Geoff) : `python outils/modeles_contrat.py retirer <slug>` → la page repasse en brouillon, bibliothèque et autres pages mises à jour.
7. Après une mise en ligne : proposer le test des résultats enrichis de Google (https://search.google.com/test/rich-results) et PageSpeed Insights, et vérifier le fil d'Ariane réel.

## Routine quotidienne
Routine cloud quotidienne (branche `claude/modeles-contrat`, que le PC soit allumé ou non ; l'ancienne tâche locale « modele-contrat-quotidien » reste désactivée pour éviter les doublons) : **suit la compétence `routine-modele-contrat`** (processus court, règles anti-sanction Google, doublons connus de la liste). Elle prend la première ligne non cochée de `modeles-contrat/mots-cles.txt`, crée la page et la **met en ligne directement** avec `--en-ligne --sans-relecture` (choix de Geoff, 25 sept 2026 ; ni la page ni les micro-données n'annoncent alors de relecture), coche la ligne, écrit dans `modeles-contrat/journal-routine.txt`. Une mise en ligne ne régénère que les pages dont les « modèles associés » changent, plus, une fois, les pages dont le gabarit est ancien (constante `GABARIT` de l'outil). Google : la page entre dans le plan du site (`page-sitemap.xml`) suivi par la Search Console ; Rank Math la signale à Bing par IndexNow. Pas d'envoi direct officiel à Google.

### Publication par le serveur (depuis le 23 oct. 2026)
Depuis le 16 oct. 2026, la protection anti-robots d'o2switch (Tiger Protect, « Sécurité par défaut d'o2switch ») répond « Security check » (503/307) à tout envoi venant du cloud : API REST, curl, etc. Les lectures passent. Aucun réglage de Tiger Protect ne permet d'exclure `/wp-json/` ; Geoff ne veut pas dépendre du support o2switch.
- Dans la routine (variables `WP_USER` / `WP_APP_PASSWORD`), `publier` et `retirer` n'envoient rien : ils écrivent un **ordre** dans `modeles-contrat/ordres/` (repères `{{ordre.oN.champ}}` à la place des numéros pas encore connus). Il suffit de pousser la branche.
- Sur le serveur, `outils/serveur/publication-lumenjuris.php` (tâche cron du cPanel toutes les 15 min, dossier `/home/dxin1098/publication-lumenjuris/` hors de public_html) lit les ordres sur GitHub avec un jeton en lecture seule et les exécute dans WordPress, sans passer par Internet. Il sauvegarde chaque page avant de la modifier, reprend là où il s'est arrêté en cas d'erreur (3 essais) et publie son compte rendu dans `wp-content/uploads/lumenjuris-publication/resultats.json`.
- Au passage suivant, la routine lance `python outils/modeles_contrat.py synchroniser` (fait automatiquement par `publier`, `retirer` et `liste`) : numéros réels dans `etat.json`, ordre terminé supprimé, vérifications en ligne.
- Installation : `outils/serveur/INSTALLATION.md`. Ne jamais réessayer l'envoi direct depuis le cloud. Sur le PC, l'envoi direct reste possible (`config.txt`) ; `PUBLICATION_DIRECTE=1` le force.

## Pièges connus
- Trop de requêtes rapprochées → o2switch bloque (HTTP 429). Espacer les envois.
- Le thème affiche le titre WordPress en H1 : pas de `<h1>` dans le contenu.
- Les fichiers Word/PDF/image sont publics dès l'envoi, même si la page est en brouillon. Un nouvel envoi crée un fichier suffixé `-1`, `-2` : ne supprimer les anciens qu'avec l'accord de Geoff (suppression définitive).
- Changer l'adresse d'une page (slug ou parent) change le pied de page des fichiers : ils sont renvoyés.
- PDF et image sont produits par un navigateur sans fenêtre : Edge sur le PC, Chrome/Chromium dans le cloud (variable `NAVIGATEUR` pour forcer un chemin). En cas d'échec, vérifier `EDGE` dans l'outil.
- La routine cloud enregistre son travail (`mots-cles.txt`, `etat.json`, journal, dossier du modèle) sur la branche `claude/modeles-contrat` : la récupérer avant de travailler sur les modèles depuis le PC.
- Via l'API, le fil d'Ariane d'un brouillon n'affiche que le premier maillon : c'est normal, il est complet sur la vraie page.
- `modeles-contrat/etat.json` garde les numéros de pages et de fichiers : ne pas le supprimer.
- Réglages Rank Math sauvegardés avant modification dans `sauvegardes/2026-09-25-rankmath/`.

## Parler à Geoff
Il n'est pas développeur : dire ce qui change sur le site, ce qu'il doit relire et ce qui dépend de lui, de la juriste ou de son collègue. Pas de jargon (« brouillon », « micro-données » est son mot).
