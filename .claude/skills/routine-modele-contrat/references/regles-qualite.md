# Règles qualité : Google, honnêteté, droit

À lire en cas de doute pendant la rédaction. Chaque règle dit pourquoi elle existe : quand une situation n'est
pas prévue, c'est la raison qui tranche.

## 1. Ce que Google sanctionne, et pourquoi c'est un risque ici

Les pages juridiques sont classées par Google parmi les sujets « Your Money or Your Life » : une erreur peut
coûter cher au lecteur. Google y regarde de plus près la fiabilité de la page et de son auteur (critères
« E-E-A-T » : expérience, expertise, autorité, fiabilité).

Publier un modèle par jour, préparé avec l'aide d'une IA, n'est pas interdit en soi. Google sanctionne ce qui est
produit en série surtout pour se classer, quel que soit l'outil :
- **Scaled content abuse** : beaucoup de pages qui n'apportent rien de propre (texte générique, paragraphes
  repris d'une page à l'autre en changeant le nom du contrat).
- **Doorway abuse** : plusieurs pages proches visant chacune une variante de la même recherche.
- **Keyword stuffing** : répéter le mot-clé au-delà du naturel.
- **Données structurées trompeuses** : annoncer dans le code ce que la page ne montre pas (avis, relecture…).

La sanction peut toucher tout le site, pas seulement la page fautive : c'est pourquoi le contrôle bloque.

Sources : https://developers.google.com/search/docs/essentials/spam-policies ,
https://developers.google.com/search/docs/fundamentals/creating-helpful-content ,
https://developers.google.com/search/blog/2024/03/core-update-spam-policies

### Ce qui rend une page utile (et donc durable)

Une page mérite d'exister si un lecteur y trouve ce qu'il ne trouve pas ailleurs sur le site. Pour un modèle
de contrat, cela veut dire au moins trois de ces éléments, propres au contrat traité :
- les mentions que la loi rend obligatoires, et la sanction si elles manquent ;
- les délais et seuils légaux (période d'essai, préavis, rétractation, durée maximale…) ;
- un tableau qui aide à choisir : ce contrat ou un autre ? quelle option ? quelle durée ?
- les pièges réels de ce contrat (requalification, nullité, clause réputée non écrite…) ;
- un exemple concret, présenté comme tel (« Exemple : … »), sans chiffre présenté comme une statistique ;
- les cas où le modèle ne suffit pas.

Le contrôle mesure la part de texte reprise d'une autre page : au-delà de 20 %, il refuse ; à partir de 10 %, il
avertit. Les étapes et les FAQ comptent aussi : n'y recopiez pas les formules des autres pages.

### Titres et description

- `titre_seo` de 65 caractères au plus : au-delà, Google coupe. Une seule fois le mot-clé, formulé naturellement.
- `meta_description` de 120 à 160 caractères, qui dit ce que contient le modèle et pour qui. Unique sur le site.
- L'année dans le titre doit être celle de la dernière mise à jour réelle. Ne changez jamais une date sans avoir
  réellement revu la page : Google considère qu'une fausse fraîcheur est trompeuse.

### Cadence

Une page par passage, jamais plusieurs d'un coup : une publication régulière de pages soignées passe bien, une
rafale de pages semblables ressemble à de la production en série.

## 2. Honnêteté : ce que la page affirme doit être vrai

Le site affiche un encart « L'équipe juridique de Lumen Juris ». Tant que la juriste n'a pas relu un modèle
(`relecture.valide` à `false`), l'outil écrit seulement que le modèle est rédigé à partir des textes en vigueur.
Dans le texte que vous rédigez, ne prétendez pas le contraire. Une fausse relecture est :
- une **pratique commerciale trompeuse** au sens du Code de la consommation ;
- un signal de non-fiabilité pour Google, d'autant plus grave sur un sujet juridique ;
- contraire aux règles du site (REFERENTIEL-LEGAL.md : n'affirmer que ce qui est vérifié).

Concrètement, sont interdits tant que la relecture n'a pas eu lieu : « relu par notre juriste », « validé par nos
experts », « conçu par des professionnels du droit », etc. Le mot « avocat » est interdit dans tous les cas :
aucun avocat ne fait partie de l'équipe.

Quand la juriste a réellement relu un modèle, lancez `python outils/modeles_contrat.py valider <slug>`, puis
republiez la page. L'encart et les micro-données annoncent alors la relecture et sa date.

## 3. Droit : informer, pas conseiller

- La page donne une information générale et un modèle. Le conseil juridique personnalisé est réservé à certaines
  professions : n'écrivez jamais « dans votre cas, faites… ». Préférez « si vous êtes dans telle situation, la loi
  prévoit… » ou « faites relire ».
- Pas de chiffre invérifiable ni de promesse absolue (« 100 % conforme », « inattaquable », « sans risque »).
- Un modèle générique ne doit contenir aucune clause illicite. Les points les plus fréquents à vérifier :
  - salarié : clause de non-concurrence sans contrepartie financière, sanction pécuniaire, renonciation à un droit légal ;
  - consommateur : clause qui figure dans les listes de clauses abusives du Code de la consommation, renonciation au
    droit de rétractation quand il s'applique, clause attributive de juridiction ;
  - entre professionnels : déséquilibre significatif, pénalités de retard et indemnité de recouvrement obligatoires
    dans les conditions de paiement ;
  - locataire d'habitation : clauses réputées non écrites de la loi du 6 juillet 1989 ;
  - partout : clause pénale manifestement excessive, clause qui vide l'obligation essentielle de sa substance.
- En cas de doute sérieux sur une règle, retirez ou reformulez. Si le contrat est trop risqué pour un modèle
  générique, écartez-le et expliquez pourquoi.

## 4. Ce que vérifie le contrôle automatique (`controler`)

Erreurs bloquantes : restes « À COMPLÉTER » ; champs manquants ; titre ou description trop longs ; nombre
d'étapes (5) ou de questions de FAQ (6 à 8) ; moins de 2 sources ; lien de source qui n'est pas un texte entier ;
pas de tableau ; un `<h1>` ; moins de 5 sections ; id réservé ; article trop court ; contrat incomplet ; mot
« avocat » ; statistiques, superlatifs commerciaux, promesses de conformité ; relecture affirmée à tort ; plus de
20 % de texte repris d'une autre page ; titre, description ou mot-clé principal identiques à une autre page.

Avertissements : longueurs hors des fourchettes conseillées ; identifiant Légifrance non vérifié ; code cité sans
source ; phrase ou question déjà présente ailleurs ; mot-clé trop répété ; année du titre différente de la mise à jour.

Il ne vérifie pas le fond du droit : la relecture juridique reste indispensable.
