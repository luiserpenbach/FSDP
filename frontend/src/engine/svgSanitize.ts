/**
 * SVG scrubbing for user-defined symbols. Symbol markup is stored on the
 * server and painted with dangerouslySetInnerHTML (library panel, canvas,
 * symbol editor), so everything but plain drawing elements is removed:
 * scripts, embeds, links, styles, animation (SMIL can set event attributes),
 * HTML elements, comments and CDATA (which re-parse as markup inside
 * <title>/<desc> once the serialised SVG goes through the HTML parser), event
 * attributes, and external or script URLs.
 *
 * The rules mirror the server's allowlist (`clean_symbol_svg` in
 * backend/app/schemas.py) so sanitized output is always accepted on upload:
 * editor metadata such as Inkscape's `sodipodi:*` / `inkscape:*` elements and
 * attributes, `<metadata>`, attributes outside the SVG/xlink/xml namespaces,
 * and style properties that are not presentation properties are dropped.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const XML_NS = "http://www.w3.org/XML/1998/namespace";

/** Drawing elements a symbol may contain (lower-cased local names); a subset of the server's list. */
const ALLOWED_ELEMENTS = new Set([
  "g",
  "path",
  "line",
  "polyline",
  "polygon",
  "rect",
  "circle",
  "ellipse",
  "text",
  "tspan",
  "defs",
  "marker",
  "clippath",
  "lineargradient",
  "radialgradient",
  "stop"
]);

/** Presentation properties, allowed both as attributes and inside style="" (server: _SVG_PRESENTATION_PROPERTIES). */
const PRESENTATION_PROPERTIES = new Set([
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity",
  "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray",
  "stroke-dashoffset", "opacity", "color", "display", "visibility", "vector-effect",
  "clip-path", "clip-rule", "marker-start", "marker-mid", "marker-end", "stop-color",
  "stop-opacity", "font-family", "font-size", "font-weight", "font-style",
  "font-variant", "text-anchor", "dominant-baseline", "alignment-baseline",
  "baseline-shift", "letter-spacing", "word-spacing", "text-decoration",
  "paint-order", "shape-rendering", "text-rendering", "writing-mode"
]);

/** Attributes without a namespace (lower-cased), server: _SVG_ALLOWED_ATTRIBUTES. */
const ALLOWED_ATTRIBUTES = new Set([
  ...PRESENTATION_PROPERTIES,
  "id", "class", "style", "transform", "d", "x", "y", "x1", "y1", "x2",
  "y2", "cx", "cy", "r", "rx", "ry", "fx", "fy", "fr", "width", "height", "points",
  "pathlength", "dx", "dy", "rotate", "textlength", "lengthadjust", "viewbox",
  "preserveaspectratio", "refx", "refy", "markerwidth", "markerheight", "markerunits",
  "orient", "gradientunits", "gradienttransform", "spreadmethod", "offset",
  "clippathunits", "href"
]);

