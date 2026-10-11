const BLOCK_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "tr",
  "blockquote",
  "pre",
  "div",
  "table",
  "ul",
  "ol",
]);

/**
 * Texte d'un HTML de document : un paragraphe par bloc, séparés par une ligne
 * vide ; une ligne de tableau donne « case | case ».
 *
 * innerText ne convient pas : sur un document créé par DOMParser (jamais
 * affiché), il renvoie le texte brut et colle les paragraphes
 * (« …résiliation.ARTICLE 5 »), ce qui gênait l'analyse IA.
 */
export function htmlToPlainText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  let out = "";

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += (node.textContent ?? "").replace(/\s+/g, " ");
      return;
    }
    if (!(node instanceof Element)) return;
    const tag = node.tagName.toLowerCase();
    if (tag === "br") {
      out += "\n";
      return;
    }
    node.childNodes.forEach(walk);
    if (tag === "td" || tag === "th") out += " | ";
    else if (BLOCK_TAGS.has(tag)) out += "\n\n";
  };
  walk(doc.body);

  return out
    .split(/\n{2,}/)
    .map((paragraph) =>
      paragraph
        .split("\n")
        .map((line) => line.replace(/[ \t]+/g, " ").trim())
        .join("\n")
        .replace(/\s*\|\s*$/, "")
        .trim(),
    )
    .filter(Boolean)
    .join("\n\n");
}
