<?php
// Réglages de la publication par le serveur. À copier sous le nom « reglages.php »
// à côté de publication-lumenjuris.php (hors de public_html), puis compléter.
return [
    // Jeton GitHub en LECTURE SEULE (Fine-grained token, dépôt lumenjuris-site, « Contents : Read-only »).
    'jeton_github' => 'COLLER_LE_JETON_ICI',

    // Laisser vide sauf si le script ne trouve pas WordPress tout seul
    // (exemple : '/home/dxin1098/public_html').
    'wordpress' => '',
];