/** Tokens the server refuses anywhere in an attribute value once whitespace is removed. */
const UNSAFE_VALUE_TOKENS = ["javascript:", "vbscript:", "data:", "expression(", "\\", "/*", "<", "@"];
const URL_REFERENCE = /url\(['"]?([^)'"]*)/g;
const FRAGMENT_REF = /^#[\w.:-]+$/;

/** Whether an attribute value passes the server's value checks (no script URLs, only #fragment url()s). */
function safeValue(value: string): boolean {
  // Drop whitespace and control characters (the server drops whitespace; control characters can hide "javascript:").
  const compact = [...value.toLowerCase()].filter((char) => char.charCodeAt(0) > 0x20 && !/\s/.test(char)).join("");
  if (UNSAFE_VALUE_TOKENS.some((token) => compact.includes(token))) return false;
  for (const match of compact.matchAll(URL_REFERENCE)) {
    if (!FRAGMENT_REF.test(match[1])) return false;
  }
  return true;
}

/** Keep only presentation-property declarations of a style attribute; "" when none survive. */
function filterStyle(value: string): string {
  return value
    .split(";")
    .map((declaration) => declaration.trim())
    .filter((declaration) => {
      if (!declaration) return false;
      const property = declaration.split(":", 1)[0].trim().toLowerCase();
      return PRESENTATION_PROPERTIES.has(property) && declaration.includes(":");
    })
    .join(";");
}

function allowedElement(element: Element, rootNamespace: string | null): boolean {
  const namespace = element.namespaceURI;
  return (namespace === SVG_NS || namespace === rootNamespace) && ALLOWED_ELEMENTS.has(element.localName.toLowerCase());
}

function scrubAttributes(element: Element): void {
  for (const attribute of [...element.attributes]) {
    const name = attribute.localName.toLowerCase();
    const namespace = attribute.namespaceURI;
    if (namespace === XLINK_NS && name === "href") {
      // Serialised as plain href: the xlink prefix would need a namespace declaration the server may not see.
      element.removeAttributeNode(attribute);
      if (!element.hasAttribute("href") && FRAGMENT_REF.test(attribute.value.trim())) element.setAttribute("href", attribute.value.trim());
      continue;
    }
    if (namespace === XML_NS && name === "space") {
      if (!safeValue(attribute.value)) element.removeAttributeNode(attribute);
      continue;
    }
    // Editor metadata (sodipodi:, inkscape:, rdf:...), namespace declarations, and prefixed names.
    if (namespace !== null || attribute.prefix || !ALLOWED_ATTRIBUTES.has(name)) {
      element.removeAttributeNode(attribute);
      continue;
    }
    if (name === "href") {
      if (!FRAGMENT_REF.test(attribute.value.trim())) element.removeAttributeNode(attribute);
      continue;
    }
    if (name === "style") {
      const style = filterStyle(attribute.value);
      if (!style || !safeValue(style)) element.removeAttributeNode(attribute);
      else if (style !== attribute.value) attribute.value = style;
      continue;
    }
    if (!safeValue(attribute.value)) element.removeAttributeNode(attribute);
  }
}

/** Drop comments and processing instructions; turn CDATA into plain text. */
function scrubNodes(parent: Node): void {
  for (const node of [...parent.childNodes]) {
    if (node.nodeType === Node.COMMENT_NODE || node.nodeType === Node.PROCESSING_INSTRUCTION_NODE) {
      parent.removeChild(node);
    } else if (node.nodeType === Node.CDATA_SECTION_NODE) {
      const text = node.ownerDocument?.createTextNode(node.textContent ?? "");
      if (text) parent.replaceChild(text, node);
      else parent.removeChild(node);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      scrubNodes(node);
    }
  }
}

/** Re-create a prefixed SVG element (e.g. <svg:path>) unprefixed so it serialises as a plain name. */
function unprefix(element: Element): Element {
  if (!element.prefix || element.namespaceURI !== SVG_NS) return element;
  const replacement = element.ownerDocument.createElementNS(SVG_NS, element.localName);
  for (const attribute of [...element.attributes]) replacement.setAttributeNodeNS(attribute.cloneNode() as Attr);
  while (element.firstChild) replacement.appendChild(element.firstChild);
  element.replaceWith(replacement);
  return replacement;
}

/** Strip active, embeddable, and editor-only content from an SVG root element in place (the root itself is kept). */
export function scrubSvgElement(root: Element): void {
  const rootNamespace = root.namespaceURI;
  for (const element of [...root.querySelectorAll("*")]) {
    if (!allowedElement(element, rootNamespace)) element.remove();
  }
  scrubAttributes(root);
  for (const element of [...root.querySelectorAll("*")]) scrubAttributes(unprefix(element));
  scrubNodes(root);
}

/**
 * Sanitize SVG inner markup before rendering or upload. Returns "" for markup
 * that does not parse, or when no DOM parser is available (fails closed).
 */
export function sanitizeSvgInner(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || typeof DOMParser === "undefined") return "";
  const doc = new DOMParser().parseFromString(`<svg xmlns="${SVG_NS}">${trimmed}</svg>`, "image/svg+xml");
  if (doc.querySelector("parsererror")) return "";
  const svg = doc.documentElement;
  if (!svg || svg.localName !== "svg") return "";
  scrubSvgElement(svg);
  return svg.innerHTML.trim();
}
