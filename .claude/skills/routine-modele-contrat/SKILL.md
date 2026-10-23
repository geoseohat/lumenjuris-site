---
name: routine-modele-contrat
description: Produire le « modèle de contrat du jour » pour www.lumenjuris.com par le chemin le plus court (preparer → rédiger → controler → relire → publier → terminer), avec les règles qui évitent les sanctions Google (contenu dupliqué, deux pages pour la même recherche, affirmations trompeuses) et les règles juridiques maison. À utiliser pour la routine quotidienne, pour traiter la prochaine ligne de modeles-contrat/mots-cles.txt, ou dès qu'il faut rédiger un nouveau modèle de contrat pour le site vitrine, même si la demande ne cite pas la routine. Pour retirer, corriger ou republier une page existante, voir publier-modele-contrat.
---

# Modèle de contrat du jour

Le temps doit aller à la rédaction et à la relecture juridique. Tout le reste (environnement, choix du
contrat, doublons, fichiers Word et PDF, publication, journal) est fait par `outils/modeles_contrat.py`.
Inutile de lire les autres modèles ou l'ancienne compétence : le dossier prérempli et cette page suffisent.
Ouvrez les deux références seulement en cas de doute :
- `references/regles-qualite.md` : pourquoi et comment éviter d'être sanctionné par Google, et ce qu'on a le droit d'écrire ;
- `references/sources-legifrance.md` : liens Légifrance déjà vérifiés, textes de base par famille de contrats, doublons connus de la liste.

Travaillez depuis `wordpress-vitrine/`, sur la branche `claude/modeles-contrat`.

## Les étapes

1. **Préparer** : `python outils/modeles_contrat.py preparer`.
   La commande installe Word si besoin, relit ce que le serveur a publié, prend la première ligne non cochée de
   `modeles-contrat/mots-cles.txt` (les doublons exacts sont cochés tout seuls), crée `modeles-contrat/<slug>/`
   prérempli et affiche les pages existantes proches. Si un passage précédent a été interrompu, elle reprend ce
   contrat. Si elle répond « Liste de mots-clés vide », arrêtez-vous et dites-le.

2. **Une page doit-elle exister ?** Si `preparer` affiche « DOUBLON CONNU » avec la décision « écarter », suivez-la.
   Sinon, regardez les « pages existantes proches » (voir « Une page par recherche » plus bas). Si le document et
   l'usage sont les mêmes qu'une page existante :
   `python outils/modeles_contrat.py ecarter "même intention que <slug> : <explication courte>"`, puis revenez à l'étape 1.
   Faites de même si le contrat est trop risqué pour un modèle générique, en l'expliquant. Un seul contrat publié
   par passage : après un `ecarter`, le contrat suivant devient celui du jour.

3. **Rédiger** les trois fichiers du dossier en remplaçant chaque « À COMPLÉTER » (voir « Rédaction »).

4. **Contrôler** : `python outils/modeles_contrat.py controler <slug>`, puis corrigez jusqu'à 0 erreur.
   Réécrivez aussi les phrases signalées « déjà présente sur une autre page ».

5. **Relire en juriste** la liste « À relire » affichée par le contrôle (voir « Relecture juridique »).

6. **Publier** selon le mode indiqué dans les instructions de la routine :
   - MODE NORMAL : `python outils/modeles_contrat.py publier <slug> --en-ligne --sans-relecture`
   - MODE TEST : `python outils/modeles_contrat.py publier <slug>` (brouillon)

   La commande refait le contrôle, fabrique Word, PDF et image, puis écrit un « ordre » que le serveur o2switch
   exécutera. N'utilisez jamais `--forcer` dans la routine : une erreur du contrôle se corrige, ou se signale.
   Ne tentez jamais d'envoyer directement au site (API REST, curl) : la protection o2switch le refuse depuis le
   16 octobre 2026, c'est la raison d'être des ordres.

7. **Terminer** : `python outils/modeles_contrat.py terminer <slug> --mode normal` (ou `--mode test`).
   La commande coche la ligne de `mots-cles.txt` et écrit `journal-routine.txt`.

8. **Enregistrer** :
   `git add wordpress-vitrine/modeles-contrat && git commit -m "Modèle du jour : <nom>" && git push origin claude/modeles-contrat`
   (en cas d'erreur réseau, réessayez jusqu'à 4 fois en attendant 2, 4, 8 puis 16 s). Le serveur publie dans les
   5 minutes qui suivent l'envoi. Les vérifications en ligne (page accessible, micro-données, plan du site) sont
   faites par l'étape 1 du passage suivant, qui les affiche : reportez-les dans le rapport du jour.

## Une page par recherche

Google sanctionne les sites qui publient plusieurs pages presque identiques pour la même recherche (« doorway
abuse ») ou beaucoup de pages sans valeur propre (« scaled content abuse »). La sanction touche tout le site,
pas seulement la page fautive. Avant d'écrire, posez-vous deux questions :
- quelqu'un qui tape ce mot-clé veut-il le même document qu'une page existante ?
- la nouvelle page apporterait-elle des règles, des choix ou des pièges vraiment différents ?

« Contrat de conseil » et « contrat de consulting », c'est le même document : écartez le second. « Promesse de
cession de parts » et « contrat de cession de parts », ce sont deux actes différents : les deux pages se
justifient, avec des angles distincts. La liste des doublons déjà repérés est dans `references/sources-legifrance.md`.
Les `mots_cles_secondaires` de chaque fiche servent aussi à cela : ils disent quelles recherches la page couvre déjà.

## Rédaction

