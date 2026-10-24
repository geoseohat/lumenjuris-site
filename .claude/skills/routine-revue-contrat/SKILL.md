---
name: routine-revue-contrat
description: Produire les guides de revue contractuelle du jour (4 par passage par défaut) pour www.lumenjuris.com, rangés sous la page « Révision contractuelle IA » (/revision-contractuelle-ia/guide-revue-contrat/) : comment relire un contrat ou une clause, points de vigilance, clauses à risque, grille de revue gratuite en Word et PDF, bouton « Analyser mon contrat » vers l'application. Chemin le plus court (preparer → rédiger → controler → relire → publier → terminer), avec les règles qui évitent les sanctions Google et les règles juridiques maison. À utiliser pour la routine d'analyse et de revue contractuelle, pour traiter la prochaine ligne de revues-contrat/mots-cles.txt, ou dès qu'il faut rédiger un guide de revue de contrat ou de clause pour le site vitrine. Pour les modèles de contrat, voir routine-modele-contrat.
---

# Guides de revue contractuelle du jour

Même routine que celle des modèles de contrat (`routine-modele-contrat`), pour un autre type de page : au lieu d'un
contrat à remplir, la page aide le lecteur à **relire** un contrat ou une clause qu'on lui propose, et lui donne
une **grille de revue** à télécharger. Le bouton « Analyser mon contrat » mène à l'outil d'analyse et de revue de
l'application (app.lumenjuris.com/conformite).

Tout le reste (environnement, choix du sujet, doublons, Word, PDF, image, publication, journal) est fait par
`outils/revues_contrat.py`. Ouvrez les références seulement en cas de doute :
- `references/doublons.md` : sujets déjà jugés en doublon (lu aussi par `preparer`) ;
- `../routine-modele-contrat/references/regles-qualite.md` : sanctions Google, ce qu'on a le droit d'écrire ;
- `../routine-modele-contrat/references/sources-legifrance.md` : liens Légifrance vérifiés, textes de base.

Travaillez depuis `wordpress-vitrine/`, sur la branche `claude/modeles-contrat`. Les adresses des pages :
`https://www.lumenjuris.com/revision-contractuelle-ia/guide-revue-contrat/<slug>/`.

## Combien de guides par passage

