<?php
/**
 * Publication des modèles de contrat par le serveur o2switch.
 *
 * Pourquoi : depuis le 16 oct. 2026, la protection anti-robots d'o2switch (Tiger Protect)
 * refuse les envois venant de la routine cloud. La routine écrit donc des « ordres » dans
 * wordpress-vitrine/modeles-contrat/ordres/ sur GitHub ; ce script, lancé par une tâche
 * programmée du cPanel, les récupère et les exécute directement dans WordPress, sans passer
 * par Internet (donc sans Tiger Protect).
 *
 * Installation (une fois) : copier ce fichier et reglages.php dans un dossier HORS de
 * public_html (ex. /home/<compte>/publication-lumenjuris/), puis tâche cron :
 *   /usr/local/bin/php /home/<compte>/publication-lumenjuris/publication-lumenjuris.php >> /home/<compte>/publication-lumenjuris/journal.txt 2>&1
 *
 * Ce script ne fait que ce que décrivent les ordres : envoi des fichiers Word/PDF/image,
 * création ou mise à jour des pages modèles, de la bibliothèque et des réglages Rank Math
 * de ces pages. Chaque page est sauvegardée (dossier sauvegardes/) avant modification.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit;
}

$DIR = __DIR__;
$REGLAGES = array_merge([
    'jeton_github'   => '',
    'depot'          => 'geoseohat/lumenjuris-site',
    'branche'        => 'claude/modeles-contrat',
    'dossier_ordres' => 'wordpress-vitrine/modeles-contrat/ordres',
    'site'           => 'www.lumenjuris.com',
    'wordpress'      => '',   // dossier contenant wp-load.php (vide = recherche automatique)
    'utilisateur_wp' => '',   // identifiant WordPress (vide = premier administrateur)
    'essais_max'     => 3,
], is_file("$DIR/reglages.php") ? (array) require "$DIR/reglages.php" : []);

function journal($message)
{
    echo '[' . date('Y-m-d H:i:s') . '] ' . $message . "\n";
}

// Un seul passage à la fois (la tâche peut être lancée toutes les 15 minutes).
$verrou = fopen("$DIR/.verrou", 'c');
if (!$verrou || !flock($verrou, LOCK_EX | LOCK_NB)) {
    exit;
}

function github($chemin, $brut = false)
{
    global $REGLAGES;
    if (!empty($REGLAGES['depot_local'])) {  // essais : copie locale du dépôt au lieu de GitHub
        $p = $REGLAGES['depot_local'] . '/' . $chemin;
        if (is_dir($p)) {
            return array_map(function ($n) use ($chemin) {
                return ['type' => 'file', 'name' => $n, 'path' => "$chemin/$n"];
            }, array_values(array_diff(scandir($p), ['.', '..'])));
        }
        return is_file($p) ? ($brut ? file_get_contents($p) : json_decode(file_get_contents($p), true)) : null;
    }
    $url = 'https://api.github.com/repos/' . $REGLAGES['depot'] . '/contents/'
        . implode('/', array_map('rawurlencode', explode('/', $chemin)))
        . '?ref=' . rawurlencode($REGLAGES['branche']);
    $entetes = [
        'User-Agent: lumenjuris-publication',
        'Accept: ' . ($brut ? 'application/vnd.github.raw' : 'application/vnd.github+json'),
        'X-GitHub-Api-Version: 2022-11-28',
    ];
    if ($REGLAGES['jeton_github'] !== '') {
        $entetes[] = 'Authorization: Bearer ' . $REGLAGES['jeton_github'];
    }
    $c = curl_init($url);
    curl_setopt_array($c, [CURLOPT_RETURNTRANSFER => true, CURLOPT_HTTPHEADER => $entetes,
        CURLOPT_TIMEOUT => 120, CURLOPT_FOLLOWLOCATION => true]);
    $corps = curl_exec($c);
    $code = curl_getinfo($c, CURLINFO_HTTP_CODE);
    $erreur = curl_error($c);
    curl_close($c);
    if ($code === 404) {
        return null;
    }
    if ($corps === false || $code !== 200) {
        throw new RuntimeException("GitHub $chemin : HTTP $code $erreur " . substr((string) $corps, 0, 200));
    }
    return $brut ? $corps : json_decode($corps, true);
}

// --- État local : ordres déjà exécutés et résultats (numéros de pages, adresses des fichiers)
$FICHIER_ETAT = "$DIR/etat-serveur.json";
$etat = is_file($FICHIER_ETAT) ? json_decode(file_get_contents($FICHIER_ETAT), true) : null;
if (!is_array($etat)) {
    $etat = ['ordres' => []];
}
function enregistrer_etat()
{
    global $etat, $FICHIER_ETAT;
    $etat['maj'] = date('c');
    file_put_contents($FICHIER_ETAT, json_encode($etat, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    // Copie publique lue par la routine cloud (aucun secret : numéros et adresses publiques).
    if (function_exists('wp_upload_dir')) {
        $dossier = wp_upload_dir()['basedir'] . '/lumenjuris-publication';
        if (!is_dir($dossier)) {
            mkdir($dossier, 0755, true);
            file_put_contents("$dossier/index.html", '');
        }
        file_put_contents("$dossier/resultats.json",
            json_encode($etat, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    }
}

// --- Ordres à exécuter
try {
    $liste = github($REGLAGES['dossier_ordres']);
} catch (Exception $e) {
    journal('ERREUR lecture GitHub : ' . $e->getMessage());
    file_put_contents("$DIR/dernier-passage.txt", date('Y-m-d H:i:s') . " ERREUR GitHub : " . $e->getMessage() . "\n");
    exit(1);
}
$a_faire = [];
foreach ((array) $liste as $f) {
    if (($f['type'] ?? '') !== 'file' || substr($f['name'], -5) !== '.json') {
        continue;
    }
    $id = substr($f['name'], 0, -5);
    $e = $etat['ordres'][$id] ?? [];
    if (($e['statut'] ?? '') === 'fait' || ($e['essais'] ?? 0) >= $REGLAGES['essais_max']) {
        continue;
    }
    $a_faire[$id] = $f['path'];
}
ksort($a_faire);  // les noms commencent par la date : ordre chronologique
file_put_contents("$DIR/dernier-passage.txt", date('Y-m-d H:i:s') . ' OK : GitHub lisible, '
    . count($a_faire) . " ordre(s) à exécuter\n");
if (!$a_faire) {
    exit;  // rien de nouveau : aucun message, aucun chargement de WordPress
}

// --- Chargement de WordPress
$wp = $REGLAGES['wordpress'];
if ($wp === '') {
    $maison = dirname($DIR);
    foreach (["$maison/public_html", "$maison/www", "$maison/" . $REGLAGES['site'],
              "$maison/" . preg_replace('/^www\./', '', $REGLAGES['site'])] as $d) {
        if (is_file("$d/wp-load.php")) {
            $wp = $d;
            break;
        }
    }
}
if ($wp === '' || !is_file("$wp/wp-load.php")) {
    journal("ERREUR : wp-load.php introuvable. Indiquez le dossier de WordPress dans reglages.php ('wordpress').");
    exit(1);
}
$_SERVER['HTTP_HOST'] = $_SERVER['SERVER_NAME'] = $REGLAGES['site'];
$_SERVER['HTTPS'] = 'on';
$_SERVER['SERVER_PORT'] = 443;
$_SERVER['REQUEST_URI'] = '/';
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
require "$wp/wp-load.php";
require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/media.php';
require_once ABSPATH . 'wp-admin/includes/image.php';

if ($REGLAGES['utilisateur_wp'] !== '') {
    $utilisateur = get_user_by('login', $REGLAGES['utilisateur_wp']);
} else {
    $admins = get_users(['role' => 'administrator', 'number' => 1, 'orderby' => 'ID', 'order' => 'ASC']);
    $utilisateur = $admins ? $admins[0] : false;
}
if (!$utilisateur || !user_can($utilisateur, 'edit_pages')) {
    journal('ERREUR : utilisateur WordPress introuvable ou sans droits (réglage utilisateur_wp).');
    exit(1);
}
wp_set_current_user($utilisateur->ID);

// --- Repères {{ordre.oN.champ}} laissés par la routine, remplacés par les vrais numéros
function resoudre($valeur)
{
    global $etat;
    if (is_array($valeur)) {
        return array_map('resoudre', $valeur);
    }
    if (!is_string($valeur) || strpos($valeur, '{{') === false) {
        return $valeur;
    }
    $trouver = function ($m) use ($etat) {
        $v = $etat['ordres'][$m[1]]['operations'][$m[2]][$m[3]] ?? null;
        if ($v === null) {
            throw new RuntimeException("repère inconnu {$m[0]} (ordre précédent non exécuté ?)");
        }
        return $v;
    };
    if (preg_match('/^\{\{([\w-]+)\.(o\d+)\.(\w+)\}\}$/', $valeur, $m)) {
        return $trouver($m);  // repère seul : garde le type (numéro = nombre)
    }
    return preg_replace_callback('/\{\{([\w-]+)\.(o\d+)\.(\w+)\}\}/', function ($m) use ($trouver) {
        return (string) $trouver($m);
    }, $valeur);
}

function requete_rest($methode, $route, $donnees = null)
{
    $requete = new WP_REST_Request($methode, strtok($route, '?'));
    $requete_q = parse_url($route, PHP_URL_QUERY);
    if ($requete_q) {
        parse_str($requete_q, $q);
        $requete->set_query_params($q);
    }
    if ($donnees !== null) {
        $requete->set_header('content-type', 'application/json');
        $requete->set_body(wp_json_encode($donnees));
    }
    return $requete;
}

function executer($requete)
{
    $reponse = rest_do_request($requete);
    if ($reponse->is_error() || $reponse->get_status() >= 400) {
        $erreur = $reponse->as_error();
        throw new RuntimeException($requete->get_method() . ' ' . $requete->get_route() . ' : HTTP '
            . $reponse->get_status() . ' ' . ($erreur ? $erreur->get_error_message() : ''));
    }
    $d = rest_get_server()->response_to_data($reponse, false);
    $garder = ['ok' => true];  // jamais vide : reste un objet JSON
    foreach (['id', 'link', 'status', 'source_url'] as $k) {
        if (isset($d[$k]) && !is_array($d[$k])) {
            $garder[$k] = $d[$k];
        }
    }
    return $garder;
}

function sauvegarder_page($id)
{
    global $DIR;
    $post = get_post($id);
    if (!$post) {
        return;
    }
    if (!is_dir("$DIR/sauvegardes")) {
        mkdir("$DIR/sauvegardes", 0700, true);
    }
    file_put_contents("$DIR/sauvegardes/" . date('Y-m-d-His') . "-{$post->post_name}-id$id.json",
        json_encode(['post' => $post->to_array(), 'meta' => get_post_meta($id)],
            JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
}

function operation($op)
{
    if ($op['type'] === 'media') {
        $contenu = github($op['fichier'], true);
        if ($contenu === null) {
            throw new RuntimeException("fichier absent sur GitHub : {$op['fichier']}");
        }
        if (!empty($op['empreinte_fichier']) && hash('sha256', $contenu) !== $op['empreinte_fichier']) {
            journal("  attention : {$op['fichier']} a changé depuis l'ordre, version actuelle envoyée");
        }
        $requete = new WP_REST_Request('POST', '/wp/v2/media');
        $requete->set_header('content-type', $op['mime']);
        $requete->set_header('content-disposition', 'attachment; filename="' . basename($op['fichier']) . '"');
        $requete->set_body($contenu);
        return executer($requete);
    }
    $route = resoudre($op['route']);
    if ($op['methode'] === 'POST' && preg_match('#^/wp/v2/pages/(\d+)$#', $route, $m)) {
        sauvegarder_page((int) $m[1]);
    }
    return executer(requete_rest($op['methode'], $route, resoudre($op['donnees'] ?? null)));
}

// --- Exécution, ordre par ordre, opération par opération (reprise possible après une erreur)
foreach ($a_faire as $id => $chemin) {
    $e = &$etat['ordres'][$id];
    $e = ($e ?? []) + ['statut' => 'en cours', 'essais' => 0, 'operations' => []];
    $e['essais']++;
    try {
        $ordre = json_decode((string) github($chemin, true), true);
        if (!is_array($ordre) || !isset($ordre['operations'])) {
            throw new RuntimeException("ordre illisible : $chemin");
        }
        journal("ordre $id : {$ordre['description']} (" . count($ordre['operations']) . ' opérations)');
        foreach ($ordre['operations'] as $op) {
            if (isset($e['operations'][$op['ref']])) {
                continue;  // déjà faite lors d'un passage précédent
            }
            try {
                $e['operations'][$op['ref']] = operation($op);
            } catch (Exception $ex) {
                if (empty($op['facultatif'])) {
                    throw $ex;
                }
                $e['operations'][$op['ref']] = ['ok' => false];
                journal('  (facultatif ignoré) ' . $ex->getMessage());
            }
            enregistrer_etat();
        }
        $e['statut'] = 'fait';
        $e['date'] = date('Y-m-d H:i:s');
        $e['message'] = '';
        journal("ordre $id : terminé");
    } catch (Exception $ex) {
        $e['statut'] = 'erreur';
        $e['message'] = $ex->getMessage();
        journal("ERREUR ordre $id (essai {$e['essais']}/{$REGLAGES['essais_max']}) : " . $ex->getMessage());
        enregistrer_etat();
        break;  // les ordres suivants peuvent dépendre de celui-ci
    }
    unset($e);
    enregistrer_etat();
}