La mise en page, les boutons, l'encart auteur, le fil d'Ariane et les micro-données sont produits par l'outil :
n'ajoutez ni style, ni script, ni balise de mise en page. Dans `article.html`, utilisez seulement `<h2 id>`,
`<p>`, `<ul>`, `<ul class="lj-clauses">`, `<strong>` et le tableau `<div class="lj-table-wrap"><table class="lj-table">`.

**modele.txt** : le contrat lui-même, complet, en droit français en vigueur, équilibré entre les parties.
Syntaxe : `# ` titre, `## ARTICLE n – TITRE`, `### ` sous-article, `- ` liste, `> Note de rédaction : …`,
`> Option : …`, `[champ à compléter]`. Mettez les parties, toutes les clauses que la loi impose pour ce contrat,
les options courantes, la signature et les annexes utiles. Le texte doit pouvoir être signé tel quel une fois
les crochets remplis.

**article.html** : 900 à 1 600 mots, au moins six sections `<h2 id="…">` et au moins un tableau. Chaque titre
répond à une vraie question sur CE contrat : évitez les intitulés passe-partout repris d'une page à l'autre.
Apportez au moins trois éléments qu'un lecteur ne trouve pas sur une page générique : mentions obligatoires,
délais légaux, tableau de choix (« ceci ou cela ? »), pièges propres à ce contrat, exemple concret présenté
comme un exemple. Phrases courtes, vouvoiement, pas de jargon inutile.

**fiche.json** :
- `titre_seo` de 65 caractères au plus et `meta_description` de 120 à 160 caractères, propres à cette page.
  L'année du titre est celle de `date_mise_a_jour`.
- `categorie` : une catégorie existante si possible, affichée par `preparer`.
- `public` : à qui s'adresse le modèle (ex. « Employeurs et salariés »).
- `mots_cles_secondaires` : 3 à 8 recherches réellement tapées pour ce document.
- `etapes` : 5 étapes propres à ce contrat (pas « Téléchargez le modèle »).
- `faq` : 6 à 8 questions que les gens posent vraiment, avec une réponse exacte de 2 à 4 phrases.
  Pas de question copiée d'une autre page.
- `sources` : des articles précis dans le libellé, mais un lien vers le texte entier (liste vérifiée dans
  `references/sources-legifrance.md`). Jamais de lien vers un article (`LEGIARTI`), jamais d'identifiant inventé.
- `relecture.valide` reste `false` : seule la juriste peut le passer à `true`, avec `valider <slug>`.

## Ce qu'on n'écrit jamais

- « avocat », sous aucune forme : il n'y a pas d'avocat dans l'équipe (REFERENTIEL-LEGAL.md).
- Une relecture humaine qui n'a pas eu lieu (« relu par notre juriste », « validé par un expert ») : c'est faux
  tant que `relecture.valide` est `false`, trompeur pour le lecteur, et sanctionnable (pratique commerciale trompeuse).
- Un chiffre invérifiable (« 80 % des entreprises… », « des milliers d'utilisateurs ») ou une promesse absolue
  (« 100 % conforme », « sans risque »). Les seuils et délais fixés par la loi sont permis s'ils sont exacts.
- Un conseil personnalisé : la page informe et fournit un modèle. Le rappel « ne remplace pas un conseil
  personnalisé » est déjà dans l'encart.
- Le bouton s'appelle « Personnaliser », jamais « Personnaliser en ligne ».

Le contrôle détecte la plupart de ces cas, mais pas tous : relisez avec ces règles en tête.

## Relecture juridique

Relisez comme un juriste exigeant, avec la liste « À relire » du contrôle :
1. Pour chaque article de loi cité, êtes-vous certain du numéro ET de ce qu'il dit ? Sinon, vérifiez par une
   recherche web (`article L. 1242-12 code du travail`, par exemple ; 5 recherches au plus), ou reformulez la
   règle sans numéro. Un numéro faux coûte plus cher qu'une phrase sans numéro.
2. Les chiffres et délais affichés sont-ils ceux de la loi en vigueur aujourd'hui ?
3. Les règles impératives sont-elles respectées : mentions obligatoires, clauses interdites, dispositions
   protectrices du salarié, du consommateur ou du locataire ? Une clause illicite dans un modèle se retrouve
   dans des centaines de contrats.
4. Les options sont-elles équilibrées ? Aucune clause ne doit avantager une partie au point d'être déséquilibrée.

Si un doute sérieux subsiste, retirez ou reformulez le passage. Si le contrat est trop risqué pour un modèle
générique (enjeu financier ou pénal fort, cas presque toujours sur mesure), ne publiez pas : utilisez `ecarter`
et expliquez pourquoi dans le rapport.

## Rapport final

Court, en français simple, pour Geoff (il n'est pas développeur) :
- le contrat et son adresse, en précisant qu'elle sera active dans les 5 minutes, ou le lien d'aperçu en mode TEST ;
- ce qu'il peut relire en priorité (les deux ou trois passages juridiques les plus délicats) ;
- les vérifications du passage précédent, affichées par `preparer` ;
- tout problème rencontré, et ce qui dépend de lui ;
- pour retirer la page : `python outils/modeles_contrat.py retirer <slug>` (depuis `wordpress-vitrine`).

## En cas de problème

- « navigateur INTROUVABLE » à l'étape 1 : PDF et image impossibles. Ne publiez pas, signalez-le.
- Erreur du contrôle impossible à corriger : ne forcez pas. Laissez le dossier tel quel, ne cochez rien, et
  expliquez le blocage. `preparer` reprendra ce contrat au prochain passage.
- `preparer` affiche « ordre … en ERREUR » : le serveur n'a pas pu publier. Recopiez le message dans le rapport.
  Le détail est dans `journal.txt` du dossier `publication-lumenjuris` du serveur (cPanel).