**4 guides par passage**, sauf si les instructions de la routine fixent un autre nombre (ligne `NOMBRE : n`).
Traitez-les l'un après l'autre : étapes 1 à 8 en entier pour un guide (jusqu'au `git push`), puis retour à
l'étape 1 pour le suivant. Ne préparez jamais plusieurs dossiers à la fois. Chaque guide garde la même qualité
que s'il était le seul du jour : mieux vaut 3 bons guides que 4 dont un bâclé.

Arrêtez la série avant le nombre prévu si `preparer` répond « Liste de mots-clés vide », si un guide reste bloqué
(erreur du contrôle impossible à corriger, navigateur introuvable : laissez-le tel quel, il sera repris au passage
suivant) ou si `preparer` affiche « ordre … en ERREUR ». Un `ecarter` ne compte pas dans le nombre.

## Les étapes

1. **Préparer** : `python outils/revues_contrat.py preparer`.
   Prend la première ligne non cochée de `revues-contrat/mots-cles.txt`, crée `revues-contrat/<slug>/` prérempli
   (`fiche.json`, `article.html`, `grille.txt`) et affiche les pages proches : autres guides **et** modèles de
   contrat. Reprend le guide d'un passage interrompu. « Liste de mots-clés vide » : arrêtez-vous et dites-le.

2. **Une page doit-elle exister ?** Suivez la décision d'un « DOUBLON CONNU ». Sinon, regardez les pages proches :
   - un **guide** sur le même document ou la même clause et pour le même usage : écartez ;
   - un **modèle de contrat** sur le même contrat : le guide se justifie, car la recherche est différente
     (« modèle de bail commercial » pour rédiger, « vérifier un bail commercial » pour relire celui qu'on reçoit).
     Il doit alors parler de ce qu'on vérifie dans le contrat de l'autre partie, pas répéter la page modèle.
   Pour écarter : `python outils/revues_contrat.py ecarter "même intention que <slug> : <explication courte>"`,
   ajoutez la ligne dans `references/doublons.md`, puis revenez à l'étape 1. Écartez aussi un sujet trop risqué
   pour un guide général, en l'expliquant.

3. **Rédiger** les trois fichiers en remplaçant chaque « À COMPLÉTER » (voir « Rédaction »).

4. **Contrôler** : `python outils/revues_contrat.py controler <slug>`, puis corrigez jusqu'à 0 erreur.
   Le contrôle compare aussi le texte aux modèles de contrat : réécrivez toute phrase signalée « déjà présente ».

5. **Relire en juriste** la liste « À relire » (voir « Relecture juridique »).

6. **Publier** selon le mode des instructions de la routine :
   - MODE NORMAL : `python outils/revues_contrat.py publier <slug> --en-ligne --sans-relecture`
   - MODE TEST : `python outils/revues_contrat.py publier <slug>` (brouillon)

   Jamais `--forcer`, jamais d'envoi direct au site (API REST, curl) : la commande écrit un « ordre » dans
   `modeles-contrat/ordres/`, que le serveur o2switch exécute (c'est le même dossier que pour les modèles : c'est
   normal, le serveur ne lit que celui-là). La première publication crée aussi la page
   « Guides de revue contractuelle » sous /revision-contractuelle-ia/.

7. **Terminer** : `python outils/revues_contrat.py terminer <slug> --mode normal` (ou `--mode test`).

8. **Enregistrer** :
   `git add wordpress-vitrine/revues-contrat wordpress-vitrine/modeles-contrat/ordres && git commit -m "Guide de revue du jour : <nom>" && git push origin claude/modeles-contrat`
   (en cas d'erreur réseau, réessayez jusqu'à 4 fois en attendant 2, 4, 8 puis 16 s). Le serveur publie dans les
   5 minutes. Les vérifications en ligne sont affichées par l'étape 1 suivante : reportez-les dans le rapport.
   Puis reprenez à l'étape 1 pour le guide suivant, tant que le nombre du passage n'est pas atteint.

## Rédaction

La mise en page, les boutons, la grille affichée, l'encart auteur, le fil d'Ariane et les micro-données sont
produits par l'outil. Dans `article.html`, utilisez seulement `<h2 id>`, `<p>`, `<ul>`, `<ul class="lj-clauses">`,
`<strong>` et le tableau `<div class="lj-table-wrap"><table class="lj-table">`. Ids réservés : `grille`, `etapes`,
`faq`, `auteur`, `associes`, `modele`.

**grille.txt** : la grille de revue, utilisable telle quelle en relisant le contrat. Syntaxe : `# ` titre,
`## ` rubrique, `- ` point à vérifier, `> ` note. Au moins 5 rubriques et 20 points. Chaque point est une
question fermée et précise (« La durée du préavis est-elle indiquée en jours ou en mois ? »), pas un conseil vague
(« Vérifiez les clauses importantes »). Signalez par une note `>` les points où la loi impose une règle
(mention obligatoire, clause interdite, plafond légal).

**article.html** : 900 à 1 600 mots, au moins six sections `<h2 id="…">`, au moins un tableau. Le lecteur a un
contrat ou une clause sous les yeux et se demande s'il peut signer : chaque section répond à une vraie question
sur CE sujet. Apportez au moins trois éléments qu'une page générique n'a pas : règles impératives et ce qu'elles
rendent nul ou « réputé non écrit », clauses fréquentes à risque avec leur version équilibrée, exemple concret de
clause et de reformulation (présenté comme un exemple), points négociables et façon de les demander, signaux qui
imposent une relecture par un professionnel. Phrases courtes, vouvoiement, pas de jargon inutile. Une phrase au
plus sur l'outil d'analyse dans l'article : la page doit être utile sans lui.

**fiche.json** :
- `titre_h1` : ce que la page apprend, par exemple « Clause pénale : comment la vérifier avant de signer ».
- `titre_seo` (65 caractères au plus) et `meta_description` (120 à 160) propres à cette page ; l'année du titre est
  celle de `date_mise_a_jour`. `mot_cle` : la recherche principale (la ligne de la liste, en général).
- `categorie` : une de celles proposées par `preparer` si possible.
- `mots_cles_secondaires` : 3 à 8 recherches réellement tapées (« clause pénale excessive », « clause pénale
  contrat de travail »…). Elles disent aussi quelles recherches la page couvre déjà : pas de « modèle de … ».
- `modeles_lies` : 0 à 3 slugs de modèles de contrat du site en lien avec le sujet (liste proposée par
  `preparer`) ; ils apparaissent dans « Pour aller plus loin ». Liste vide permise.
- `etapes` : 5 étapes de relecture propres à ce sujet. `faq` : 6 à 8 questions réellement posées, réponses exactes
  de 2 à 4 phrases, aucune copiée d'une autre page.
- `sources` : articles précis dans le libellé, lien vers le texte entier (jamais `LEGIARTI`, jamais
  d'identifiant inventé).
- `analyser.sujet` : quelques mots transmis à l'application (laissez la valeur préremplie si elle convient).
- `relecture.valide` reste `false`.

## Ce qu'on n'écrit jamais

- « avocat », sous aucune forme (REFERENTIEL-LEGAL.md).
- Une relecture humaine qui n'a pas eu lieu (« relu par notre juriste »).
- Une promesse sur l'analyse : « l'IA détecte toutes les clauses à risque », « analyse garantie », « sans risque ».
  L'outil aide à repérer des points de vigilance ; il ne garantit rien.
- Un chiffre invérifiable ou une promesse absolue (« 100 % conforme »). Les seuils et délais légaux exacts sont permis.
- Un conseil personnalisé (« dans votre cas, signez ») : la page informe, l'encart le rappelle déjà.
- Une affirmation qu'une clause est « toujours nulle » ou « toujours valable » quand les juges apprécient au cas
  par cas : dites-le (« le juge peut… », « est en principe… »).

## Relecture juridique

Comme pour les modèles :
1. Chaque article de loi cité : numéro ET contenu certains, sinon vérifiez par une recherche web (5 au plus) ou
   reformulez sans numéro.
2. Chiffres et délais : ceux de la loi en vigueur aujourd'hui.
3. La qualification annoncée est-elle juste ? Clause « nulle », « réputée non écrite », « réductible par le juge »,
   « inopposable » : ce ne sont pas les mêmes effets. En cas de doute, décrivez l'effet sans le nommer.
4. Distinguez bien les régimes : entre professionnels (Code civil, Code de commerce), avec un consommateur (Code de
   la consommation), salarié (Code du travail), locataire (loi de 1989). Une règle d'un régime appliquée à un autre
   est une erreur grave.
5. Jurisprudence : citez-la seulement si vous êtes certain de la date et de la chambre, sinon décrivez la règle
   (« les juges exigent… »).

Si un doute sérieux subsiste, retirez ou reformulez. Sujet trop risqué pour un guide général : `ecarter`.

## Rapport final

Court, en français simple, pour Geoff (il n'est pas développeur), un seul rapport pour tout le passage :
- le nombre de guides publiés sur le nombre prévu, et la raison s'il en manque ;
- pour chaque guide, son adresse (active dans les 5 minutes), ou le lien d'aperçu en mode TEST ;
- pour chaque guide, les deux ou trois passages juridiques à relire en priorité ;
- les vérifications du passage précédent, affichées par `preparer` ;
- tout problème rencontré, et ce qui dépend de lui ;
- pour retirer une page : `python outils/revues_contrat.py retirer <slug>` (depuis `wordpress-vitrine`).

## En cas de problème

- « navigateur INTROUVABLE » : PDF et image impossibles, ne publiez pas, signalez-le.
- Erreur du contrôle impossible à corriger : ne forcez pas, ne cochez rien, expliquez ; `preparer` reprendra ce guide.
- « ordre … en ERREUR » : recopiez le message dans le rapport (détail dans `journal.txt` du dossier
  `publication-lumenjuris` du serveur, cPanel). Un ordre en erreur bloque aussi ceux des modèles de contrat :
  signalez-le en tête du rapport.
